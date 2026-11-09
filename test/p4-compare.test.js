import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptedModel } from './helpers.js';
import { world, startRun, moneyCalls, titles, TERMS_OK } from './agent-world.js';
import { T, allResults, boatOf, swapEdit, cancelEdit, BOAT_QUOTE, BY_TRAVELER } from './storm.js';

// Item 2: before money moves at PayPal the agent has weighed at least two different plans with simulate_edit. The loop
// puts the comparison and the reason for the choice on the work trail. Plans that move no money, and trips that are not
// booked yet, need no comparison.
const read = [
  { calls: [T('get_trip')] },
  { calls: [T('read_documents')] },
  ({ messages }) => ({ calls: [T('record_policy', { docId: 'd1', itemId: boatOf(messages).id, quote: BOAT_QUOTE, freeCancelUntil: '2026-05-06T12:00' })] }),
  { calls: [T('search_places', { kind: 'museum' })] },
];
const say = { summary: 'I swapped the boat tour for a museum visit.', reason: 'The museum is indoors and the boat tour is free to cancel.' };
const submitSwap = ({ messages }) => ({ calls: [T('submit_edit', { ...swapEdit(messages), ...say, authority: BY_TRAVELER })] });

test('money does not move on one option alone: the agent is told to compare, and when it has, the refund goes out', async () => {
  const m = scriptedModel([
    ...read,
    ({ messages }) => ({ calls: [T('simulate_edit', swapEdit(messages))] }),
    submitSwap,
    ({ messages }) => ({ calls: [T('simulate_edit', cancelEdit(messages))] }),
    submitSwap,
  ]);
  const wd = await world({ run: m, terms: TERMS_OK });
  const before = moneyCalls(wd).length;
  const run = await startRun(wd);

  const refused = allResults(m.log[6].messages).find((r) => r.accepted === false);
  assert.match(refused.error, /at least 2 different plans/);
  assert.match(refused.error, /You have simulated 1/);
  assert.deepEqual([run.final.kind, run.final.outcome], ['submitted', 'executed']);
  assert.equal(moneyCalls(wd).length, before + 1, 'one refund, after the second option');
  assert.equal(titles(run).filter((t) => t === 'Rejected the choice').length, 1);
});

test('the comparison is on the trail: each option with its money, which one was chosen and the agent\'s reason', async () => {
  const m = scriptedModel([
    ...read,
    ({ messages }) => ({ calls: [T('simulate_edit', swapEdit(messages))] }),
    ({ messages }) => ({ calls: [T('simulate_edit', cancelEdit(messages))] }),
    submitSwap,
  ]);
  const wd = await world({ run: m, terms: TERMS_OK });
  const run = await startRun(wd);
  const names = run.events.filter((e) => e.title).map((e) => e.title);
  const at = names.indexOf('Compared 2 options');
  assert.ok(at > names.indexOf('Tried option B') && at < names.indexOf('Chose an option'), 'after the options, before the choice');
  const c = run.events.find((e) => e.kind === 'compare');
  assert.equal(c.chosen, 'A');
  assert.equal(c.reason, say.reason);
  assert.equal(c.options.length, 2);
  const [a, b] = c.options;
  assert.deepEqual([a.option, a.chosen, a.refundUsd, a.within], ['A', true, 180, true]);
  assert.match(a.text, /Remove Sunset boat tour.*Add Electricity Museum/);
  assert.deepEqual([b.option, b.chosen, b.refundUsd], ['B', false, 180]);
  assert.equal(b.text, 'Remove Sunset boat tour ($180.00)');
  assert.equal(a.lossUsd, 0, 'what each would cost at the operator is part of the comparison');
});

test('two simulations of the same plan are one option, however the edit is written', async () => {
  const m = scriptedModel([
    ...read,
    ({ messages }) => ({ calls: [T('simulate_edit', cancelEdit(messages))] }),
    ({ messages }) => ({ calls: [T('simulate_edit', { ...cancelEdit(messages), update: [{ itemId: boatOf(messages).id }] })] }),
    ({ messages }) => ({ calls: [T('simulate_edit', { remove: [boatOf(messages).id, boatOf(messages).id] })] }),
    ({ messages }) => ({ calls: [T('submit_edit', { ...cancelEdit(messages), ...say, authority: BY_TRAVELER })] }),
  ]);
  const wd = await world({ run: m, terms: TERMS_OK });
  const before = moneyCalls(wd).length;
  const run = await startRun(wd);
  assert.equal(run.final.kind, 'stopped', 'it never weighed a second plan');
  assert.equal(moneyCalls(wd).length, before);
  assert.equal(run.events.some((e) => e.kind === 'compare'), false);
});

test('a change that moves no money at PayPal needs no comparison, and an unbooked trip does not either', async () => {
  const lunch = { add: [{ day: 3, title: 'Sintra lunch', category: 'food', amount: 100, amountBasis: 'user_given' }] };
  const one = scriptedModel([{ calls: [T('simulate_edit', lunch)] }, { calls: [T('submit_edit', { ...lunch, summary: 'Lunch added.', reason: 'You asked.', authority: { source: 'traveler', quote: 'Add Sintra lunch for $100' } })] }]);
  const wd = await world({ run: one, terms: TERMS_OK });
  const before = moneyCalls(wd).length;
  const run = await startRun(wd, 'Add Sintra lunch for $100.');
  assert.equal(run.final.outcome, 'executed');
  assert.equal(moneyCalls(wd).length, before, 'inside the buffer: no PayPal call');
  assert.equal(run.events.some((e) => e.kind === 'compare'), false, 'one option is not a comparison');

  const draft = scriptedModel([{ calls: [T('simulate_edit', lunch)] }, { calls: [T('submit_edit', { ...lunch, summary: 'Lunch added.', reason: 'You asked.', authority: { source: 'traveler', quote: 'Add Sintra lunch for $100' } })] }]);
  const wd2 = await world({ run: draft, checkout: false, docs: false });
  const run2 = await startRun(wd2, 'Add Sintra lunch for $100.');
  assert.equal(run2.final.outcome, 'updated');
});

test('the same rule holds for a change that will wait for the traveler: a refund proposed on one option is refused', async () => {
  const m = scriptedModel([
    ...read,
    ({ messages }) => ({ calls: [T('simulate_edit', swapEdit(messages))] }),
    submitSwap,
    { calls: [T('no_change', { note: 'stopped' })] },
  ]);
  const wd = await world({ run: m, terms: { ...TERMS_OK, refundCapCents: 10000 } });
  await startRun(wd);
  assert.equal(Object.values(wd.state().proposals).filter((p) => p.kind === 'change').length, 0);
});

test('simulate_edit accepts natural remove arguments: objects [{id}], titles, and numbers', async () => {
  const m = scriptedModel([
    ...read,
    // 1. Model passes remove: [{ id: 'i2' }] as seen in Workers AI runs
    ({ messages }) => ({
      calls: [T('simulate_edit', {
        remove: [{ id: boatOf(messages).id }],
        add: [{ day: 2, placeId: 'wd:Q1262183', category: 'activity', amountBasis: 'same_as_replaced', replaces: boatOf(messages).id }]
      })]
    }),
    // 2. Model passes remove: ['Sunset boat tour'] (title matching)
    () => ({
      calls: [T('simulate_edit', {
        remove: ['Sunset boat tour']
      })]
    }),
    // 3. Model passes remove: [2] (numeric matching)
    () => ({
      calls: [T('simulate_edit', {
        remove: [2]
      })]
    }),
    ({ messages }) => ({
      calls: [T('submit_edit', {
        remove: [{ id: boatOf(messages).id }],
        add: [{ day: 2, placeId: 'wd:Q1262183', category: 'activity', amountBasis: 'same_as_replaced', replaces: boatOf(messages).id }],
        ...say,
        authority: BY_TRAVELER
      })]
    }),
  ]);
  const wd = await world({ run: m, terms: TERMS_OK });
  const run = await startRun(wd);
  assert.equal(run.final.kind, 'submitted');
  assert.equal(run.final.outcome, 'executed');
  const simEvents = run.events.filter((e) => e.kind === 'tool' && e.tool === 'simulate_edit');
  assert.ok(simEvents.length >= 2);
  assert.equal(run.events.some((e) => e.rejected && e.title.includes('arguments that do not fit')), false);
});
