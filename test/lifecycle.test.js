import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { AIError } from '../src/ai.js';
import { toCents } from '../src/domain/money.js';
import { itemState } from '../src/domain/ledger.js';
import { fakePayPalFetch, makeEngine, SAMPLE_PLAN } from './helpers.js';

const MONEY = /POST .*\/(orders|authorize|capture|void|refund)/;

function setup({ failOn, skew } = {}) {
  const fake = fakePayPalFetch({ failOn, skew });
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const script = { change: null, aiError: null };
  const ai = {
    planTrip: async (_p, validate) => validate(SAMPLE_PLAN),
    changeTrip: async (_plan, _t, validate) => { if (script.aiError) throw script.aiError; return validate(script.change); },
  };
  return { fake, paypal, script, ...makeEngine({ ai, paypal }) };
}

async function checkout(ctx) {
  await ctx.engine.createTrip('t1', 'Lisbon');
  const p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  await ctx.engine.confirm(p.id, p.digest);
  const { orderId } = await ctx.engine.createOrder(p.id);
  await ctx.engine.approveOrder(p.id, orderId);
  return p.id;
}

async function confirmAndRun(ctx) {
  const p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  await ctx.engine.confirm(p.id, p.digest);
  if (p.actions.some((a) => a.type === 'hold')) {
    const { orderId } = await ctx.engine.createOrder(p.id);
    await ctx.engine.approveOrder(p.id, orderId);
  }
  return p.id;
}

test('checkout holds every item and captures only the prepaid lodging', async () => {
  const ctx = setup();
  await checkout(ctx);
  const s = ctx.store.peek();
  const states = Object.fromEntries(s.plan.items.map((i) => [i.title, itemState(s.ledger, i.id).status]));
  assert.deepEqual(states, { 'Alfama apartment (3 nights)': 'paid', 'Sunset boat tour': 'held', 'Sintra day trip': 'held' });
  assert.equal(s.proposals[Object.keys(s.proposals)[0]].status, 'executed');
});

test('weather change: void the held tour, add a replacement hold, refund a prepaid item', async () => {
  const ctx = setup();
  await checkout(ctx);
  const plan = ctx.store.peek().plan;
  const boat = plan.items.find((i) => i.title.includes('boat')).id;
  ctx.script.change = { summary: 'Storm on day 2: swapped the boat tour for the oceanarium.', operations: [{ op: 'remove', itemId: boat }, { op: 'add', item: { day: 2, title: 'Oceanarium tickets', category: 'activity', amount: 66, participants: ['Ana', 'Ben', 'Cy'] } }] };
  await ctx.engine.requestChange('It will storm on Saturday');
  let p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]), [['void', 18000], ['hold', 6600]]);
  assert.equal(p.netCents, 6600 - 18000);
  assert.equal(ctx.store.peek().plan.items.some((i) => i.title.includes('boat')), true, 'plan only changes once the money step finishes');
  await confirmAndRun(ctx);
  const s = ctx.store.peek();
  assert.equal(s.plan.items.some((i) => i.title.includes('boat')), false);
  assert.equal(itemState(s.ledger, boat).status, 'released');

  // the group drops the apartment: it was captured, so this must be a refund
  const apt = s.plan.items.find((i) => i.category === 'lodging').id;
  ctx.script.change = { summary: 'Staying with friends instead.', operations: [{ op: 'remove', itemId: apt }] };
  await ctx.engine.requestChange('We found a free place to stay');
  p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]), [['refund', 54000]]);
  await confirmAndRun(ctx);
  assert.equal(itemState(ctx.store.peek().ledger, apt).status, 'refunded');
});

test('the ledger equals what PayPal reports, after every kind of move', async () => {
  const ctx = setup();
  await checkout(ctx);
  const boat = ctx.store.peek().plan.items.find((i) => i.title.includes('boat')).id;
  const apt = ctx.store.peek().plan.items.find((i) => i.category === 'lodging').id;
  ctx.script.change = { summary: 'Cheaper flat, no boat.', operations: [{ op: 'remove', itemId: boat }, { op: 'reprice', itemId: apt, amount: 480 }] };
  await ctx.engine.requestChange('Cheaper flat and skip the boat');
  const p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]).sort(), [['refund', 6000], ['void', 18000]]);
  await confirmAndRun(ctx);
  const rec = await ctx.engine.reconcile();
  assert.equal(rec.allMatch, true, JSON.stringify(rec.rows.filter((r) => !r.match)));
  // and the amounts in the ledger are PayPal's amounts, not our intent
  for (const f of ctx.store.peek().ledger.filter((x) => x.op === 'refund')) assert.equal(f.cents, toCents(ctx.fake.refs.get(f.id).amount.value));
});

test('if PayPal answers with a different amount than confirmed, nothing is recorded or released', async () => {
  const ctx = setup();
  await ctx.engine.createTrip('t1', 'Lisbon');
  const boatId = ctx.store.peek().plan.items.find((i) => i.title.includes('boat')).id;
  const skewed = setup({ skew: { [boatId]: '181.00' } });
  await skewed.engine.createTrip('t1', 'Lisbon');
  const p = skewed.store.peek().proposals[skewed.store.peek().activeProposal];
  await skewed.engine.confirm(p.id, p.digest);
  const { orderId } = await skewed.engine.createOrder(p.id);
  await assert.rejects(skewed.engine.approveOrder(p.id, orderId), /does not match the confirmed amount/);
  assert.equal(skewed.store.peek().ledger.length, 0);
  assert.equal(skewed.fake.calls.some((c) => /capture|void|refund/.test(c)), false);
});

test('a model failure leaves the money alone and says why, and the person can retry', async () => {
  const ctx = setup();
  await checkout(ctx);
  const before = ctx.fake.calls.filter((c) => MONEY.test(c)).length;
  const ledgerBefore = structuredClone(ctx.store.peek().ledger);
  ctx.script.aiError = new AIError('The planning model is unavailable right now.');
  await assert.rejects(ctx.engine.requestChange('It will rain'), /unavailable/);
  assert.equal(ctx.fake.calls.filter((c) => MONEY.test(c)).length, before);
  assert.deepEqual(ctx.store.peek().ledger, ledgerBefore);
  assert.match(ctx.store.peek().events.at(-1).text, /unavailable/);

  // an answer that is valid JSON but breaks a rule is also rejected before any proposal exists
  ctx.script.aiError = null;
  ctx.script.change = { summary: 'x', operations: [{ op: 'remove', itemId: 'does-not-exist' }] };
  await assert.rejects(ctx.engine.requestChange('Drop the thing'), /unknown item/);
  assert.equal(ctx.store.peek().activeProposal, null);
  assert.equal(ctx.fake.calls.filter((c) => MONEY.test(c)).length, before);
});

test('a PayPal failure mid-way is reported, nothing is silently half-applied, and retry finishes it', async () => {
  const ctx = setup();
  await checkout(ctx);
  const plan = ctx.store.peek().plan;
  const boat = plan.items.find((i) => i.title.includes('boat')).id;
  const tour = plan.items.find((i) => i.title.includes('Sintra')).id;
  ctx.script.change = { summary: 'Skip both day trips.', operations: [{ op: 'remove', itemId: boat }, { op: 'remove', itemId: tour }] };
  await ctx.engine.requestChange('Skip both');
  // make the second void fail once
  const real = ctx.fake.fetchImpl; let voids = 0; let broken = true;
  const flaky = async (url, init = {}) => (broken && init.method === 'POST' && /void$/.test(new URL(url).pathname) && ++voids === 2 ? new Response(JSON.stringify({ name: 'X', message: 'Temporarily unavailable' }), { status: 503 }) : real(url, init));
  const ctx2 = { ...ctx, engine: undefined };
  const { createEngine } = await import('../src/engine.js');
  const engine = createEngine({ store: ctx.store, paypal: createPayPal({ clientId: 'id', secret: 's', fetchImpl: flaky }), ai: { planTrip: async () => {}, changeTrip: async () => {} }, now: () => ctx.clock.t });
  const p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  await engine.confirm(p.id, p.digest);
  let s = ctx.store.peek();
  assert.equal(s.proposals[p.id].status, 'failed');
  assert.match(s.proposals[p.id].error, /Temporarily unavailable/);
  assert.equal(itemState(s.ledger, boat).status, 'released');
  assert.equal(itemState(s.ledger, tour).status, 'held');
  assert.equal(s.plan.items.some((i) => i.id === boat), true, 'plan not switched until everything succeeded');
  broken = false;
  await engine.retry(p.id);
  s = ctx.store.peek();
  assert.equal(s.proposals[p.id].status, 'executed');
  assert.equal(itemState(s.ledger, tour).status, 'released');
  assert.equal(s.ledger.filter((f) => f.op === 'void' && f.itemId === boat).length, 1, 'retry must not void twice');
  void ctx2;
});
