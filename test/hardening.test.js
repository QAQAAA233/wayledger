import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { PROPOSAL_TTL_MS } from '../src/domain/proposal.js';
import { reconcile, appendFact } from '../src/domain/ledger.js';
import { fakePayPalFetch, makeEngine, newTrip, checkoutAsBuyer, planner, SAMPLE_PLAN } from './helpers.js';

const MONEY = /POST .*\/(authorize|capture|void|refund)/;

function setup(raw = SAMPLE_PLAN) {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const script = { modelCalls: 0 };
  const ai = { planTrip: async (_p, validate) => { script.modelCalls++; return validate(structuredClone(raw)); } };
  return { fake, script, ...makeEngine({ ai, paypal }) };
}
const active = (ctx) => ctx.store.peek().proposals[ctx.store.peek().activeProposal];
const idOf = (ctx, part) => ctx.store.peek().plan.items.find((i) => i.title.includes(part)).id;

async function booked(ctx) {
  await newTrip(ctx);
  await ctx.engine.setMandateTerms({ enabled: false });
  await checkoutAsBuyer(ctx);
}

// ---- an expired proposal can no longer authorize, and there is a way forward (review 9) -----------------------------

test('a buyer who approves in PayPal after the proposal expired does not get an authorization', async () => {
  const ctx = setup();
  await newTrip(ctx);
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  const { orderId } = await ctx.engine.createOrder(p.id);

  ctx.clock.t += PROPOSAL_TTL_MS + 11_000; // the PayPal window stayed open past the expiry
  await assert.rejects(ctx.engine.approveOrder(p.id, orderId), (e) => e.code === 'EXPIRED');

  const s = ctx.store.peek();
  assert.equal(s.proposals[p.id].status, 'expired');
  assert.equal(s.ledger.length, 0, 'nothing reached the ledger');
  assert.deepEqual(ctx.fake.calls.filter((c) => MONEY.test(c)), [], 'PayPal was never asked to authorize or charge');
  assert.match(s.events.at(-1).text, /expired/i);
});

test('with prepaid lodging the expired approval cannot leave an authorization with a stuck proposal behind', async () => {
  const ctx = setup();
  await newTrip(ctx);
  const p = active(ctx);
  assert.ok(p.actions.some((a) => a.captureAfter), 'the sample plan prepays lodging');
  await ctx.engine.confirm(p.id, p.digest);
  const { orderId } = await ctx.engine.createOrder(p.id);
  ctx.clock.t += PROPOSAL_TTL_MS + 1;
  await assert.rejects(ctx.engine.approveOrder(p.id, orderId), (e) => e.code === 'EXPIRED');
  assert.notEqual(ctx.store.peek().proposals[p.id].status, 'failed');
  assert.equal(ctx.fake.auths.size, 0);
});

test('creating the PayPal order for an expired confirmed proposal is refused and marks it expired', async () => {
  const ctx = setup();
  await newTrip(ctx);
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  ctx.clock.t += PROPOSAL_TTL_MS + 1;
  await assert.rejects(ctx.engine.createOrder(p.id), (e) => e.code === 'EXPIRED');
  assert.equal(ctx.store.peek().proposals[p.id].status, 'expired');
  assert.equal(ctx.fake.orders.size, 0, 'no PayPal order was created');
});

test('refreshing an expired checkout proposal works the same money out again without calling the model, and then completes', async () => {
  const ctx = setup();
  await newTrip(ctx);
  const first = active(ctx);
  ctx.clock.t += PROPOSAL_TTL_MS + 5_000;
  await assert.rejects(ctx.engine.confirm(first.id, first.digest), (e) => e.code === 'EXPIRED');

  const modelCallsBefore = ctx.script.modelCalls;
  await ctx.engine.refreshProposal(first.id);
  const fresh = active(ctx);
  assert.equal(ctx.script.modelCalls, modelCallsBefore, 'no model call');
  assert.notEqual(fresh.id, first.id);
  assert.equal(ctx.store.peek().proposals[first.id].status, 'superseded');
  assert.equal(fresh.status, 'pending');
  assert.ok(fresh.expiresAt > ctx.clock.t);
  assert.deepEqual(fresh.actions, first.actions);
  assert.notEqual(fresh.digest, first.digest);

  await ctx.engine.confirm(fresh.id, fresh.digest);
  const { orderId } = await ctx.engine.createOrder(fresh.id);
  await ctx.engine.approveOrder(fresh.id, orderId);
  assert.equal(ctx.store.peek().proposals[fresh.id].status, 'executed');
});

test('refreshing a change proposal recomputes it against the current ledger and keeps the staged plan', async () => {
  const ctx = setup();
  await booked(ctx);
  const boat = idOf(ctx, 'boat');
  await ctx.engine.submitEdit({ ops: [{ op: 'reprice', itemId: boat, amount: 150 }], agentNote: 'cheaper boat' });
  const first = active(ctx);
  ctx.clock.t += PROPOSAL_TTL_MS + 1;
  const calls = ctx.script.modelCalls;
  await ctx.engine.refreshProposal(first.id);
  const fresh = active(ctx);
  assert.equal(ctx.script.modelCalls, calls);
  assert.equal(fresh.kind, 'change');
  assert.deepEqual(fresh.actions.map((a) => [a.type, a.cents]), first.actions.map((a) => [a.type, a.cents]));
  assert.deepEqual(fresh.newPlan, first.newPlan);
  assert.equal(fresh.agentNote, 'cheaper boat', 'the note travels with it, still labelled as the agent\'s');
  await ctx.engine.confirm(fresh.id, fresh.digest);
  assert.equal(ctx.store.peek().plan.items.find((i) => i.id === boat).amountCents, 15000);
});

test('only an unexecuted active proposal can be refreshed', async () => {
  const ctx = setup();
  await booked(ctx);
  const done = Object.values(ctx.store.peek().proposals).at(-1);
  assert.equal(done.status, 'executed');
  await assert.rejects(ctx.engine.refreshProposal(done.id), (e) => e.code === 'NOT_REFRESHABLE');
  await assert.rejects(ctx.engine.refreshProposal('nope'), (e) => e.code === 'NOT_FOUND');
});

// ---- a trip has an ended state (review 6) ----------------------------------------------------------------------------

test('closing the trip ends it: changes and a second close are refused and PayPal is not touched', async () => {
  const ctx = setup();
  await booked(ctx);
  await ctx.engine.closeTrip();
  const p = active(ctx);
  assert.equal(p.kind, 'close');
  assert.equal(ctx.engine.view(ctx.store.peek()).closed, false, 'not closed until the close proposal executes');
  await ctx.engine.confirm(p.id, p.digest);

  const view = ctx.engine.view(ctx.store.peek());
  assert.equal(view.closed, true);
  assert.equal(typeof view.closedAt, 'number');
  assert.equal(view.canClose, false);

  const moneyBefore = ctx.fake.calls.filter((c) => MONEY.test(c)).length;
  await assert.rejects(ctx.engine.submitEdit({ ops: [{ op: 'add', item: { day: 3, title: 'Spa', category: 'activity', amount: 40, participants: ['Ana'] } }] }), (e) => e.code === 'TRIP_CLOSED');
  await assert.rejects(ctx.engine.closeTrip(), (e) => e.code === 'TRIP_CLOSED');
  await assert.rejects(ctx.engine.addDocument('Some booking terms that are long enough.'), (e) => e.code === 'TRIP_CLOSED');
  assert.equal(ctx.fake.calls.filter((c) => MONEY.test(c)).length, moneyBefore);
});

test('a close proposal names the planned items that were never funded, and they are part of what was confirmed', async () => {
  const ctx = setup();
  await booked(ctx);
  // An item that is in the plan but never got PayPal funding (the state a stale approval used to leave behind).
  const s = ctx.store.peek();
  s.plan.items.push({ id: 'i9', day: 3, title: 'Ghibli Museum', category: 'activity', amountCents: 4000, participants: ['Ana', 'Ben', 'Cy'], prepaid: false });
  await ctx.store.put(s);

  await ctx.engine.closeTrip();
  const p = active(ctx);
  assert.deepEqual(p.unfunded, [{ itemId: 'i9', title: 'Ghibli Museum', cents: 4000 }]);
  await ctx.engine.confirm(p.id, p.digest);
  assert.equal(ctx.store.peek().proposals[p.id].status, 'executed');
});

test('a close proposal without unfunded items has the same digest recipe as before', async () => {
  const ctx = setup();
  await booked(ctx);
  await ctx.engine.closeTrip();
  assert.equal('unfunded' in active(ctx), false);
});

test('a trip that was never booked cannot be closed; a booked trip with nothing left to settle closes at once', async () => {
  const ctx = setup();
  await newTrip(ctx);
  await assert.rejects(ctx.engine.closeTrip(), (e) => e.code === 'NOTHING_TO_CLOSE');

  // Only prepaid lodging: after checkout everything is already charged, so no proposal is needed to close.
  const lodgingOnly = setup({ ...SAMPLE_PLAN, items: [SAMPLE_PLAN.items[0]] });
  await booked(lodgingOnly);
  assert.equal(lodgingOnly.engine.view(lodgingOnly.store.peek()).canClose, true);
  const moneyBefore = lodgingOnly.fake.calls.filter((c) => MONEY.test(c)).length;
  await lodgingOnly.engine.closeTrip();
  const view = lodgingOnly.engine.view(lodgingOnly.store.peek());
  assert.equal(view.closed, true);
  assert.equal(view.proposal, null);
  assert.equal(lodgingOnly.fake.calls.filter((c) => MONEY.test(c)).length, moneyBefore, 'closing moved no money');
});

// ---- what the buyer sees in PayPal (review 4) --------------------------------------------------------------------------

test('the PayPal order asks for no shipping address and shows the product name; the card button keeps the same settings', async () => {
  const ctx = setup();
  await newTrip(ctx);
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  await ctx.engine.createOrder(p.id);
  const wallet = [...ctx.fake.orders.values()].at(-1).body;
  assert.deepEqual(wallet.payment_source.paypal.experience_context, { brand_name: 'Wayledger', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' });
  assert.equal(wallet.application_context, undefined);
  assert.equal(wallet.purchase_units[0].custom_id, 't1', 'every order carries the trip id so PayPal events find their trip');

  await ctx.engine.createOrder(p.id, 'card');
  const card = [...ctx.fake.orders.values()].at(-1).body;
  assert.deepEqual(card.application_context, { brand_name: 'Wayledger', shipping_preference: 'NO_SHIPPING' });
  assert.equal(card.payment_source, undefined);
});

// ---- the PayPal record count matches what is shown, voids included (review 8) -----------------------------------------

test('reconcile counts a void as its own PayPal record and flags it when PayPal does not say VOIDED', async () => {
  const ctx = setup();
  await booked(ctx);
  // Leave unused hold so that closing voids part of the authorization.
  await ctx.engine.submitEdit({ ops: [{ op: 'remove', itemId: idOf(ctx, 'boat') }] });
  const change = active(ctx);
  await ctx.engine.confirm(change.id, change.digest);
  await ctx.engine.closeTrip();
  const close = active(ctx);
  assert.ok(close.actions.some((a) => a.type === 'void'));
  await ctx.engine.confirm(close.id, close.digest);

  const s = ctx.store.peek();
  const paypalFacts = s.ledger.filter((f) => ['authorize', 'capture', 'void', 'refund'].includes(f.op));
  const rec = await ctx.engine.reconcile();
  assert.equal(rec.allMatch, true, JSON.stringify(rec));
  assert.equal(rec.rows.length, paypalFacts.length, 'one verified record for every PayPal fact in the ledger');
  assert.ok(rec.rows.some((r) => r.op === 'void' && r.match));

  const authId = s.ledger.find((f) => f.op === 'void').id;
  const remote = Object.fromEntries(s.ledger.filter((f) => ['authorize', 'capture', 'refund'].includes(f.op)).map((f) => [f.id, { status: f.status, cents: f.cents }]));
  remote[authId] = { status: 'CREATED', cents: remote[authId].cents };
  assert.equal(reconcile(s.ledger, remote).rows.find((r) => r.op === 'void').match, false);
});

test('reconcile row for a void is absent when nothing was voided', () => {
  const ledger = [];
  appendFact(ledger, { op: 'authorize', itemId: '_reserve', id: 'A1', status: 'CREATED', cents: 1000, at: 1 });
  assert.equal(reconcile(ledger, { A1: { status: 'CREATED', cents: 1000 } }).rows.some((r) => r.op === 'void'), false);
});

void planner;
