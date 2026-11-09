import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { createEngine } from '../src/engine.js';
import { createProposal, assertMayMove } from '../src/domain/proposal.js';
import { itemState, reserves } from '../src/domain/ledger.js';
import { sha256Hex } from '../src/domain/hash.js';
import { fakePayPalFetch, fakeEnv, fakeSources, scriptedModel, makeEngine, newTrip, checkoutAsBuyer, planner } from './helpers.js';

// Second stage, item 1: one PayPal authorization for the whole trip, and each item is charged only on its day. The
// last charge is final, so PayPal releases the rest by itself. What was never charged is never refunded. Real sandbox
// answers for this (a $100 hold, a $30 charge, a $20 final charge, and what is still possible afterwards) are in
// test/fixtures/sandbox_partial_captures.json and the fake PayPal answers with them.
const MONEY = /POST .*\/(orders|authorize|capture|void|refund)/;
const HOUR = 3_600_000;
const START = '2026-05-04'; // day 1; the boat is on day 2 (5 May), Sintra on day 3 (6 May)
const at = (iso) => Date.parse(`${iso}T09:00:00Z`);

// nothing is paid in advance: the money stays on hold until each item's day
const PLAN = {
  title: 'Lisbon long weekend', destination: 'Lisbon', budget: 1500, budgetQuote: 'Budget $1,500 total', travelers: ['Ana', 'Ben', 'Cy'],
  items: [
    { day: 1, title: 'Alfama apartment (3 nights)', category: 'lodging', amount: 540, participants: ['Ana', 'Ben', 'Cy'], prepaid: false },
    { day: 2, title: 'Sunset boat tour', category: 'activity', amount: 180, participants: ['Ana', 'Ben', 'Cy'], prepaid: false },
    { day: 3, title: 'Sintra day trip', category: 'transport', amount: 120, participants: ['Ana', 'Ben'], prepaid: false },
  ],
};
const PROMPT = 'Three friends, Ana, Ben and Cy, four days in Lisbon. Budget $1,500 total.';

function setup(plan = PLAN) {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const ctx = { fake, paypal, ...makeEngine({ ai: planner(plan), paypal }) };
  ctx.clock.t = at('2026-05-01');
  return ctx;
}
const state = (ctx) => ctx.store.peek();
const active = (ctx) => state(ctx).proposals[state(ctx).activeProposal];
const itemId = (ctx, part) => state(ctx).plan.items.find((i) => i.title.includes(part)).id;
const moneyCalls = (ctx) => ctx.fake.calls.filter((c) => MONEY.test(c));
const LIMITS = (ctx) => ({ enabled: true, refundCapCents: 100000, planIncreaseCapCents: 30000, validUntil: ctx.clock.t + 10 * 24 * HOUR });
async function booked(ctx, { limits = true } = {}) {
  await newTrip(ctx, { prompt: PROMPT, startDate: START });
  if (limits) await ctx.engine.setMandateTerms(LIMITS(ctx));
  await checkoutAsBuyer(ctx);
  return [...ctx.fake.auths.keys()][0];
}
const authority = (ctx, authId) => ctx.fake.auths.get(authId);

test('item 1: booking places one hold and charges nothing; every item says on which day it will be charged', async () => {
  const ctx = setup();
  const authId = await booked(ctx);
  assert.equal(moneyCalls(ctx).length, 2, 'an order and its authorization, and no charge');
  assert.equal(ctx.fake.caps.size, 0);
  assert.equal(authority(ctx, authId).status, 'CREATED');
  const s = state(ctx);
  assert.equal(s.settlement.onDay, true, 'the person signed "each item is charged on its day" with the first approval');
  const v = ctx.engine.view(s, { owner: true });
  assert.deepEqual(v.plan.items.map((i) => [i.title, i.dueOn, i.money.status]), [['Alfama apartment (3 nights)', '2026-05-04', 'held'], ['Sunset boat tour', '2026-05-05', 'held'], ['Sintra day trip', '2026-05-06', 'held']]);
  assert.equal(v.totals.paidCents, 0);
  assert.equal(v.totals.heldCents, 84000);
});

test('item 1: the checkout the person confirms says it in plain words', async () => {
  const ctx = setup();
  await newTrip(ctx, { prompt: PROMPT, startDate: START });
  const p = active(ctx);
  assert.equal(p.settleOnDay, true);
  assert.match(p.summary, /Nothing is charged now.*each item is charged on its day.*released/i);
  assert.equal(ctx.engine.view(state(ctx), { owner: true }).proposal.effectText, 'At PayPal this will place a new hold of $1,050.00.');
});

test('item 1: a held item that is swapped for another costs nothing: it was never charged, so there is nothing to refund', async () => {
  const ctx = setup();
  await booked(ctx);
  const before = moneyCalls(ctx).length;
  const out = await ctx.engine.submitEdit({ ops: [{ op: 'remove', itemId: itemId(ctx, 'boat') }, { op: 'add', item: { day: 2, title: 'Electricity Museum', category: 'activity', amount: 180, participants: ['Ana', 'Ben', 'Cy'] } }] });
  assert.equal(out.outcome, 'executed');
  assert.equal(moneyCalls(ctx).length, before, 'PayPal was not called');
  assert.equal(ctx.fake.refs.size, 0);
  assert.equal(ctx.fake.caps.size, 0);
  assert.match(ctx.engine.view(state(ctx), { owner: true }).events.map((e) => e.text).join('\n'), /Inside the limits you signed, so the agent went ahead/);
  assert.equal(itemState(state(ctx).ledger, itemId(ctx, 'Museum')).status, 'held');
  assert.equal(state(ctx).mandate.used.refundCents, 0, 'nothing was refunded');
});

test('item 1: each item is charged on its day, the last charge is final, PayPal releases the rest by itself and the trip ends', async () => {
  const ctx = setup();
  const authId = await booked(ctx);
  assert.equal((await ctx.engine.settleDue()).captured, 0, 'nothing has happened yet');

  ctx.clock.t = at('2026-05-04');
  assert.equal((await ctx.engine.settleDue()).captured, 1);
  assert.equal(ctx.fake.caps.size, 1);
  assert.equal([...ctx.fake.caps.values()][0].finalCapture, false, 'more is still to come on this hold');
  assert.equal(authority(ctx, authId).status, 'PARTIALLY_CAPTURED');
  assert.equal(itemState(state(ctx).ledger, itemId(ctx, 'apartment')).paidCents, 54000);
  assert.equal(itemState(state(ctx).ledger, itemId(ctx, 'boat')).status, 'held');
  assert.equal((await ctx.engine.settleDue()).captured, 0, 'asking again the same day charges nothing twice');

  ctx.clock.t = at('2026-05-05');
  await ctx.engine.settleDue();
  assert.equal(ctx.fake.caps.size, 2);
  assert.equal(authority(ctx, authId).status, 'PARTIALLY_CAPTURED');

  ctx.clock.t = at('2026-05-06');
  const last = await ctx.engine.settleDue();
  assert.equal(last.captured, 1);
  const caps = [...ctx.fake.caps.values()];
  assert.deepEqual(caps.map((c) => c.finalCapture), [false, false, true], 'only the last charge is final');
  assert.equal(authority(ctx, authId).status, 'CAPTURED');
  assert.equal(ctx.fake.calls.filter((c) => /void$/.test(c)).length, 0, 'the rest was released by the final charge, not by a void');
  const s = state(ctx);
  assert.equal(reserves(s.ledger)[0].open, false);
  assert.equal(reserves(s.ledger)[0].releasedCents, 30000, 'the buffer was never charged');
  assert.notEqual(s.closedAt, null, 'the trip is finished');
  const v = ctx.engine.view(s, { owner: true });
  assert.deepEqual([v.totals.paidCents, v.totals.heldCents, v.totals.refundedCents], [84000, 0, 0]);
  assert.equal(v.totals.releasedCents, 30000, 'and what was never charged is shown');
  assert.equal((await ctx.engine.reconcile()).allMatch, true, 'PayPal says the same');
});

test('item 1: the demo clock: a simulated day charges what that day holds, and says it was simulated', async () => {
  const ctx = setup();
  await booked(ctx);
  const v1 = ctx.engine.view(await ctx.engine.advance(3), { owner: true }); // 1 May + 3 days = 4 May
  assert.equal(v1.settlement.simulated, true);
  assert.equal(v1.settlement.today, '2026-05-04');
  assert.equal(v1.settlement.realToday, '2026-05-01');
  assert.equal(ctx.fake.caps.size, 1, 'the apartment');
  const fact = state(ctx).ledger.find((f) => f.op === 'capture');
  assert.equal(fact.simulated, true);
  assert.equal(fact.day, '2026-05-04');
  assert.match(v1.events.map((e) => e.text).join('\n'), /SIMULATED/);
  await assert.rejects(ctx.engine.advance(99), (e) => e.code === 'BAD_INPUT', 'the demo clock is limited');
});

test('item 1: closing early charges what already happened, releases what has not, and a trip with nothing due is simply released', async () => {
  const early = setup();
  const authA = await booked(early);
  await early.engine.closeTrip();
  const p = active(early);
  assert.deepEqual(p.actions.map((a) => a.type).sort(), ['release', 'release', 'release', 'void']);
  assert.match(early.engine.view(state(early), { owner: true }).proposal.effectText, /release \$1,140\.00 of the unused hold/);
  await early.engine.confirm(p.id, p.digest);
  assert.equal(early.fake.caps.size, 0, 'nothing happened, so nothing is charged');
  assert.equal(authority(early, authA).status, 'VOIDED');
  assert.notEqual(state(early).closedAt, null);

  const mid = setup();
  const authB = await booked(mid);
  mid.clock.t = at('2026-05-05'); // the apartment and the boat tour have happened, Sintra has not
  await mid.engine.closeTrip();
  const q = active(mid);
  assert.deepEqual(q.actions.map((a) => [a.type, a.title, a.finalCapture ?? null]), [['release', 'Sintra day trip', null], ['capture', 'Alfama apartment (3 nights)', false], ['capture', 'Sunset boat tour', true]]);
  await mid.engine.confirm(q.id, q.digest);
  assert.deepEqual([...mid.fake.caps.values()].map((c) => Number(c.amount.value)), [540, 180]);
  assert.equal(authority(mid, authB).status, 'CAPTURED');
  assert.equal(mid.fake.calls.filter((c) => /void$/.test(c)).length, 0);
  assert.equal((await mid.engine.reconcile()).rows.every((r) => r.match), true);
  assert.equal(itemState(state(mid).ledger, itemId(mid, 'Sintra')).status, 'released');
});

test('item 1: a charge made on the day is made only on that day, for that amount, because the person approved it with the hold', async () => {
  const now = at('2026-05-01');
  const action = { type: 'capture', itemId: 'i2', title: 'Boat', cents: 18000, authId: 'AUTH1', settle: true, dueOn: '2026-05-05', finalCapture: false };
  const mk = async () => {
    const p = await createProposal({ id: 'p1', tripId: 't1', kind: 'settle', summary: 'x', actions: [action], now });
    p.status = 'confirmed'; p.confirmation = { by: 'schedule', at: now, digest: p.digest };
    return p;
  };
  const p = await mk();
  const ctx = { settlement: { onDay: true }, settleDate: '2026-05-05' };
  await assertMayMove(p, action, 0, now, ctx); // on the day, signed: allowed
  await assert.rejects(assertMayMove(p, action, 0, now, { ...ctx, settleDate: '2026-05-04' }), (e) => e.code === 'NOT_DUE', 'the day before');
  await assert.rejects(assertMayMove(p, action, 0, now, { ...ctx, settlement: null }), (e) => e.code === 'OUTSIDE_SCHEDULE', 'no hold approval said so');
  const refund = { type: 'refund', itemId: 'i2', title: 'Boat', cents: 100, captureId: 'C1' };
  const r = await createProposal({ id: 'p2', tripId: 't1', kind: 'settle', summary: 'x', actions: [refund], now });
  r.status = 'confirmed'; r.confirmation = { by: 'schedule', at: now, digest: r.digest };
  await assert.rejects(assertMayMove(r, refund, 0, now, ctx), (e) => e.code === 'OUTSIDE_SCHEDULE', 'a schedule only ever charges items on their day');
});

test('item 1: a trip approved before this existed is not charged by a schedule nobody signed', async () => {
  const ctx = setup();
  await booked(ctx);
  const s = state(ctx); delete s.settlement; await ctx.store.put(s);
  ctx.clock.t = at('2026-05-06');
  assert.equal((await ctx.engine.settleDue()).captured, 0);
  assert.equal(ctx.fake.caps.size, 0);
});

test('item 1: a charge PayPal refuses is tried again next time from what really happened, and never twice', async () => {
  const ctx = setup();
  await booked(ctx);
  const real = ctx.fake.fetchImpl; let down = true;
  const flaky = async (url, init = {}) => (down && init.method === 'POST' && /capture$/.test(new URL(url).pathname) ? new Response(JSON.stringify({ name: 'X', message: 'PayPal is down' }), { status: 503 }) : real(url, init));
  const engine = createEngine({ store: ctx.store, paypal: createPayPal({ clientId: 'i', secret: 's', fetchImpl: flaky }), ai: planner(PLAN), now: () => ctx.clock.t });
  ctx.clock.t = at('2026-05-04');
  assert.equal((await engine.settleDue()).captured, 0);
  assert.equal(ctx.fake.caps.size, 0);
  assert.equal(state(ctx).activeProposal === null || state(ctx).proposals[state(ctx).activeProposal].kind !== 'settle', true, 'a failed charge does not block the person');
  down = false;
  assert.equal((await engine.settleDue()).captured, 1);
  assert.equal((await engine.settleDue()).captured, 0);
  assert.equal(ctx.fake.caps.size, 1);
});

test('item 1: charging on the day never disturbs a change that is waiting for the person', async () => {
  const ctx = setup();
  await booked(ctx);
  ctx.clock.t = Date.parse('2026-05-04T08:50:00Z'); // ten minutes before the apartment's day starts to count
  const out = await ctx.engine.submitEdit({ ops: [{ op: 'set_travelers', travelers: ['Ana', 'Ben', 'Cy', 'Dee'] }] });
  assert.equal(out.outcome, 'proposed');
  const waiting = active(ctx);
  ctx.clock.t = at('2026-05-04');
  await ctx.engine.settleDue();
  assert.equal(state(ctx).activeProposal, waiting.id);
  assert.equal(state(ctx).proposals[waiting.id].status, 'pending');
  await ctx.engine.confirm(waiting.id, waiting.digest);
  assert.equal(state(ctx).plan.travelers.includes('Dee'), true);
});

test('item 1: a hold PayPal no longer has is found when it is time to charge', async () => {
  const ctx = setup();
  const authId = await booked(ctx);
  ctx.fake.voidOutside(authId);
  ctx.clock.t = at('2026-05-04');
  assert.equal((await ctx.engine.settleDue()).captured, 0);
  const v = ctx.engine.view(state(ctx), { owner: true });
  assert.equal(v.holdLost.short.length, 3);
});

test('item 1: something the traveler said must be paid in advance is still charged when it is booked, and never again', async () => {
  const plan = structuredClone(PLAN); plan.items[1].prepaid = true;
  const ctx = setup(plan);
  const authId = await booked(ctx);
  assert.equal(ctx.fake.caps.size, 1);
  assert.equal(itemState(state(ctx).ledger, itemId(ctx, 'boat')).paidCents, 18000);
  ctx.clock.t = at('2026-05-06');
  await ctx.engine.settleDue();
  assert.equal(ctx.fake.caps.size, 3, 'two more: the apartment and Sintra');
  assert.equal(authority(ctx, authId).status, 'CAPTURED');
  assert.equal((await ctx.engine.reconcile()).allMatch, true);
});

test('item 1: a real alarm does it: with nobody asking, the hold is charged for what is due today', async () => {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const clock = { t: at('2026-05-04') }; // the first day of the trip is today
  const w = fakeEnv({ ai: planner(PLAN), paypal, run: scriptedModel([{ text: 'unused' }]), sources: fakeSources(), now: () => clock.t });
  const id = 'ab'.repeat(12); const token = 'owner-secret';
  const trip = w.env.TRIP.get(id);
  assert.ok((await trip.call('createTrip', [id, { prompt: PROMPT, startDate: START, ownerTokenHash: await sha256Hex(token) }])).ok);
  const mine = (m, a = []) => trip.call(m, a, token);
  const p = (await mine('view')).v.proposal;
  assert.ok((await mine('confirm', [p.id, p.digest])).ok);
  const o = await mine('createOrder', [p.id]);
  assert.ok((await mine('approveOrder', [p.id, o.v.orderId])).ok);
  const deadline = Date.now() + 4000;
  let paid = 0;
  while (Date.now() < deadline && !paid) { await new Promise((r) => setTimeout(r, 25)); paid = (await mine('view')).v.totals.paidCents; }
  assert.equal(paid, 54000, 'the alarm charged the apartment, whose day it is');
  assert.equal(fake.caps.size, 1);
  w.stop();
});
