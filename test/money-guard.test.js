import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { assertMayMove, confirmProposal, createProposal, MoneyGuardError, PROPOSAL_TTL_MS } from '../src/domain/proposal.js';
import { fakePayPalFetch, makeEngine, SAMPLE_PLAN } from './helpers.js';

const MONEY_CALL = /\/(orders|authorize|capture|void|refund)/;
const moneyCalls = (calls) => calls.filter((c) => c.startsWith('POST') && MONEY_CALL.test(c));
const setup = () => {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const ai = { planTrip: async (_p, validate) => validate(SAMPLE_PLAN), changeTrip: async () => { throw new Error('unused'); } };
  return { fake, ...makeEngine({ ai, paypal }) };
};

test('nothing is confirmed -> PayPal is never asked to move money', async () => {
  const { engine, store, fake } = setup();
  await engine.createTrip('t1', 'Lisbon for three friends, $1200');
  const p = store.peek().proposals[store.peek().activeProposal];
  assert.equal(p.status, 'pending');
  await assert.rejects(engine.createOrder(p.id), /Confirm the proposal/);
  await assert.rejects(engine.approveOrder(p.id, 'ORDER1'), /not waiting for PayPal approval/);
  assert.deepEqual(moneyCalls(fake.calls), []);
  assert.equal(store.peek().ledger.length, 0);
});

test('a confirmation only counts for the exact digest the person was shown', async () => {
  const { engine, store, fake } = setup();
  await engine.createTrip('t1', 'Lisbon');
  const p = store.peek().proposals[store.peek().activeProposal];
  await assert.rejects(engine.confirm(p.id, 'not-the-digest'), (e) => e.code === 'STALE_VIEW');
  assert.equal(store.peek().proposals[p.id].status, 'pending');
  assert.deepEqual(moneyCalls(fake.calls), []);
});

test('an expired proposal cannot be confirmed', async () => {
  const { engine, store, clock } = setup();
  await engine.createTrip('t1', 'Lisbon');
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
