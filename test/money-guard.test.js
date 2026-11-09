import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { assertMayMove, confirmProposal, confirmByMandate, createProposal, MoneyGuardError, PROPOSAL_TTL_MS } from '../src/domain/proposal.js';
import { createMandate, evaluateMandate } from '../src/domain/mandate.js';
import { fakePayPalFetch, makeEngine, newTrip, planner } from './helpers.js';

const MONEY_CALL = /\/(orders|authorize|capture|void|refund)/;
const moneyCalls = (calls) => calls.filter((c) => c.startsWith('POST') && MONEY_CALL.test(c));
const setup = () => {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  return { fake, ...makeEngine({ ai: planner(), paypal }) };
};

test('nothing is confirmed -> PayPal is never asked to move money', async () => {
  const { engine, store, fake } = setup();
  await newTrip({ engine });
  const p = store.peek().proposals[store.peek().activeProposal];
  assert.equal(p.status, 'pending');
  await assert.rejects(engine.createOrder(p.id), /Confirm the proposal/);
  await assert.rejects(engine.approveOrder(p.id, 'ORDER1'), /not waiting for PayPal approval/);
  assert.deepEqual(moneyCalls(fake.calls), []);
  assert.equal(store.peek().ledger.length, 0);
});

test('a confirmation only counts for the exact digest the person was shown', async () => {
  const { engine, store, fake } = setup();
  await newTrip({ engine });
  const p = store.peek().proposals[store.peek().activeProposal];
  await assert.rejects(engine.confirm(p.id, 'not-the-digest'), (e) => e.code === 'STALE_VIEW');
  assert.equal(store.peek().proposals[p.id].status, 'pending');
  assert.deepEqual(moneyCalls(fake.calls), []);
});

test('an expired proposal cannot be confirmed', async () => {
  const { engine, store, clock } = setup();
  await newTrip({ engine });
  const p = store.peek().proposals[store.peek().activeProposal];
  clock.t += PROPOSAL_TTL_MS + 1;
  await assert.rejects(engine.confirm(p.id, p.digest), (e) => e.code === 'EXPIRED');
});

test('the executor refuses unconfirmed, tampered, expired, foreign and over-cap actions', async () => {
  const action = { type: 'void', itemId: 'i2', title: 'x', cents: 10000, authId: 'A1' };
  const base = await createProposal({ id: 'p', tripId: 't', kind: 'change', summary: 's', actions: [action, { ...action, itemId: 'i3', authId: 'A2' }], now: 0 });
  await assert.rejects(assertMayMove(base, action, 0, 1), (e) => e.code === 'NOT_CONFIRMED');
  await confirmProposal(base, base.digest, 1);
  await assertMayMove(base, action, 0, 2); // ok once confirmed

  const tampered = structuredClone(base); tampered.actions[0].cents = 99999;
  await assert.rejects(assertMayMove(tampered, tampered.actions[0], 0, 2), (e) => e.code === 'TAMPERED');
  await assert.rejects(assertMayMove(base, action, 0, PROPOSAL_TTL_MS + 5), (e) => e.code === 'EXPIRED');
  await assert.rejects(assertMayMove(base, { ...action, authId: 'OTHER' }, 0, 2), (e) => e.code === 'NOT_IN_PROPOSAL');
  await assert.rejects(assertMayMove(base, action, base.capCents, 2), (e) => e instanceof MoneyGuardError && e.code === 'OVER_CAP');
});

test('a proposal that already started may finish after it expired, one that never started may not', async () => {
  const action = { type: 'refund', itemId: 'i2', title: 'x', cents: 10000, captureId: 'C1' };
  const base = await createProposal({ id: 'p', tripId: 't', kind: 'change', summary: 's', actions: [action], now: 0 });
  await confirmProposal(base, base.digest, 1);
  await assert.rejects(assertMayMove(base, action, 0, PROPOSAL_TTL_MS + 5), (e) => e.code === 'EXPIRED');
  await assertMayMove(base, action, 0, PROPOSAL_TTL_MS + 5, { allowExpired: true });
});

// ---- the signed mandate -----------------------------------------------------------------------------------------

const TERMS = { enabled: true, refundCapCents: 20000, planIncreaseCapCents: 5000, validUntil: 10_000_000 };
const mandateFor = (extra = {}) => createMandate({ tripId: 't', terms: { ...TERMS, ...extra }, baselineTotalCents: 84000, proposalId: 'p0', now: 1000 });

test('the mandate confirms a change only when code finds it inside the limits, and the gate re-checks every step', async () => {
  const mandate = await mandateFor();
  const refund = { type: 'refund', itemId: 'i1', title: 'x', cents: 12000, captureId: 'C1' };
  const ev = evaluateMandate(mandate, { actions: [refund], planAfterTotalCents: 84000 - 12000, now: 2000 });
  assert.equal(ev.within, true);
  const p = await createProposal({ id: 'p', tripId: 't', kind: 'change', summary: 's', actions: [refund], now: 2000 });
  await confirmByMandate(p, mandate, ev, 2000);
  assert.deepEqual([p.status, p.confirmation.by], ['confirmed', 'mandate']);
  await assertMayMove(p, refund, 0, 2500, { mandate, refundedSoFarCents: 0 });

  // the same step with a mandate that has no room left is refused by the gate, not just at proposal time
  const forged = structuredClone(mandate); forged.terms.refundCapCents = 99_999_999;
  await assert.rejects(assertMayMove(p, refund, 0, 2500, { mandate: forged }), (e) => e.code === 'MANDATE_TAMPERED', 'changed limits no longer match their digest');
  const spent = structuredClone(mandate); spent.used.refundCents = 9000; // what was already refunded is bookkeeping, not part of the signed limits
  await assert.rejects(assertMayMove(p, refund, 0, 2500, { mandate: spent }), (e) => e.code === 'OUTSIDE_MANDATE');
  await assert.rejects(assertMayMove(p, refund, 0, 10_000_001, { mandate, allowExpired: true }), (e) => e.code === 'MANDATE_EXPIRED');
});

test('outside the limits: each reason is named, and a proposal outside them cannot be confirmed by the mandate', async () => {
  const mandate = await mandateFor();
  const big = { type: 'refund', itemId: 'i1', title: 'x', cents: 54000, captureId: 'C1' };
  const ev = evaluateMandate(mandate, { actions: [big], planAfterTotalCents: 84000 - 54000, now: 2000 });
  assert.equal(ev.within, false);
  assert.deepEqual(ev.reasons.map((r) => r.code), ['REFUND_OVER_LIMIT']);
  const p = await createProposal({ id: 'p', tripId: 't', kind: 'change', summary: 's', actions: [big], now: 2000 });
  await assert.rejects(confirmByMandate(p, mandate, ev, 2000), (e) => e.code === 'OUTSIDE_MANDATE');
  assert.equal(p.status, 'pending');

  const raise = evaluateMandate(mandate, { actions: [{ type: 'allocate', itemId: 'i9', title: 'x', cents: 9000, authId: 'A' }], planAfterTotalCents: 84000 + 9000, now: 2000 });
  assert.deepEqual(raise.reasons.map((r) => r.code), ['PLAN_INCREASE_OVER_LIMIT']);
  const hold = evaluateMandate(mandate, { actions: [{ type: 'hold', itemId: 'i9', title: 'x', cents: 1000 }], planAfterTotalCents: 84000, now: 2000 });
  assert.deepEqual(hold.reasons.map((r) => r.code), ['NEEDS_PAYPAL_APPROVAL']);
  const close = evaluateMandate(mandate, { actions: [{ type: 'capture', itemId: 'i9', title: 'x', cents: 1000, authId: 'A' }], planAfterTotalCents: 84000, now: 2000 });
  assert.deepEqual(close.reasons.map((r) => r.code), ['SETTLEMENT_IS_YOURS']);
  const budget = evaluateMandate(mandate, { actions: [{ type: 'release', itemId: 'i9', title: 'x', cents: 1000, authId: 'A' }], humanOnly: true, planAfterTotalCents: 84000, now: 2000 });
  assert.deepEqual(budget.reasons.map((r) => r.code), ['BUDGET_IS_YOURS']);
  const late = evaluateMandate(mandate, { actions: [{ type: 'release', itemId: 'i9', title: 'x', cents: 1000, authId: 'A' }], planAfterTotalCents: 84000, now: 10_000_000 });
  assert.deepEqual(late.reasons.map((r) => r.code), ['MANDATE_EXPIRED']);
  assert.deepEqual(evaluateMandate(null, { actions: [{ type: 'release', itemId: 'i9', title: 'x', cents: 1, authId: 'A' }], planAfterTotalCents: 1, now: 1 }).reasons.map((r) => r.code), ['NO_MANDATE']);
});

test('a mandate whose limits were edited after signing is refused', async () => {
  const mandate = await mandateFor();
  const refund = { type: 'refund', itemId: 'i1', title: 'x', cents: 1000, captureId: 'C1' };
  const ev = evaluateMandate(mandate, { actions: [refund], planAfterTotalCents: 83000, now: 2000 });
  const p = await createProposal({ id: 'p', tripId: 't', kind: 'change', summary: 's', actions: [refund], now: 2000 });
  const forged = structuredClone(mandate); forged.terms.refundCapCents = 99_999_999;
  await assert.rejects(confirmByMandate(p, forged, ev, 2000), (e) => e.code === 'MANDATE_TAMPERED');
});
