import { CATEGORIES, dayDate, tripEndDate } from '../domain/plan.js';
import { itemState, reserves } from '../domain/ledger.js';
import { describeEdit, describeEffect, paypalEffect } from '../domain/describe.js';
import { textHasName, numbersIn } from '../domain/facts.js';
import { validate } from './schema.js';

// The agent's hands and eyes. Perception tools report facts and where they came from. simulate_edit reports the
// consequences of a candidate edit. submit_edit hands the choice to code, which decides what happens to the money.
// Every tool returns a `result` for the model and an `event` for the person's screen; the event text is written here
// from the structured result, never taken from what the model said.
const usd = (c) => (c == null ? null : Math.round(c) / 100);
const money = (c) => `$${(Math.abs(c) / 100).toFixed(2)}`;
const PLACE_KINDS = ['museum', 'aquarium', 'zoo', 'art_gallery', 'theatre', 'cinema', 'castle', 'park', 'botanical_garden', 'shopping_centre'];
const BASES = ['same_as_replaced', 'user_given', 'free'];

const ITEM = {
  type: 'object',
  properties: {
    day: { type: 'integer' },
    placeId: { type: 'string', description: 'The placeId of a place returned by search_places in this run. Its real name is filled in by the host.' },
    title: { type: 'string', description: 'Only for something the traveler named themselves in their own words (not a place search result).', maxLength: 80 },
    category: { type: 'string', enum: CATEGORIES },
    amount: { type: 'number', description: 'Total price in USD for the whole group.' },
    amountBasis: { type: 'string', enum: BASES, description: 'Where the amount comes from. same_as_replaced: the price of an item this same edit removes (ticket prices are not looked up). user_given: a price the traveler wrote. free: 0.' },
    participants: { type: 'array', items: { type: 'string' } },
    prepaid: { type: 'boolean' },
  },
  required: ['day', 'category', 'amount', 'amountBasis'],
};

const OPERATION = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['remove', 'reprice', 'update_item', 'add', 'set_travelers'] },
    itemId: { type: 'string' },
    amount: { type: 'number' },
    day: { type: 'integer' },
    title: { type: 'string', maxLength: 80 },
    category: { type: 'string', enum: CATEGORIES },
    participants: { type: 'array', items: { type: 'string' } },
    prepaid: { type: 'boolean' },
    item: ITEM,
    travelers: { type: 'array', items: { type: 'string' } },
  },
  required: ['op'],
};
const OPERATIONS = { type: 'array', items: OPERATION, maxItems: 8 };

export const canon = (ops) => JSON.stringify((ops ?? []).map((o) => JSON.parse(JSON.stringify(o))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

// Facts the model may not invent are checked here, before an edit is even simulated.
function groundOps(ops, ctx, s) {
  const text = ctx.userText;
  const removedAmounts = ops.filter((o) => o.op === 'remove').map((o) => s.plan.items.find((i) => i.id === o.itemId)?.amountCents).filter((c) => c != null);
  const out = [];
  for (const op of ops) {
    if (['remove', 'reprice', 'update_item'].includes(op.op) && !s.plan.items.some((i) => i.id === op.itemId)) {
      throw new Error(`There is no item ${op.itemId}. Use an id from get_trip.`);
    }
    if (op.op === 'add') {
      const it = { ...op.item };
      if (it.placeId) {
        const place = ctx.seenPlaces.get(it.placeId);
        if (!place) throw new Error(`placeId ${it.placeId} did not come from search_places in this run. Search first and use a placeId from the results.`);
        it.title = place.name;
      } else if (!it.title || !textHasName(text, it.title)) {
        throw new Error('A new place must come from search_places (use its placeId), or be a name the traveler wrote themselves. Names are not made up.');
      }
      const cents = Math.round(it.amount * 100);
      if (it.amountBasis === 'free' && cents !== 0) throw new Error('amountBasis free needs amount 0.');
      if (it.amountBasis === 'same_as_replaced' && !removedAmounts.includes(cents)) throw new Error('amountBasis same_as_replaced needs the amount of an item this same edit removes. Ticket prices are not looked up, so do not guess one.');
      if (it.amountBasis === 'user_given' && !numbersIn(text).some((n) => Math.abs(n - it.amount) < 0.005)) throw new Error('amountBasis user_given needs a price the traveler actually wrote.');
      out.push({ ...op, item: it });
    } else if (op.op === 'set_travelers') {
      const known = new Set(s.plan.travelers);
      const fresh = op.travelers.filter((t) => !known.has(t));
      if (fresh.some((t) => !textHasName(text, t))) throw new Error('A new traveler must be someone the traveler named. Names are not made up.');
      out.push(op);
    } else {
      out.push(op);
    }
  }
  return out;
}

function optionText(sim, ops, s) {
  const lines = describeEdit(s.plan, sim.newPlan);
  return lines.length ? lines.join('; ') : `${ops.length} change(s)`;
}

export function createTools() {
  const tools = [];
  const add = (t) => tools.push(t);

  add({
    name: 'get_trip',
    description: 'The trip as it stands: items with prices and money status, travelers, budget, dates, and the limits you may act within.',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async (_a, ctx) => {
      const s = await ctx.readState();
      const m = s.mandate;
      const live = m?.terms.enabled && ctx.now() < m.terms.validUntil;
      const total = s.plan.items.reduce((a, i) => a + i.amountCents, 0);
      const result = {
        today: new Date(ctx.now()).toISOString().slice(0, 10),
        trip: { title: s.plan.title, destination: s.plan.destination, startDate: s.plan.startDate, endDate: tripEndDate(s.plan), travelers: s.plan.travelers, budgetUsd: usd(s.plan.budgetCents), budgetConfirmedByTraveler: Boolean(s.plan.budgetSource) },
        items: s.plan.items.map((i) => { const st = itemState(s.ledger, i.id); return { id: i.id, day: i.day, date: dayDate(s.plan.startDate, i.day), title: i.title, category: i.category, priceUsd: usd(i.amountCents), paidInAdvance: i.prepaid, heldUsd: usd(st.heldCents), chargedUsd: usd(st.paidCents), sharedBy: i.participants }; }),
        planTotalUsd: usd(total),
        limits: live ? { refundLeftUsd: usd(Math.max(0, m.terms.refundCapCents - m.used.refundCents)), planIncreaseLeftUsd: usd(m.terms.planIncreaseCapCents - Math.max(0, total - m.baselineTotalCents)), validUntil: new Date(m.terms.validUntil).toISOString().slice(0, 10) } : null,
        termsRecorded: s.policies.map((p) => ({ itemId: p.itemId, item: p.itemTitle, quote: p.quote })),
        documents: s.documents.length,
      };
      const lim = result.limits ? `you may refund up to $${result.limits.refundLeftUsd.toFixed(2)} and raise the plan by up to $${result.limits.planIncreaseLeftUsd.toFixed(2)}` : 'no limits are signed, so every change waits for the traveler';
      return { result, event: { title: 'Looked at your trip', detail: `${s.plan.items.length} items, plan total ${money(total)}; ${lim}.` } };
    },
  });

  add({
    name: 'get_forecast',
    description: 'The weather forecast for one trip day, from a real forecast service. It may say the forecast is not available yet.',
    parameters: { type: 'object', properties: { day: { type: 'integer', description: 'Trip day number, starting at 1.' } }, required: ['day'] },
    run: async (a, ctx) => {
      const s = await ctx.readState();
      const date = dayDate(s.plan.startDate, a.day);
      if (!date) return { result: { available: false, reason: 'The trip has no start date, so there is no forecast to look up.' }, event: { title: 'Tried to check the forecast', detail: 'The trip has no start date.' } };
      const fake = ctx.simulatedForecast?.[date];
      const f = fake ? { available: true, date, ...fake, simulated: true, source: 'Demo button (simulated, not a real forecast)' } : await ctx.sources.forecast({ destination: s.plan.destination, date });
      const detail = f.available
        ? `${s.plan.destination}, day ${a.day} (${date}): ${f.summary}, ${f.rainChancePct}% chance of rain, wind up to ${f.windKph} km/h.`
        : `Day ${a.day} (${date}): ${f.reason}`;
      return { result: f, event: { title: f.simulated ? 'Checked the forecast (SIMULATED by the demo button)' : 'Checked the forecast', detail, source: f.source, simulated: Boolean(f.simulated) } };
    },
  });

  add({
    name: 'search_places',
    description: 'Real places of one kind near the trip destination, with their real names. Prices and opening hours are not included. Only places returned here may be added to the plan.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: PLACE_KINDS } }, required: ['kind'] },
    run: async (a, ctx) => {
      const s = await ctx.readState();
      const r = await ctx.sources.places({ destination: s.plan.destination, kind: a.kind });
      for (const p of r.places ?? []) ctx.seenPlaces.set(p.placeId, p);
      const detail = r.available ? `Found ${r.places.length} ${a.kind.replace('_', ' ')} places near ${s.plan.destination}: ${r.places.slice(0, 5).map((p) => p.name).join(', ')}${r.places.length > 5 ? ', ...' : ''}.` : r.reason;
      return { result: r, event: { title: `Searched for ${a.kind.replace('_', ' ')} places`, detail, source: r.source } };
    },
  });

  add({
    name: 'get_payment_status',
    description: 'What PayPal itself says about this trip: the hold and how long it is valid, what has been charged and refunded, and open disputes.',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async (_a, ctx) => {
      const s = await ctx.readState();
      const r = await ctx.sources.paypalStatus(s);
      const holds = r.holds ?? [];
      const detail = r.available === false ? r.reason : `${holds.length} hold(s): ${holds.map((h) => `${h.status}, ${money(Math.round(h.amountUsd * 100))}${h.validUntil ? `, valid until ${h.validUntil}` : ''}`).join('; ')}. Charged ${money(Math.round((r.chargedUsd ?? 0) * 100))}, refunded ${money(Math.round((r.refundedUsd ?? 0) * 100))}, ${r.openDisputes ?? 0} open dispute(s).`;
      return { result: r, event: { title: 'Asked PayPal for the facts', detail, source: r.source } };
    },
  });

  add({
    name: 'read_documents',
    description: 'The booking terms or confirmations the traveler pasted, word for word.',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async (_a, ctx) => {
      const s = await ctx.readState();
      return { result: { documents: s.documents.map((d) => ({ docId: d.id, text: d.text })) }, event: { title: 'Read your booking terms', detail: s.documents.length ? `${s.documents.length} document(s), ${s.documents.reduce((n, d) => n + d.text.length, 0)} characters.` : 'There are no documents.' } };
    },
  });

  add({
    name: 'record_policy',
    description: 'Record what a sentence in a document means for one plan item. You must copy the sentence exactly; the host checks it is really in the document and that any date or percentage you report is in that sentence.',
    parameters: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        itemId: { type: 'string' },
        quote: { type: 'string', description: 'The exact sentence copied from the document.', maxLength: 300 },
        nonRefundable: { type: 'boolean' },
        freeCancelUntil: { type: 'string', description: 'Date and optional time in the sentence, like 2026-05-06 or 2026-05-06T12:00.' },
        penaltyPercent: { type: 'number' },
      },
      required: ['docId', 'itemId', 'quote'],
    },
    run: async (a, ctx) => {
      try {
        const fact = await ctx.recordPolicy(a);
        const rule = fact.nonRefundable ? 'non-refundable' : [fact.freeCancelUntil && `free to cancel until ${fact.freeCancelUntil}`, fact.penaltyPercent != null && `${fact.penaltyPercent}% charged otherwise`].filter(Boolean).join(', ');
        return { result: { recorded: true, itemId: fact.itemId, item: fact.itemTitle, rule }, event: { title: `Noted a rule for ${fact.itemTitle}`, detail: rule, quote: fact.quote } };
      } catch (e) {
        return { result: { recorded: false, error: e.message }, event: { title: 'Rejected a rule it tried to note', detail: e.message, rejected: true } };
      }
    },
  });

  add({
    name: 'simulate_edit',
    description: 'Try a candidate edit without changing anything. Reports the plan, the money consequences, whether it is inside your limits, and what the traveler would lose to the operator under the recorded terms. Try several options and compare them before you submit.',
    parameters: { type: 'object', properties: { operations: OPERATIONS }, required: ['operations'] },
    run: async (a, ctx) => {
      const s = await ctx.readState();
      let ops;
      try { ops = groundOps(a.operations, ctx, s); } catch (e) { return { result: { ok: false, error: e.message }, event: { title: 'Rejected an option', detail: e.message, rejected: true } }; }
      const sim = await ctx.simulate(ops);
      if (!sim.ok) return { result: { ok: false, error: sim.error }, event: { title: 'Tried an option that does not work', detail: sim.error, rejected: true } };
      ctx.simulated.set(canon(ops), { ops, sim });
      const letter = String.fromCharCode(64 + ctx.simulated.size);
      const e = sim.effect;
      const result = {
        ok: true,
        option: letter,
        planChanges: describeEdit(s.plan, sim.newPlan),
        planTotalUsd: usd(sim.newTotalCents),
        budgetUsd: usd(sim.budgetCents),
        money: { refundUsd: usd(e.refundCents), chargeUsd: usd(e.chargeCents), newHoldUsd: usd(e.holdCents), whatHappens: sim.booked ? describeEffect(sim.actions) : 'The trip is not booked yet, so no money is involved.' },
        needsBuyerApprovalInPayPal: sim.needsPayPalApproval,
        insideYourLimits: sim.booked ? sim.mandate.within : false,
        whyItWaitsForTheTraveler: sim.mandate.reasons.map((r) => r.text),
        operatorLoss: sim.losses.map((l) => ({ item: l.title, ifYouDo: l.appliesTo, lossUsd: usd(l.lossCents), because: l.why, termsQuote: l.quote })),
        holdValidUntil: sim.holdValidUntil,
      };
      const loss = sim.losses.filter((l) => l.lossCents != null).reduce((n, l) => n + l.lossCents, 0);
      const unknown = sim.losses.some((l) => l.lossCents == null);
      const detail = `${optionText(sim, ops, s)}. ${sim.booked ? describeEffect(sim.actions) : ''} ${sim.booked ? (sim.mandate.within ? 'Inside your limits.' : `Waits for you: ${sim.mandate.reasons.map((r) => r.text).join(' ')}`) : ''}${sim.losses.length ? ` Lost to the operator: ${unknown ? 'not stated in the terms' : money(loss)}.` : ''}`.replace(/\s+/g, ' ').trim();
      return { result, event: { title: `Tried option ${letter}`, detail, option: letter } };
    },
  });

  add({
    name: 'submit_edit',
    description: 'Hand over your final choice. It must be exactly an edit you simulated. Code decides what happens: inside the traveler\'s limits it is carried out, otherwise it becomes a proposal the traveler confirms. Ends the task.',
    terminal: true,
    parameters: {
      type: 'object',
      properties: {
        operations: OPERATIONS,
        summary: { type: 'string', description: 'One or two plain sentences to the traveler about what you chose.', maxLength: 400 },
        reason: { type: 'string', description: 'Why this option over the others you tried.', maxLength: 500 },
      },
      required: ['operations', 'summary', 'reason'],
    },
    run: async (a, ctx) => {
      const s = await ctx.readState();
      let ops;
      try { ops = groundOps(a.operations, ctx, s); } catch (e) { return { result: { accepted: false, error: e.message }, event: { title: 'Rejected the choice', detail: e.message, rejected: true }, retry: true }; }
      if (!ctx.simulated.has(canon(ops))) {
        return { result: { accepted: false, error: 'This is not an edit you simulated. Call simulate_edit with exactly these operations first, then submit them.' }, event: { title: 'Rejected the choice', detail: 'It was not simulated first.', rejected: true }, retry: true };
      }
      const decision = { title: 'Chose an option', detail: a.reason, agentReason: true, note: a.summary };
      let out;
      try { out = await ctx.submitEdit({ ops, agentNote: a.summary, runId: ctx.runId }); } catch (e) { return { result: { accepted: false, error: e.message }, event: { title: 'The choice was refused', detail: e.message, rejected: true }, retry: true }; }
      const result = { accepted: true, outcome: out.outcome, summary: out.summary, ...(out.error ? { error: out.error } : {}) };
      return { result, final: { kind: 'submitted', outcome: out.outcome, proposalId: out.proposalId, summary: out.summary, within: out.mandate?.within, reasons: out.mandate?.reasons?.map((r) => r.text) ?? [], money: out.money, effect: out.effect }, decision };
    },
  });

  add({
    name: 'ask_traveler',
    description: 'Ask the traveler one question when no safe option exists or the choice is a matter of their taste. Ends the task.',
    terminal: true,
    parameters: { type: 'object', properties: { question: { type: 'string', maxLength: 500 } }, required: ['question'] },
    run: async (a) => ({ result: { sent: true }, final: { kind: 'asked', question: String(a.question).slice(0, 500) }, event: { title: 'Asked you a question', detail: String(a.question).slice(0, 500) } }),
  });

  add({
    name: 'no_change',
    description: 'Finish without changing anything, when the facts show the plan is fine. Say what you checked. Ends the task.',
    terminal: true,
    parameters: { type: 'object', properties: { note: { type: 'string', description: 'What you checked and why nothing needs to change.', maxLength: 400 } }, required: ['note'] },
    run: async (a) => ({ result: { done: true }, final: { kind: 'no_change', note: String(a.note).slice(0, 400) }, event: { title: 'Decided nothing needs to change', detail: String(a.note).slice(0, 400), agentReason: true } }),
  });

  return tools;
}

export const toolDefs = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

// Run one tool call the model made. Bad arguments never reach the code behind a tool; the model is told what was wrong.
export async function runTool(tools, call, parsed, ctx) {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return { result: { error: `There is no tool ${call.name}.` }, event: { title: 'Tried a tool that does not exist', detail: String(call.name).slice(0, 60), rejected: true }, invalid: true };
  if (!parsed.ok) return { result: { error: parsed.error }, event: { title: `Sent ${tool.name} badly formed arguments`, detail: parsed.error, rejected: true }, invalid: true };
  const errs = validate(tool.parameters, parsed.value);
  if (errs.length) return { result: { error: errs.join('; ') }, event: { title: `Sent ${tool.name} arguments that do not fit`, detail: errs.join('; '), rejected: true }, invalid: true };
  return { ...(await tool.run(parsed.value, ctx)), tool };
}

export { PLACE_KINDS, paypalEffect, reserves };
