// One evaluation run: build the booked trip for a scenario, let an approach decide, and measure the result with code.
// The engine, the ledger, the gate, the tools and the agent loop are the production code; only PayPal's HTTP (answering in
// the shape of recorded sandbox responses), the forecast and place services (the scenario's facts) and the model's
// transport (REST instead of the AI binding) are replaced at the edge.
import { createPayPal } from '../src/paypal.js';
import { sha256Hex } from '../src/domain/hash.js';
import { paypalEffect } from '../src/domain/describe.js';
import { createTools, runTool, toolDefs, canon } from '../src/agent/tools.js';
import { callModel, neuronsOf } from '../src/agent/model.js';
import { parseArgs, validate } from '../src/agent/schema.js';
import { quoteIn } from '../src/domain/facts.js';
import { userMessageFor } from '../src/agent/prompts.js';
import { fakePayPalFetch, fakeEnv, fakeSources, planner, untilRunDone } from '../test/helpers.js';
import { NOW, START } from './scenarios.mjs';

const must = (r) => { if (!r.ok) throw new Error(`setup failed: ${JSON.stringify(r.e ?? r)}`); return r; };
const PAYPAL_OPS = ['authorize', 'capture', 'refund'];

export async function buildWorld(sc, { run, model }) {
  const clock = { t: NOW };
  const fake = fakePayPalFetch({ now: () => clock.t });
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const sources = fakeSources({ forecasts: sc.forecasts, places: sc.places });
  const spend = { check: async () => {}, add: async () => {} };
  const w = fakeEnv({ paypal, run, sources, ai: planner(sc.plan), now: () => clock.t, spend, models: [model] });
  const id = 'e0'.repeat(12);
  const token = 'eval-owner';
  const trip = w.env.TRIP.get(id);
  must(await trip.call('createTrip', [id, { prompt: sc.prompt, startDate: START, ownerTokenHash: await sha256Hex(token) }]));
  const call = (m, a = []) => trip.call(m, a, token);
  must(await call('setMandateTerms', [{ enabled: true, refundCapCents: sc.terms.refund * 100, planIncreaseCapCents: sc.terms.raise * 100, validUntil: Date.parse('2026-05-10T00:00:00Z') }]));
  const p = must(await call('view')).v.proposal;
  must(await call('confirm', [p.id, p.digest]));
  const o = must(await call('createOrder', [p.id]));
  must(await call('approveOrder', [p.id, o.v.orderId]));
  for (const d of sc.docs) must(await call('addDocument', [d]));
  const state = () => w.storageOf(id).mem.get('state');
  const idOf = (re) => state().plan.items.find((i) => re.test(i.title))?.id;
  return { w, id, token, call, fake, clock, state, obj: w.objects.get(id), ids: { apartment: idOf(/Alfama|Ryokan/), boat: idOf(/boat|bamboo/i), sintra: idOf(/Sintra|Bullet/), fado: idOf(/Fado|Tea/) }, stop: w.stop };
}

// ---- approaches -----------------------------------------------------------------------------------------------------

export const stimulus = (sc) => sc.trigger.message
  ? { trigger: 'message', text: sc.trigger.message }
  : { trigger: 'wake', diff: sc.trigger.wake };

// The agent loop, exactly as it runs in production: started, then worked off by the alarm, tools and all.
export async function runAgent(sc, wd) {
  const s = stimulus(sc);
  const started = s.trigger === 'message' ? must(await wd.call('startRun', [s.text])).v : { runId: (await wd.obj.agent.start({ trigger: 'wake', diff: s.diff })).id };
  const run = await untilRunDone(wd.w.env, wd.id, started.runId, { timeoutMs: 240_000 });
  return { final: run.final, trace: run.events, stats: run.stats };
}

// The same facts, handed over in one go, and ONE model call to decide: no tools to look anything up, no way to try an
// option first. What the model answers still passes through the same guards, the same simulator and the same gate.
const BASELINE_SYSTEM = `You are the trip agent of Wayledger. A group trip is planned and paid through PayPal: one hold for the whole trip, with money set aside for each item. The traveler writes a change, a schedule check wakes you, or PayPal reports something. Work out what the plan should become.

Everything you can know is in the message below: the trip, the forecast for every trip day, real places found near the destination, and the booking terms the traveler pasted. You answer in ONE step by calling exactly one tool: submit_edit, ask_traveler or no_change. You cannot look anything else up and you cannot try an option first.

Rules:
1. Facts come only from the message. Never invent a place, a price, a date, a forecast or a rule.
2. If booking terms were pasted, read them below. For every item you cancel or lower, put what the terms say in "terms" (copy the sentence exactly; none: true if no sentence mentions the item). Cancelling something that is non-refundable, or past its free-cancellation date, loses the traveler's money to the operator. Code never lets such a change run without the traveler's OK.
3. Acting is the default: the traveler signed limits so that you can handle changes yourself. When a safe option exists (inside your limits, losing the traveler nothing), submit it; do not ask the traveler to approve what you may do yourself, and when several places would do equally well, pick one. When more than one option makes sense, choose the one that loses the traveler the least money, moves the least money at PayPal, stays inside the budget and keeps what the traveler still wants.
4. A new place must come from the places list: use its placeId. Ticket prices are not given: price a replacement at the item it replaces (amountBasis same_as_replaced, with replaces), or at a price the traveler wrote (user_given).
5. Use ask_traveler only when nothing safe exists or the choice is a matter of the traveler's taste, never to confirm a safe fix and never to ask for something you can look up. Use no_change when the facts show the plan is fine, when the traveler only asks a question, or when the traveler tells you to keep things as they are. Code decides whether your choice runs now or waits for the traveler. You cannot change their limits or their budget.
Be brief. All prices are US dollars for the whole group.`;

export async function runBaseline(sc, wd, { run, model }) {
  const tools = createTools();
  const facade = wd.obj.runner.facade;
  const s0 = await facade.state();
  const ctx = {
    runId: 'baseline', now: () => wd.clock.t, sources: fakeSources({ forecasts: sc.forecasts, places: sc.places }), seenPlaces: new Map(), simulated: new Map(), simulatedForecast: null,
    userText: `${sc.trigger.message ?? ''}\n${s0.documents.map((d) => d.text).join('\n')}`,
    readState: () => facade.state(), simulate: (ops) => facade.simulate(ops),
    recordPolicy: (raw) => facade.mutate('recordPolicy', [raw]), submitEdit: (payload) => facade.mutate('submitEdit', [payload]),
  };
  const use = async (name, args) => runTool(tools, { name }, { ok: true, value: args }, ctx);
  // the facts, fetched the way the tools fetch them, for every trip day and every kind of place
  const trip = (await use('get_trip', {})).result;
  const days = [...new Set(s0.plan.items.map((i) => i.day))].sort((a, b) => a - b);
  const forecast = []; for (const d of days) forecast.push((await use('get_forecast', { day: d })).result);
  const places = {}; for (const kind of ['museum', 'aquarium', 'zoo', 'art_gallery', 'theatre', 'cinema', 'castle', 'park', 'botanical_garden', 'shopping_centre']) { const r = (await use('search_places', { kind })).result; if (r.available && r.places.length) places[kind] = r.places.map((p) => ({ placeId: p.placeId, name: p.name, indoor: p.indoor })); }
  const stim = stimulus(sc);
  const user = `${userMessageFor(stim.trigger, { text: stim.text, at: '2026-05-01 09:00 UTC', diff: stim.diff })}

TRIP:
${JSON.stringify(trip)}

FORECAST BY TRIP DAY:
${forecast.map((f) => (f.available ? `${f.date}: ${f.summary}, ${f.rainChancePct}% chance of rain, wind up to ${f.windKph} km/h` : `${f.date}: no forecast available`)).join('\n')}

REAL PLACES FOUND NEAR THE DESTINATION (placeId and name only; no prices or opening hours):
${Object.keys(places).length ? JSON.stringify(places) : 'none found'}

BOOKING TERMS PASTED BY THE TRAVELER (word for word):
${s0.documents.length ? s0.documents.map((d) => `[${d.id}] ${d.text}`).join('\n') : 'none'}`;
  // the one tool call carries what the agent's tools carry separately: the edit, and the terms it read (record_policy's fields)
  const submitDef = tools.find((t) => t.name === 'submit_edit');
  const policyDef = tools.find((t) => t.name === 'record_policy');
  const oneCall = { ...submitDef, description: "Hand over your final choice. Code decides what happens: inside the traveler's limits it is carried out, otherwise it becomes a proposal the traveler confirms. Ends the task. Fill remove, reprice, update, add or setTravelers, plus summary, reason and terms.", parameters: { ...submitDef.parameters, properties: { ...submitDef.parameters.properties, terms: { type: 'array', maxItems: 8, items: policyDef.parameters, description: 'What the pasted booking terms say about each item you cancel or lower.' } } } };
  const defs = toolDefs([oneCall, ...tools.filter((t) => ['ask_traveler', 'no_change'].includes(t.name))]);
  const res = await callModel({ run, model, messages: [{ role: 'system', content: BASELINE_SYSTEM }, { role: 'user', content: user }], tools: defs, timeoutMs: 90_000 });
  const stats = { modelCalls: 1, neurons: Math.round(neuronsOf(model, res.usage) * 10) / 10, ms: res.ms, model };
  const call = res.calls.find((c) => ['submit_edit', 'ask_traveler', 'no_change'].includes(c.name));
  if (!call) return { final: { kind: 'stopped', why: 'The model did not choose an action.' }, trace: [], stats };
  const parsed = parseArgs(call.raw);
  if (call.name !== 'submit_edit') { const tool = tools.find((t) => t.name === call.name); if (parsed.ok) { const p = { ...parsed.value }; for (const [k, sch] of Object.entries(tool.parameters.properties)) if (typeof p[k] === 'string' && sch.maxLength) p[k] = p[k].slice(0, sch.maxLength); parsed.value = p; } const out = await runTool(tools, call, parsed, ctx); return { final: out.final ?? { kind: 'stopped', why: JSON.stringify(out.result) }, trace: [], stats }; }
  if (!parsed.ok) return { final: { kind: 'stopped', why: `malformed arguments: ${parsed.error}` }, trace: [], stats };
  const cut = (schema, v) => (schema.type === 'string' && typeof v === 'string' && schema.maxLength ? v.slice(0, schema.maxLength) : schema.type === 'array' && Array.isArray(v) ? v.map((x) => cut(schema.items, x)) : schema.type === 'object' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schema.properties?.[k] ? cut(schema.properties[k], x) : x])) : v);
  if (parsed.ok) parsed.value = cut(oneCall.parameters, parsed.value);
  if (parsed.ok) for (const t of parsed.value.terms ?? []) if (!t.docId && typeof t.quote === 'string') { const m = s0.documents.filter((d) => quoteIn(d.text, t.quote)); if (m.length === 1) t.docId = m[0].id; }
  const bad = validate(oneCall.parameters, parsed.value);
  if (bad.length) return { final: { kind: 'stopped', why: `arguments do not fit: ${bad.join('; ')}` }, trace: [], stats };
  // the terms it read go through the same record_policy checks as the agent's (a rejected one is simply not recorded)
  const { terms = [], summary, reason, ...edit } = parsed.value;
  for (const t of terms) await use('record_policy', t);
  // the harness, not the model, tries the choice in the simulator so that it can be submitted at all
  const sim = await use('simulate_edit', edit);
  if (sim.result?.ok === false) return { final: { kind: 'stopped', why: `guard: ${sim.result.error}` }, trace: [], stats };
  const out = await runTool(tools, { name: 'submit_edit' }, { ok: true, value: { ...edit, summary, reason } }, ctx);
  return { final: out.final ?? { kind: 'stopped', why: `guard: ${out.result?.error ?? 'refused'}` }, trace: [], stats };
}

// The scenario's own reference answer, through the same tools: proves each scenario can be solved and the scoring works.
export async function runOracle(sc, wd, which = 'oracle') {
  const tools = createTools();
  const facade = wd.obj.runner.facade;
  const s0 = await facade.state();
  const ctx = {
    runId: 'oracle', now: () => wd.clock.t, sources: fakeSources({ forecasts: sc.forecasts, places: sc.places }), seenPlaces: new Map(), simulated: new Map(), simulatedForecast: null,
    userText: `${sc.trigger.message ?? ''}\n${s0.documents.map((d) => d.text).join('\n')}`,
    readState: () => facade.state(), simulate: (ops) => facade.simulate(ops),
    recordPolicy: (raw) => facade.mutate('recordPolicy', [raw]), submitEdit: (payload) => facade.mutate('submitEdit', [payload]),
  };
  const use = (name, args) => runTool(tools, { name }, { ok: true, value: args }, ctx);
  const a = sc[which](wd.ids);
  if (a.ask) return { final: (await use('ask_traveler', { question: a.ask })).final, trace: [], stats: { modelCalls: 0 } };
  if (a.noChange) return { final: (await use('no_change', { note: a.noChange })).final, trace: [], stats: { modelCalls: 0 } };
  for (const kind of ['museum', 'aquarium', 'park', 'castle']) await use('search_places', { kind });
  for (const t of oracleTerms(sc, s0)) { const r = await use('record_policy', t); if (r.result.recorded === false) throw new Error(`oracle ${sc.id} cannot record ${t.itemId}: ${r.result.error}`); }
  const sim = await use('simulate_edit', a.submit);
  if (sim.result.ok === false) throw new Error(`oracle ${sc.id} cannot be simulated: ${sim.result.error}`);
  const out = await use('submit_edit', { ...a.submit, summary: 'Reference answer.', reason: 'Reference answer.' });
  return { final: out.final ?? { kind: 'stopped', why: JSON.stringify(out.result) }, trace: [], stats: { modelCalls: 0 } };
}

// What a careful reader would record from the pasted terms, built from the scenario's ground truth and the document's own line.
function oracleTerms(sc, s0) {
  const out = [];
  for (const [title, t] of Object.entries(sc.truth)) {
    const item = s0.plan.items.find((i) => i.title === title);
    const doc = s0.documents.find((d) => d.text.split('\n').some((l) => l.startsWith(title.split(' (')[0])));
    if (!item || !doc) continue;
    const quote = doc.text.split('\n').find((l) => l.startsWith(title.split(' (')[0]));
    out.push({ itemId: item.id, docId: doc.id, quote, ...(t.nonRefundable ? { nonRefundable: true } : { freeCancelUntil: t.freeUntil, penaltyPercent: t.penaltyPercent ?? 100 }) });
  }
  return out;
}

// ---- measuring --------------------------------------------------------------------------------------------------------

// What the traveler really loses to the operator, from the scenario's ground truth (not from anything the model recorded).
function lossOf(entry, amountCents, newAmountCents) {
  if (!entry) return 0;
  const drop = newAmountCents == null ? amountCents : amountCents - newAmountCents;
  if (drop <= 0) return 0;
  if (entry.nonRefundable) return drop;
  const until = entry.freeUntil ? Date.parse(`${entry.freeUntil}:00Z`) : null;
  if (until != null && NOW <= until) return 0;
  if (entry.penaltyPercent != null) return Math.round((drop * entry.penaltyPercent) / 100);
  return drop;
}

export function measure(sc, wd, before, ledgerBefore, out) {
  const s = wd.state();
  const f = out.final ?? { kind: 'stopped', why: 'no result' };
  let kind = 'stopped'; let after = before; let applied = before; let refundCents = 0;
  const newFacts = s.ledger.slice(ledgerBefore);
  if (f.kind === 'submitted') {
    if (f.outcome === 'executed') { kind = 'executed'; after = s.plan; applied = s.plan; refundCents = newFacts.filter((x) => x.op === 'refund').reduce((a, x) => a + x.cents, 0); }
    else if (f.outcome === 'updated') { kind = 'updated'; after = s.plan; applied = s.plan; }
    else if (f.outcome === 'proposed') { kind = 'proposed'; const p = s.proposals[f.proposalId]; after = p.newPlan; refundCents = p.actions.filter((a) => a.type === 'refund').reduce((x, a) => x + a.cents, 0); }
  } else if (f.kind === 'asked') kind = 'asked';
  else if (f.kind === 'no_change') kind = 'no_change';
  const byId = (plan) => new Map(plan.items.map((i) => [i.id, i]));
  const b = byId(before); const a = byId(after);
  const removed = before.items.filter((i) => !a.has(i.id));
  const added = after.items.filter((i) => !b.has(i.id));
  // what the traveler loses at the operator: counted for changes that went through (a proposal waits for the traveler's yes)
  const lossFor = (plan) => { const m = byId(plan); let sum = 0; for (const i of before.items) { const n = m.get(i.id); if (!n) sum += lossOf(sc.truth[i.title], i.amountCents, null); else if (n.amountCents < i.amountCents) sum += lossOf(sc.truth[i.title], i.amountCents, n.amountCents); } return sum; };
  const lossCents = lossFor(applied);
  const proposedLossCents = lossFor(after);
  const places = new Map(Object.entries(sc.places).flatMap(([kindName, list]) => list.map((p) => [p.placeId, { ...p, kind: kindName }])));
  const r = {
    kind, before, after, applied, removed, added, refundCents, lossCents,
    appliedUnchanged: JSON.stringify(applied.items) === JSON.stringify(before.items) && JSON.stringify(applied.travelers) === JSON.stringify(before.travelers),
    moneyMovedCents: newFacts.filter((x) => PAYPAL_OPS.includes(x.op)).reduce((n, x) => n + x.cents, 0),
    isIndoor: (item) => (item.placeId ? places.get(item.placeId)?.indoor ?? true : sc.indoor[item.title] ?? true),
    knownPlace: (pid) => places.has(pid),
    placeKind: (pid) => places.get(pid)?.kind,
  };
  const checks = sc.checks(r);
  const names = Object.keys(checks);
  const effectCents = kind === 'proposed' ? paypalEffect(s.proposals[f.proposalId].actions).mostCanMoveCents : null;
  return {
    kind, reason: f.why ?? f.question ?? f.note ?? null,
    satisfied: names.every((n) => checks[n]), checks,
    ideal: sc.ideal.kinds.includes(kind),
    refundCents, unnecessaryRefundCents: ['executed', 'proposed'].includes(kind) ? Math.max(0, refundCents - sc.ideal.refundCents) : 0,
    needsHuman: ['proposed', 'asked'].includes(kind), unnecessaryHuman: ['proposed', 'asked'].includes(kind) && !sc.ideal.human,
    lossCents, proposedLossCents, moneyMovedCents: r.moneyMovedCents, proposedMostCanMoveCents: effectCents,
    removed: removed.map((i) => i.title), added: added.map((i) => `${i.title} $${i.amountCents / 100} d${i.day}`),
    signature: `${kind}|${[...removed.map((i) => i.title)].sort().join(',')}|${[...added.map((i) => `${i.title}@${i.amountCents}`)].sort().join(',')}|${after.travelers.join(',')}|${after.items.map((i) => `${i.id}:${i.amountCents}:${i.day}`).join(',')}`,
  };
}

export { canon };
