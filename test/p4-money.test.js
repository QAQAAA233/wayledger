import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { createProposal, confirmByMandate, assertMayMove } from '../src/domain/proposal.js';
import { createMandate } from '../src/domain/mandate.js';
import { paypalEffect, describeEffect } from '../src/domain/describe.js';
import { itemState } from '../src/domain/ledger.js';
import { PROPOSAL_TTL_MS } from '../src/domain/proposal.js';
import { fakePayPalFetch, makeEngine, newTrip, checkoutAsBuyer, planner, SAMPLE_PLAN } from './helpers.js';

// Second-round review, findings 1 and 2: what a change really does to the money is told by one rule everywhere, and a
// change to who pays what is never the agent's to make alone.
const MONEY = /POST .*\/(orders|authorize|capture|void|refund)/;
const HOUR = 3_600_000;
function setup(raw = SAMPLE_PLAN) {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  return { fake, paypal, ...makeEngine({ ai: planner(raw), paypal }) };
}
const state = (ctx) => ctx.store.peek();
const active = (ctx) => state(ctx).proposals[state(ctx).activeProposal];
const itemId = (ctx, part) => state(ctx).plan.items.find((i) => i.title.includes(part)).id;
const moneyCalls = (ctx) => ctx.fake.calls.filter((c) => MONEY.test(c)).length;
async function booked(ctx, terms) {
  await newTrip(ctx);
  if (terms) await ctx.engine.setMandateTerms(terms);
  await checkoutAsBuyer(ctx);
}
const LIMITS = (ctx, over = {}) => ({ enabled: true, refundCapCents: 100000, planIncreaseCapCents: 21000, validUntil: ctx.clock.t + 5 * 24 * HOUR, ...over });
const ALL = ['Ana', 'Ben', 'Cy'];

// ---- finding 1: a charge is a charge ----------------------------------------------------------------------------------

test('finding 1: a prepaid item added inside the limits is a real charge, so it waits for the person and the screen says so', async () => {
  const ctx = setup();
  await booked(ctx, LIMITS(ctx));
  const before = moneyCalls(ctx);
  const out = await ctx.engine.submitEdit({ ops: [{ op: 'add', item: { day: 3, title: 'Sailing lesson', category: 'activity', amount: 100, prepaid: true, participants: ALL } }] });
  assert.equal(out.outcome, 'proposed', 'it would have charged $100 of the person\'s money without a yes');
  assert.ok(out.mandate.reasons.some((r) => r.code === 'CHARGE_IS_YOURS'), JSON.stringify(out.mandate.reasons));
  assert.equal(moneyCalls(ctx), before, 'PayPal was not called');
  const view = ctx.engine.view(state(ctx), { owner: true });
  assert.match(view.proposal.effectText, /charge \$100\.00/, 'the proposal tells the truth about PayPal');
  assert.equal(view.proposal.mostCanMoveCents, 10000);
  assert.doesNotMatch(view.proposal.effectText, /stays inside your trip hold/);

  // the person can say yes, and then exactly that charge happens
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  assert.equal(moneyCalls(ctx), before + 1);
  assert.equal(itemState(state(ctx).ledger, state(ctx).plan.items.find((i) => i.title === 'Sailing lesson').id).paidCents, 10000);
  assert.equal(state(ctx).mandate.used.refundCents, 0);
  assert.equal((await ctx.engine.reconcile()).allMatch, true);
});

test('finding 1: a price rise on something already charged is a charge too', async () => {
  const ctx = setup();
  await booked(ctx, LIMITS(ctx, { planIncreaseCapCents: 21000 }));
  const before = moneyCalls(ctx);
  const out = await ctx.engine.submitEdit({ ops: [{ op: 'reprice', itemId: itemId(ctx, 'apartment'), amount: 600 }] });
  assert.equal(out.outcome, 'proposed');
  assert.ok(out.mandate.reasons.some((r) => r.code === 'CHARGE_IS_YOURS'));
  assert.equal(moneyCalls(ctx), before);
  assert.match(ctx.engine.view(state(ctx), { owner: true }).proposal.effectText, /charge \$60\.00/);
});

test('finding 1: the one description of PayPal\'s effect counts every way money is charged', () => {
  assert.equal(paypalEffect([{ type: 'allocate', itemId: 'i9', cents: 20000, captureAfter: true }]).chargeCents, 20000);
  assert.equal(paypalEffect([{ type: 'allocate', itemId: 'i9', cents: 20000, captureAfter: false }]).chargeCents, 0);
  assert.equal(paypalEffect([{ type: 'hold', itemId: 'i9', cents: 5000, captureAfter: true }]).chargeCents, 5000);
  assert.match(describeEffect([{ type: 'allocate', itemId: 'i9', title: 'x', cents: 20000, captureAfter: true }]), /charge \$200\.00/);
  assert.equal(describeEffect([]), 'No money moves.');
});

test('finding 1: even if a proposal slipped through, the gate in front of PayPal refuses to charge under the signed limits', async () => {
  const now = 5_000_000;
  const mandate = await createMandate({ tripId: 't1', terms: { enabled: true, refundCapCents: 50000, planIncreaseCapCents: 50000, validUntil: now + HOUR }, baselineTotalCents: 84000, proposalId: 'p0', now });
  const action = { type: 'allocate', itemId: 'i9', title: 'Sailing lesson', cents: 10000, authId: 'AUTH1', captureAfter: true, why: 'added to the plan' };
  const p = await createProposal({ id: 'p1', tripId: 't1', kind: 'change', summary: 'x', actions: [action], newPlan: { items: [] }, now });
  await confirmByMandate(p, mandate, { within: true, refundCents: 0 }, now); // a bug somewhere upstream said it was fine
  await assert.rejects(assertMayMove(p, action, 0, now, { mandate }), (e) => e.code === 'OUTSIDE_MANDATE' && /charg/i.test(e.message));
});

// ---- finding 2: who pays what ----------------------------------------------------------------------------------------

test('finding 2: a new traveler, with or without signed limits, waits for the person; confirming applies it and moves no money', async () => {
  for (const terms of [null, { enabled: false }]) {
    const ctx = setup();
    await booked(ctx, terms ? terms : LIMITS(ctx));
    const before = moneyCalls(ctx);
    const out = await ctx.engine.submitEdit({ ops: [{ op: 'set_travelers', travelers: [...ALL, 'Dee'] }] });
    assert.equal(out.outcome, 'proposed', JSON.stringify(terms));
    assert.ok(out.mandate.reasons.some((r) => r.code === 'SPLIT_IS_YOURS'));
    assert.deepEqual(state(ctx).plan.travelers, ALL, 'the plan has not changed');
    const p = active(ctx);
    assert.deepEqual([p.status, p.actions.length], ['pending', 0]);
    assert.match(ctx.engine.view(state(ctx), { owner: true }).proposal.summary, /Dee joins the trip/);
    await ctx.engine.confirm(p.id, p.digest);
    assert.deepEqual(state(ctx).plan.travelers, [...ALL, 'Dee']);
    assert.equal(moneyCalls(ctx), before, 'no PayPal call for a change that moves no money');
    assert.equal(state(ctx).proposals[p.id].status, 'executed');
  }
});

test('finding 2: changing who shares an item waits, even when no money moves and the limits are off', async () => {
  const ctx = setup();
  await booked(ctx, { enabled: false });
  const sintra = itemId(ctx, 'Sintra');
  const out = await ctx.engine.submitEdit({ ops: [{ op: 'update_item', itemId: sintra, participants: ['Cy'] }] });
  assert.equal(out.outcome, 'proposed');
  assert.deepEqual(state(ctx).plan.items.find((i) => i.id === sintra).participants, ['Ana', 'Ben'], 'Cy does not pay for everything on a paste');
  assert.deepEqual(out.mandate.reasons.map((r) => r.code).sort(), ['NO_MANDATE', 'SPLIT_IS_YOURS']);
});

test('finding 2: a change that moves no money is judged by the same limits as every other change', async () => {
  const ctx = setup();
  await booked(ctx, { enabled: false });
  const out = await ctx.engine.submitEdit({ ops: [{ op: 'update_item', itemId: itemId(ctx, 'boat'), title: 'Sunset sail' }] });
  assert.equal(out.outcome, 'proposed', 'with no limits signed every change waits, as the screen says');
  const signed = setup();
  await booked(signed, LIMITS(signed));
  const ok = await signed.engine.submitEdit({ ops: [{ op: 'update_item', itemId: itemId(signed, 'boat'), title: 'Sunset sail' }] });
  assert.equal(ok.outcome, 'executed', 'inside signed limits a rename goes ahead on its own');
  assert.equal(state(signed).plan.items.some((i) => i.title === 'Sunset sail'), true);
  assert.equal(state(signed).proposals[ok.proposalId].confirmation.by, 'mandate');
});

test('finding 2: an item added for fewer people than the whole trip is a change of who pays; a replacement shared like the one it replaces is not', async () => {
  const ctx = setup();
  await booked(ctx, LIMITS(ctx));
  const sub = await ctx.engine.submitEdit({ ops: [{ op: 'add', item: { day: 3, title: 'Sintra lunch', category: 'food', amount: 60, participants: ['Ana'] } }] });
  assert.equal(sub.outcome, 'proposed');
  assert.ok(sub.mandate.reasons.some((r) => r.code === 'SPLIT_IS_YOURS'));
  const swap = await ctx.engine.submitEdit({ ops: [{ op: 'remove', itemId: itemId(ctx, 'Sintra') }, { op: 'add', item: { day: 3, title: 'Pena Palace', category: 'transport', amount: 120, participants: ['Ana', 'Ben'], prepaid: false } }] });
  assert.equal(swap.outcome, 'executed', JSON.stringify(swap.mandate?.reasons));
});

test('finding 2: refreshing a proposal that waits for the person never applies it, and keeps the cost warning and the reasons', async () => {
  const ctx = setup();
  ctx.clock.t = Date.parse('2026-05-01T09:00:00Z');
  await booked(ctx, LIMITS(ctx));
  const out = await ctx.engine.submitEdit({ ops: [{ op: 'set_travelers', travelers: [...ALL, 'Dee'] }] });
  const first = active(ctx);
  ctx.clock.t += PROPOSAL_TTL_MS + 60_000;
  await ctx.engine.refreshProposal(first.id);
  assert.deepEqual(state(ctx).plan.travelers, ALL, 'the refresh is not a yes');
  const again = active(ctx);
  assert.notEqual(again.id, first.id);
  assert.equal(again.status, 'pending');
  assert.deepEqual(again.outside.map((r) => r.code), out.mandate.reasons.map((r) => r.code), 'the reasons it waits are still shown');

  // the same for the warning about what a cancellation costs at the operator
  const ctx2 = setup();
  ctx2.clock.t = Date.parse('2026-05-01T09:00:00Z');
  await booked(ctx2, LIMITS(ctx2));
  await ctx2.engine.addDocument('Sintra day trip: non-refundable from the moment of booking.');
  await ctx2.engine.recordPolicy({ docId: 'd1', itemId: itemId(ctx2, 'Sintra'), quote: 'Sintra day trip: non-refundable from the moment of booking.', nonRefundable: true });
  await ctx2.engine.submitEdit({ ops: [{ op: 'remove', itemId: itemId(ctx2, 'Sintra') }], agentNote: 'cancel it' });
  const p1 = active(ctx2);
  assert.equal(p1.operatorLoss[0].lossCents, 12000);
  ctx2.clock.t += PROPOSAL_TTL_MS + 60_000;
  await ctx2.engine.refreshProposal(p1.id);
  const p2 = active(ctx2);
  assert.equal(p2.operatorLoss?.[0]?.lossCents, 12000, 'the refreshed proposal still says it costs $120 at the operator');
  assert.ok(p2.outside?.some((r) => r.code === 'LOSS_TO_OPERATOR'));
  assert.equal(p2.agentNote, 'cancel it');
});

// ---- the engine without limits and without a ledger stays usable ------------------------------------------------------

test('before the first approval nothing is signed, so the person\'s own words change the plan at once', async () => {
  const ctx = setup();
  await newTrip(ctx);
  const out = await ctx.engine.submitEdit({ ops: [{ op: 'set_travelers', travelers: [...ALL, 'Dee'] }] });
  assert.equal(out.outcome, 'updated');
  assert.deepEqual(state(ctx).plan.travelers, [...ALL, 'Dee']);
  assert.ok(active(ctx).actions.length > 0, 'the checkout is ready again');
});
