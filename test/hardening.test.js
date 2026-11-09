import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { PROPOSAL_TTL_MS } from '../src/domain/proposal.js';
import { itemState, reconcile, appendFact } from '../src/domain/ledger.js';
import { fakePayPalFetch, makeEngine, SAMPLE_PLAN } from './helpers.js';

const MONEY = /POST .*\/(authorize|capture|void|refund)/;

function setup() {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const script = { change: null, modelCalls: 0 };
  const ai = {
    planTrip: async (_p, validate) => { script.modelCalls++; return validate(SAMPLE_PLAN); },
    changeTrip: async (_plan, _t, validate) => { script.modelCalls++; return validate(script.change); },
  };
  return { fake, script, ...makeEngine({ ai, paypal }) };
}

const active = (ctx) => ctx.store.peek().proposals[ctx.store.peek().activeProposal];

async function checkout(ctx) {
  await ctx.engine.createTrip('t1', 'Lisbon');
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  const { orderId } = await ctx.engine.createOrder(p.id);
  await ctx.engine.approveOrder(p.id, orderId);
}

// ---- review item 9: an expired proposal can no longer authorize, and there is a way forward

test('a buyer who approves in PayPal after the proposal expired does not get an authorization', async () => {
  const ctx = setup();
  await ctx.engine.createTrip('t1', 'Lisbon');
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  const { orderId } = await ctx.engine.createOrder(p.id);

  ctx.clock.t += PROPOSAL_TTL_MS + 11_000; // the PayPal window stayed open past the expiry
  await assert.rejects(ctx.engine.approveOrder(p.id, orderId), (e) => e.code === 'EXPIRED');

  const s = ctx.store.peek();
  assert.equal(s.proposals[p.id].status, 'expired');
  assert.equal(s.ledger.length, 0, 'nothing reached the ledger');
  assert.deepEqual(ctx.fake.calls.filter((c) => MONEY.test(c)), [], 'PayPal was never asked to authorize or capture');
  assert.match(s.events.at(-1).text, /expired/i);
});

test('with prepaid lodging the expired approval cannot leave an authorization with a stuck proposal behind', async () => {
  const ctx = setup();
  await ctx.engine.createTrip('t1', 'Lisbon');
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
  await ctx.engine.createTrip('t1', 'Lisbon');
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  ctx.clock.t += PROPOSAL_TTL_MS + 1;
  await assert.rejects(ctx.engine.createOrder(p.id), (e) => e.code === 'EXPIRED');
  assert.equal(ctx.store.peek().proposals[p.id].status, 'expired');
  assert.equal(ctx.fake.orders.size, 0, 'no PayPal order was created');
});

test('refreshing an expired checkout proposal works the same money out again without calling the model, and then completes', async () => {
  const ctx = setup();
  await ctx.engine.createTrip('t1', 'Lisbon');
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
  await checkout(ctx);
  const boat = ctx.store.peek().plan.items.find((i) => i.title.includes('boat')).id;
  ctx.script.change = { summary: 'Cheaper boat.', operations: [{ op: 'reprice', itemId: boat, amount: 150 }] };
  await ctx.engine.requestChange('The boat tour got cheaper');
  const first = active(ctx);
  ctx.clock.t += PROPOSAL_TTL_MS + 1;
  const calls = ctx.script.modelCalls;
  await ctx.engine.refreshProposal(first.id);
  const fresh = active(ctx);
  assert.equal(ctx.script.modelCalls, calls);
  assert.equal(fresh.kind, 'change');
  assert.deepEqual(fresh.actions.map((a) => [a.type, a.cents]), first.actions.map((a) => [a.type, a.cents]));
  assert.deepEqual(fresh.newPlan, first.newPlan);
  await ctx.engine.confirm(fresh.id, fresh.digest);
  assert.equal(ctx.store.peek().plan.items.find((i) => i.id === boat).amountCents, 15000);
});

test('only an unexecuted active proposal can be refreshed', async () => {
  const ctx = setup();
  await checkout(ctx);
  const done = Object.values(ctx.store.peek().proposals)[0];
  assert.equal(done.status, 'executed');
  await assert.rejects(ctx.engine.refreshProposal(done.id), (e) => e.code === 'NOT_REFRESHABLE');
  await assert.rejects(ctx.engine.refreshProposal('nope'), (e) => e.code === 'NOT_FOUND');
});

// ---- review item 6: a trip has an ended state

test('closing the trip ends it: changes and a second close are refused and PayPal is not touched', async () => {
  const ctx = setup();
  await checkout(ctx);
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
  ctx.script.change = { summary: 'Add a spa.', operations: [{ op: 'add', item: { day: 3, title: 'Spa', category: 'activity', amount: 40, participants: ['Ana'] } }] };
  const modelCalls = ctx.script.modelCalls;
  await assert.rejects(ctx.engine.requestChange('Add a spa'), (e) => e.code === 'TRIP_CLOSED');
  await assert.rejects(ctx.engine.closeTrip(), (e) => e.code === 'TRIP_CLOSED');
  assert.equal(ctx.script.modelCalls, modelCalls, 'the model is not even asked');
  assert.equal(ctx.fake.calls.filter((c) => MONEY.test(c)).length, moneyBefore);
});

test('a close proposal names the planned items that were never funded, and they are part of what was confirmed', async () => {
  const ctx = setup();
  await checkout(ctx);
  // An item that is in the plan but never got PayPal funding (the state a stale approval used to leave behind).
  const s = ctx.store.peek();
  s.plan.items.push({ id: 'i9', day: 3, title: 'Ghibli Museum', category: 'activity', amountCents: 4000, participants: ['Ana', 'Ben', 'Cy'] });
  await ctx.store.put(s);

  await ctx.engine.closeTrip();
  const p = active(ctx);
  assert.deepEqual(p.unfunded, [{ itemId: 'i9', title: 'Ghibli Museum', cents: 4000 }]);
  const digestWith = p.digest;
  await ctx.engine.confirm(p.id, digestWith);
  assert.equal(ctx.store.peek().proposals[p.id].status, 'executed');
});

test('a close proposal without unfunded items has the same digest recipe as before', async () => {
  const ctx = setup();
  await checkout(ctx);
  await ctx.engine.closeTrip();
  assert.equal('unfunded' in active(ctx), false);
});

test('a trip that was never booked cannot be closed; a booked trip with nothing left to settle closes at once', async () => {
  const ctx = setup();
  await ctx.engine.createTrip('t1', 'Lisbon');
  await assert.rejects(ctx.engine.closeTrip(), (e) => e.code === 'NOTHING_TO_CLOSE');

  // Only prepaid lodging: after checkout everything is already charged, so no proposal is needed to close.
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const ai = { planTrip: async (_p, v) => v({ ...SAMPLE_PLAN, items: [SAMPLE_PLAN.items[0]] }), changeTrip: async () => { throw new Error('unused'); } };
  const lodgingOnly = makeEngine({ ai, paypal });
  await lodgingOnly.engine.createTrip('t2', 'Lisbon');
  const p = lodgingOnly.store.peek().proposals[lodgingOnly.store.peek().activeProposal];
  await lodgingOnly.engine.confirm(p.id, p.digest);
  const { orderId } = await lodgingOnly.engine.createOrder(p.id);
  await lodgingOnly.engine.approveOrder(p.id, orderId);
  assert.equal(lodgingOnly.engine.view(lodgingOnly.store.peek()).canClose, true);

  const moneyBefore = fake.calls.filter((c) => MONEY.test(c)).length;
  await lodgingOnly.engine.closeTrip();
  const view = lodgingOnly.engine.view(lodgingOnly.store.peek());
  assert.equal(view.closed, true);
  assert.equal(view.proposal, null);
  assert.equal(fake.calls.filter((c) => MONEY.test(c)).length, moneyBefore, 'closing moved no money');
});

// ---- review item 4: what the buyer sees in PayPal

test('the PayPal order asks for no shipping address and shows the product name; the card button keeps the same settings', async () => {
  const ctx = setup();
  await ctx.engine.createTrip('t1', 'Lisbon');
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  await ctx.engine.createOrder(p.id);
  const wallet = [...ctx.fake.orders.values()].at(-1);
  assert.deepEqual(wallet.payment_source.paypal.experience_context, { brand_name: 'Wayledger', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' });
  assert.equal(wallet.application_context, undefined);

  await ctx.engine.createOrder(p.id, 'card');
  const card = [...ctx.fake.orders.values()].at(-1);
  assert.deepEqual(card.application_context, { brand_name: 'Wayledger', shipping_preference: 'NO_SHIPPING' });
  assert.equal(card.payment_source, undefined);
});

// ---- review item 8: the PayPal record count matches what is shown, voids included

test('reconcile counts a void as its own PayPal record and flags it when PayPal does not say VOIDED', async () => {
  const ctx = setup();
  await checkout(ctx);
  // Leave unused reserve so that closing voids part of the authorization.
  const boat = ctx.store.peek().plan.items.find((i) => i.title.includes('boat')).id;
  ctx.script.change = { summary: 'No boat.', operations: [{ op: 'remove', itemId: boat }] };
  await ctx.engine.requestChange('Skip the boat');
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
  assert.equal(itemState(ledger, 'i1').status, 'planned');
});
