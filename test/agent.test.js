import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { sha256Hex } from '../src/domain/hash.js';
import { itemState } from '../src/domain/ledger.js';
import { createSources, summarizePayPal } from '../src/agent/sources.js';
import { fakePayPalFetch, fakeEnv, fakeSources, scriptedModel, lastToolResult, planner, untilRunDone, PLAN_PROMPT, SAMPLE_PLAN } from './helpers.js';
import { TERMS, BOAT_QUOTE, SINTRA_QUOTE, PLAN, PLACES, STORM, T, allResults, facts, found, boatOf, stormSteps } from './storm.js';

// The agent, end to end, with a scripted stand-in for the model. The real engine, ledger, tools, guards, runner and
// alarm are all real; only the model, PayPal's HTTP and the forecast/place services are replaced at the edge.
const CLOCK0 = Date.parse('2026-05-01T09:00:00Z');

async function world({ run, sources = fakeSources({ forecasts: STORM, places: PLACES }), terms, checkout = true, vars = {}, spend, plan = PLAN, docs = true, models } = {}) {
  const clock = { t: CLOCK0 };
  const fake = fakePayPalFetch({ now: () => clock.t });
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const w = fakeEnv({ paypal, run, sources, ai: planner(plan), now: () => clock.t, vars, spend, models });
  const id = 'ab'.repeat(12);
  const token = 'owner-secret';
  const trip = w.env.TRIP.get(id);
  const created = await trip.call('createTrip', [id, { prompt: PLAN_PROMPT, startDate: '2026-05-04', ownerTokenHash: await sha256Hex(token) }]);
  assert.ok(created.ok, JSON.stringify(created));
  const call = (m, a = []) => trip.call(m, a, token);
  if (terms) assert.ok((await call('setMandateTerms', [terms])).ok);
  if (checkout) {
    const p = (await call('view')).v.proposal;
    assert.ok((await call('confirm', [p.id, p.digest])).ok);
    const o = await call('createOrder', [p.id]);
    assert.ok((await call('approveOrder', [p.id, o.v.orderId])).ok);
  }
  if (docs) assert.ok((await call('addDocument', [TERMS])).ok);
  return { w, trip, call, clock, fake, id, token, view: async () => (await call('view')).v, state: () => w.storageOf(id).mem.get('state') };
}
const startRun = async (wd, text = 'A storm is forecast for the boat tour day. Swap it for something indoors.') => {
  const r = await wd.call('startRun', [text]);
  assert.ok(r.ok, JSON.stringify(r));
  return untilRunDone(wd.w.env, wd.id, r.v.runId);
};
const moneyCalls = (wd) => wd.fake.calls.filter((c) => /POST .*\/(orders|authorize|capture|void|refund)/.test(c));
const titles = (run) => run.events.filter((e) => e.title).map((e) => e.title);
// the buffer in the hold is as big as the raise allowed: $180, enough to set aside the replacement for the $180 boat tour
const TERMS_OK = { enabled: true, refundCapCents: 21000, planIncreaseCapCents: 18000, validUntil: Date.parse('2026-05-10T00:00:00Z') };

// ---------------------------------------------------------------------------------------------------------------------

test('woken by a storm, the agent reads the terms, finds a real museum, compares, and inside the limits it refunds and swaps on its own, then checks PayPal', async () => {
  const model = scriptedModel(stormSteps());
  const wd = await world({ run: model, terms: TERMS_OK });
  const before = moneyCalls(wd).length;
  const run = await startRun(wd);

  assert.equal(run.status, 'done');
  assert.deepEqual([run.final.kind, run.final.outcome], ['submitted', 'executed']);
  assert.equal(moneyCalls(wd).length, before + 1, 'exactly one PayPal call: the refund of the prepaid boat tour');
  assert.ok(wd.fake.refs.size === 1 && [...wd.fake.refs.values()][0].note === 'Wayledger: your trip plan changed');

  const s = wd.state();
  assert.equal(s.plan.items.some((i) => /boat/i.test(i.title)), false);
  const museum = s.plan.items.find((i) => i.title === 'Electricity Museum');
  assert.ok(museum, 'the new item carries a real place name taken from the search result, not from the model');
  assert.equal(museum.placeId, 'wd:Q1262183');
  assert.equal(museum.amountCents, 18000);
  assert.equal(museum.amountBasis, 'same_as_replaced', 'it says its price is a budget, not a ticket price');
  assert.equal(itemState(s.ledger, museum.id).status, 'held');
  assert.equal(s.mandate.used.refundCents, 18000);

  const p = s.proposals[run.final.proposalId];
  assert.equal(p.confirmation.by, 'mandate');
  assert.match(p.summary, /Remove Sunset boat tour \(\$180\.00\)\. Add Electricity Museum \(\$180\.00, day 2\)/);
  assert.equal(p.summary.includes('storm'), false, 'the proposal\'s words are written by code; the model\'s sentence is kept apart');
  assert.equal(p.agentNote, 'I swapped the boat tour for a museum visit because of the storm.');

  // what the person sees while it works: what was asked, what came back, what was chosen, whether it was allowed, PayPal's check
  assert.deepEqual(titles(run).filter((t) => !/^Tried option/.test(t)), [
    'Read your message', 'Looked at your trip', 'Checked the forecast', 'Read your booking terms', 'Noted a rule for Sunset boat tour',
    'Searched for museum places', 'Chose an option', 'Inside your limits, so it went ahead', 'Checked PayPal against the ledger',
  ]);
  const rule = run.events.find((e) => e.title?.startsWith('Noted a rule'));
  assert.equal(rule.quote, BOAT_QUOTE, 'the sentence it relied on is on the screen');
  const trial = run.events.find((e) => e.title === 'Tried option A');
  assert.match(trial.detail, /Inside your limits/);
  assert.match(trial.detail, /Lost to the operator: \$0\.00/);
  assert.equal(run.events.at(-1).ok, true);
  assert.ok(run.stats.modelCalls >= 7);
});

test('the same request outside the limits: the agent stops, nothing moves, and the change waits as a proposal the person can confirm', async () => {
  const model = scriptedModel(stormSteps());
  const wd = await world({ run: model, terms: { ...TERMS_OK, refundCapCents: 10000 } });
  const before = moneyCalls(wd).length;
  const run = await startRun(wd);

  assert.deepEqual([run.final.kind, run.final.outcome, run.final.within], ['submitted', 'proposed', false]);
  assert.equal(moneyCalls(wd).length, before, 'no money moved');
  const view = await wd.view();
  assert.equal(view.proposal.status, 'pending');
  assert.deepEqual(view.proposal.outside.map((r) => r.code), ['REFUND_OVER_LIMIT']);
  assert.match(view.proposal.outside[0].text, /refunds \$180\.00, but only \$100\.00 of your \$100\.00 refund limit is left/);
  assert.equal(titles(run).includes('Waiting for your OK'), true);
  assert.equal(titles(run).includes('Checked PayPal against the ledger'), false);
  assert.equal(wd.state().plan.items.some((i) => /boat/i.test(i.title)), true, 'the plan has not changed');

  // the person decides: confirm, and it runs; the agent\'s limit is not used up by a human decision
  const ok = await wd.call('confirm', [view.proposal.id, view.proposal.digest]);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(wd.state().plan.items.some((i) => /boat/i.test(i.title)), false);
  assert.equal(wd.state().mandate.used.refundCents, 0);
});

test('a choice that needs a new PayPal hold is never the agent\'s to make, even with room in the limits', async () => {
  const add = (name, amount) => [
    { calls: [T('get_trip')] },
    { calls: [T('simulate_edit', { add: [{ day: 3, title: name, category: 'activity', amount, amountBasis: 'user_given', participants: ['Ana'] }] })] },
    { calls: [T('submit_edit', { add: [{ day: 3, title: name, category: 'activity', amount, amountBasis: 'user_given', participants: ['Ana'] }], summary: 'Added it.', reason: 'You asked.' })] },
  ];
  const wd = await world({ run: scriptedModel(add('Helicopter tour', 300)), terms: TERMS_OK });
  const run = await startRun(wd, 'Please add a Helicopter tour on day 3 for $300.');
  assert.equal(run.final.outcome, 'proposed');
  const view = await wd.view();
  assert.ok(view.proposal.outside.some((r) => r.code === 'NEEDS_PAYPAL_APPROVAL'));
  assert.ok(view.proposal.lines.some((l) => /Hold \$300\.00 with PayPal/.test(l.text)));
});

test('inside the buffer an added item needs no PayPal call at all: the money was already held', async () => {
  const edit = { add: [{ day: 3, title: 'Sintra lunch', category: 'food', amount: 100, amountBasis: 'user_given', participants: ['Ana'] }] };
  const wd = await world({ run: scriptedModel([{ calls: [T('simulate_edit', edit)] }, { calls: [T('submit_edit', { ...edit, summary: 'Lunch added.', reason: 'You asked.' })] }]), terms: TERMS_OK });
  const before = moneyCalls(wd).length;
  const run = await startRun(wd, 'Add Sintra lunch for $100.');
  assert.equal(run.final.outcome, 'executed');
  assert.equal(moneyCalls(wd).length, before);
  assert.equal(wd.state().plan.items.some((i) => i.title === 'Sintra lunch'), true);
});

// ---- the two hard conditions ----------------------------------------------------------------------------------------

test('hard condition 1: without a model that reads the terms, the loss to the operator is unknown and nothing can be decided', async () => {
  // A stand-in that never reads the documents: it asks the code what cancelling would cost, and gets no answer.
  const blind = scriptedModel([
    { calls: [T('get_trip')] },
    ({ messages }) => ({ calls: [T('simulate_edit', { remove: [boatOf(messages).id] })] }),
  ]);
  const wd = await world({ run: blind, terms: TERMS_OK });
  const run = await startRun(wd);
  const sim = allResults(blind.log.at(-1).messages).find((r) => r.option);
  assert.equal(sim.operatorLoss[0].lossUsd, null, 'the rules alone cannot tell that the boat tour is the free one to cancel');
  assert.match(sim.operatorLoss[0].because, /no cancellation terms were recorded/);
  assert.equal(wd.state().policies.length, 0, 'no rule was ever recorded: code cannot read free text');
  assert.equal(run.final.kind, 'stopped');
  assert.equal(wd.state().plan.items.some((i) => /boat/i.test(i.title)), true, 'and nothing changed');

  // The same code, once a model has read the sentences and quoted them, tells the free option from the costly one.
  const reading = scriptedModel([
    { calls: [T('get_trip')] },
    { calls: [T('read_documents')] },
    ({ messages }) => ({ calls: [T('record_policy', { docId: 'd1', itemId: boatOf(messages).id, quote: BOAT_QUOTE, freeCancelUntil: '2026-05-06T12:00' }), T('record_policy', { docId: 'd1', itemId: facts(messages).items.find((i) => /Sintra/.test(i.title)).id, quote: SINTRA_QUOTE, nonRefundable: true })] }),
    ({ messages }) => { const f = facts(messages); return { calls: [T('simulate_edit', { remove: [f.items.find((i) => /boat/i.test(i.title)).id] }), T('simulate_edit', { remove: [f.items.find((i) => /Sintra/.test(i.title)).id] })] }; },
    { calls: [T('no_change', { note: 'enough looked at' })] },
  ]);
  const wd2 = await world({ run: reading, terms: TERMS_OK });
  await startRun(wd2);
  const [boat, sintra] = allResults(reading.log.at(-1).messages).filter((r) => r.option);
  assert.deepEqual([boat.operatorLoss[0].lossUsd, sintra.operatorLoss[0].lossUsd], [0, 120]);
});

test('hard condition 2: one model call cannot do it; each step depends on the tool result before it, and the record shows the rounds', async () => {
  const model = scriptedModel(stormSteps());
  const wd = await world({ run: model, terms: TERMS_OK });
  const run = await startRun(wd);
  assert.equal(model.log.length, 7, 'seven model calls for one decision');
  assert.equal(run.stats.modelCalls, 7);

  // every later request carries the earlier tool results: the conversation really is a chain
  for (let i = 1; i < model.log.length; i++) {
    const before = model.log[i - 1].messages.filter((m) => m.role === 'tool').length;
    const now = model.log[i].messages.filter((m) => m.role === 'tool').length;
    assert.equal(now, before + 1, `request ${i + 1} contains the result of request ${i}`);
  }
  // and what it finally submitted came out of those results, not out of the first question
  const sent = JSON.parse(model.log.at(-1).messages.findLast((m) => m.role === 'assistant' && m.tool_calls.some((c) => c.function.name === 'simulate_edit')).tool_calls[0].function.arguments);
  assert.deepEqual(sent.add[0].placeId, 'wd:Q1262183');
  assert.deepEqual(run.events.filter((e) => e.kind === 'model').map((e) => e.turn), [1, 2, 3, 4, 5, 6, 7]);

  // a model that answers in one go is refused: an edit that was not simulated first is not accepted
  const oneShot = scriptedModel([{ calls: [T('submit_edit', { reprice: [{ itemId: 'i1', amount: 100 }], summary: 'Done.', reason: 'Because.' })] }]);
  const wd2 = await world({ run: oneShot, terms: TERMS_OK });
  const run2 = await startRun(wd2);
  assert.equal(run2.final.kind, 'stopped');
  assert.equal(wd2.state().plan.items.find((i) => i.id === 'i1').amountCents, 54000, 'the plan is untouched');
  assert.equal(titles(run2).filter((t) => t === 'Rejected the choice').length >= 2, true);
  assert.equal(moneyCalls(wd2).length, moneyCalls(wd).length - 1, 'and no refund went out');
});

// ---- what the model is not allowed to make up -----------------------------------------------------------------------

test('names and prices are checked by code before an edit is even simulated', async () => {
  const bad = (edit, why) => async () => {
    const m = scriptedModel([{ calls: [T('get_trip')] }, { calls: [T('simulate_edit', edit)] }, { calls: [T('no_change', { note: 'x' })] }]);
    const wd = await world({ run: m, terms: TERMS_OK });
    await startRun(wd);
    const r = allResults(m.log.at(-1).messages).find((x) => x.ok === false);
    assert.ok(r, why);
    return r.error;
  };
  assert.match(await bad({ add: [{ day: 2, placeId: 'wd:Q999', category: 'activity', amountBasis: 'same_as_replaced', replaces: 'i2' }], remove: ['i2'] }, 'a place that no search returned')(), /did not come from search_places/);
  assert.match(await bad({ add: [{ day: 2, title: 'Oceanario de Lisboa', category: 'activity', amount: 90, amountBasis: 'user_given' }] }, 'a name from nowhere')(), /Names are not made up/);
  assert.match(await bad({ add: [{ day: 2, title: 'Helicopter tour', category: 'activity', amount: 90, amountBasis: 'user_given' }] }, 'a price the person never wrote')(), /Names are not made up|price the traveler actually wrote/);
  assert.match(await bad({ remove: ['i99'] }, 'an item that does not exist')(), /no item i99/);
  assert.match(await bad({ add: [{ day: 2, placeId: 'wd:Q1262183', category: 'activity', amountBasis: 'same_as_replaced', replaces: 'i3' }] }, 'a price borrowed from an item that is not removed')(), /did not come from search_places|replaces/);
  assert.match(await bad({}, 'an empty edit')(), /empty/);
  assert.match(await bad({ setTravelers: ['Ana', 'Ben', 'Zed'] }, 'a traveler nobody named')(), /Names are not made up/);
});

test('a place name or price the person wrote is allowed; a price that matches nothing they wrote is not', async () => {
  const mk = (amount) => ({ add: [{ day: 3, title: 'Helicopter tour', category: 'activity', amount, amountBasis: 'user_given', participants: ['Ana'] }] });
  const m = scriptedModel([{ calls: [T('simulate_edit', mk(250))] }, { calls: [T('simulate_edit', mk(99))] }, { calls: [T('no_change', { note: 'x' })] }]);
  const wd = await world({ run: m, terms: TERMS_OK });
  await startRun(wd, 'Please add the Helicopter tour on day 3, it costs $250.');
  const [first, second] = allResults(m.log.at(-1).messages);
  assert.equal(first.ok, true);
  assert.match(second.error, /price the traveler actually wrote/);
});

test('a rule is recorded only with the exact sentence: a paraphrase is rejected, shown as rejected, and changes nothing', async () => {
  const m = scriptedModel([
    { calls: [T('get_trip')] },
    ({ messages }) => ({ calls: [T('record_policy', { docId: 'd1', itemId: boatOf(messages).id, quote: 'The boat tour can be cancelled for free until 6 May.', freeCancelUntil: '2026-05-06' })] }),
    { calls: [T('no_change', { note: 'could not read' })] },
  ]);
  const wd = await world({ run: m, terms: TERMS_OK });
  const run = await startRun(wd);
  assert.equal(wd.state().policies.length, 0);
  const e = run.events.find((x) => x.title === 'Rejected a rule it tried to note');
  assert.ok(e && e.rejected);
  assert.match(e.detail, /word for word/);
});

// ---- guards around the model ----------------------------------------------------------------------------------------

test('arguments that are not JSON never reach a tool and are not echoed back to the API; the model is told and carries on', async () => {
  const m = scriptedModel([
    { calls: [{ name: 'get_trip', args: '{not json' }] },
    { calls: [T('get_trip')] },
    { calls: [T('no_change', { note: 'fine' })] },
  ]);
  const wd = await world({ run: m, terms: TERMS_OK });
  const run = await startRun(wd);
  assert.equal(run.final.kind, 'no_change');
  const echoed = m.log[1].messages.findLast((x) => x.role === 'assistant').tool_calls[0].function.arguments;
  assert.equal(echoed, '{}', 'a broken argument string is replaced before it goes back (the API refuses a whole request over one)');
  assert.deepEqual(lastToolResult(m.log[1].messages), { error: 'arguments were not valid JSON' });
  assert.equal(run.events.some((e) => e.rejected), true);
});

test('a plain-text answer is not an answer: the agent is reminded twice, then stopped with nothing changed', async () => {
  const m = scriptedModel([{ text: 'I think you should skip the boat tour.' }]);
  const wd = await world({ run: m, terms: TERMS_OK });
  const before = JSON.stringify(wd.state().plan);
  const run = await startRun(wd);
  assert.equal(run.final.kind, 'stopped');
  assert.equal(run.stats.nudges, 2);
  assert.equal(run.events.filter((e) => e.kind === 'guard').length, 2);
  assert.equal(JSON.stringify(wd.state().plan), before);
  assert.equal(run.status, 'error');
});

test('a model that fails is replaced by the backup model, once, and the switch is on the record', async () => {
  const ok = scriptedModel([{ calls: [T('no_change', { note: 'fine' })] }]);
  const run = async (id, input) => { if (id.includes('gemma')) throw new Error('upstream 500'); return ok(id, input); };
  const wd = await world({ run, terms: TERMS_OK, models: ['gemma', 'oss'] });
  const r = await startRun(wd);
  assert.equal(r.final.kind, 'no_change');
  assert.equal(r.stats.model, 'oss');
  assert.deepEqual(r.events.filter((e) => e.kind === 'model_error' || e.kind === 'note').map((e) => e.title), ['The AI model did not answer', 'Switched to the backup model']);

  const bothDown = await world({ run: async () => { throw new Error('down'); }, terms: TERMS_OK, models: ['gemma', 'oss'] });
  const r2 = await startRun(bothDown);
  assert.equal(r2.final.kind, 'stopped');
  assert.match(r2.final.why, /not answering right now. Nothing was changed/);
});

test('PayPal facts reach the model without the buyer: no email, name, address or account id', async () => {
  const wd = await world({ run: scriptedModel([{ text: 'x' }]), terms: TERMS_OK });
  const s = wd.state();
  // a real-shaped order, as the PayPal Agent Toolkit returns it
  const sample = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/sandbox_resources.json', import.meta.url), 'utf8')).samples.get_order.body;
  assert.match(JSON.stringify(sample), /buyer@example.com/, 'the real-shaped order does contain the buyer email');
  assert.match(JSON.stringify(sample), /Doe/);
  const out = summarizePayPal(s, [sample], [], { items: [] });
  const text = JSON.stringify(out);
  for (const secret of ['buyer@example.com', 'Doe', 'John', 'RC3HKDZ73C7WG', 'payer', 'address', '@']) assert.equal(text.includes(secret), false, `"${secret}" must not reach the model`);
  assert.ok(out.holds.length === 1 && out.holds[0].validUntil, 'it still carries what the agent needs: the hold and when it lapses');
  assert.equal(out.chargedUsd > 0, true);
});



test('a model that never reads the pasted terms cannot cancel anything: the code refuses and tells it what to do', async () => {
  const lazy = scriptedModel([
    { calls: [T('get_trip')] },
    ({ messages }) => ({ calls: [T('simulate_edit', { remove: [boatOf(messages).id] })] }),
    ({ messages }) => ({ calls: [T('submit_edit', { remove: [boatOf(messages).id], summary: 'Removed it.', reason: 'Storm.' })] }),
  ]);
  const wd = await world({ run: lazy, terms: TERMS_OK });
  const before = moneyCalls(wd).length;
  const run = await startRun(wd);
  assert.equal(run.final.kind, 'stopped');
  assert.equal(wd.state().plan.items.some((i) => /boat/i.test(i.title)), true, 'the boat tour is still in the plan');
  assert.equal(moneyCalls(wd).length, before, 'no refund went out');
  const refused = run.events.find((e) => e.title === 'The choice was refused');
  assert.match(refused.detail, /pasted booking terms[\s\S]*read_documents/);
  const sim = allResults(lazy.log[2].messages).find((r) => r.option);
  assert.match(sim.termsNotRead, /nothing is recorded about: Sunset boat tour/, 'the simulation already said so');
});

test('a submit that differs from what was simulated is refused with the simulated edit shown; an update that changes nothing is ignored', async () => {
  const edit = { reprice: [{ itemId: 'i3', amount: 200 }] };
  const m = scriptedModel([
    { calls: [T('simulate_edit', edit)] },
    { calls: [T('submit_edit', { reprice: [{ itemId: 'i3', amount: 190 }], summary: 'Raised it.', reason: 'The operator asked.' })] },
    { calls: [T('submit_edit', { ...edit, update: [{ itemId: 'i3' }], summary: 'Raised it.', reason: 'The operator asked.' })] },
  ]);
  const wd = await world({ run: m, terms: TERMS_OK });
  const run = await startRun(wd, 'The Sintra day trip operator now wants $200 for it.');
  const refusal = allResults(m.log[2].messages).find((r) => r.accepted === false);
  assert.match(refusal.error, /You simulated A: \{"reprice":\[\{"itemId":"i3","amount":200\}\]\}\. Submit exactly one of them/);
  assert.deepEqual([run.final.kind, run.final.outcome], ['submitted', 'executed'], 'the empty update did not make it a different edit');
  assert.equal(wd.state().plan.items.find((i) => i.id === 'i3').amountCents, 20000);
});
