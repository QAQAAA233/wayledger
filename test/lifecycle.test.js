import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { AIError } from '../src/ai.js';
import { toCents } from '../src/domain/money.js';
import { itemState, reserves, appendFact, reconcile } from '../src/domain/ledger.js';
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

test('checkout places one trip reserve, allocates each item quota, and captures only prepaid lodging', async () => {
  const ctx = setup();
  await checkout(ctx);
  const s = ctx.store.peek();
  const states = Object.fromEntries(s.plan.items.map((i) => [i.title, itemState(s.ledger, i.id).status]));
  assert.deepEqual(states, { 'Alfama apartment (3 nights)': 'paid', 'Sunset boat tour': 'held', 'Sintra day trip': 'held' });
  const res = reserves(s.ledger);
  assert.equal(res.length, 1);
  assert.equal(res[0].authorizedCents, 84000);
  assert.equal(res[0].capturedCents, 54000);
  assert.equal(res[0].heldCents, 30000);
  assert.equal(res[0].unusedCents, 0);
  assert.equal(s.proposals[Object.keys(s.proposals)[0]].status, 'executed');
});

test('weather change, refund, and close trip: quota release & allocation, new hold when reserve is exceeded, refund, and close-trip capture + void', async () => {
  const ctx = setup();
  await checkout(ctx);
  const plan = ctx.store.peek().plan;
  const boat = plan.items.find((i) => i.title.includes('boat')).id;

  // 1. Removing the $180 boat tour releases $180 quota back to the trip reserve (no PayPal void yet),
  //    and adding a $66 oceanarium allocates from that $180 freed reserve without a new PayPal order.
  ctx.script.change = {
    summary: 'Storm on day 2: swapped the boat tour for the oceanarium.',
    operations: [
      { op: 'remove', itemId: boat },
      { op: 'add', item: { day: 2, title: 'Oceanarium tickets', category: 'activity', amount: 66, participants: ['Ana', 'Ben', 'Cy'] } },
    ],
  };
  await ctx.engine.requestChange('It will storm on Saturday');
  let p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]), [['release', 18000], ['allocate', 6600]]);
  assert.equal(p.netCents, 6600 - 18000);
  assert.equal(ctx.store.peek().plan.items.some((i) => i.title.includes('boat')), true, 'plan only changes once confirmed');

  const voidCallsBefore = ctx.fake.calls.filter((c) => /\/void$/.test(c)).length;
  await confirmAndRun(ctx);
  assert.equal(ctx.fake.calls.filter((c) => /\/void$/.test(c)).length, voidCallsBefore, 'removing an uncaptured item does not void the PayPal authorization');

  let s = ctx.store.peek();
  assert.equal(s.plan.items.some((i) => i.title.includes('boat')), false);
  assert.equal(itemState(s.ledger, boat).status, 'released');
  assert.equal(reserves(s.ledger)[0].unusedCents, 18000 - 6600);

  // 2. Adding an item ($250 helicopter tour) that exceeds the $114 unused reserve requests a new PayPal authorization ('hold')
  ctx.script.change = {
    summary: 'Added a helicopter tour.',
    operations: [{ op: 'add', item: { day: 3, title: 'Helicopter tour', category: 'activity', amount: 250, participants: ['Ana', 'Ben', 'Cy'] } }],
  };
  await ctx.engine.requestChange('Add a helicopter tour');
  p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]), [['hold', 25000]]);
  await confirmAndRun(ctx);
  assert.equal(reserves(ctx.store.peek().ledger).length, 2);

  // 3. Dropping the captured apartment triggers a PayPal refund
  s = ctx.store.peek();
  const apt = s.plan.items.find((i) => i.category === 'lodging').id;
  ctx.script.change = { summary: 'Staying with friends instead.', operations: [{ op: 'remove', itemId: apt }] };
  await ctx.engine.requestChange('We found a free place to stay');
  p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]), [['refund', 54000]]);
  await confirmAndRun(ctx);
  assert.equal(itemState(ctx.store.peek().ledger, apt).status, 'refunded');

  // 4. Close trip: captures all remaining held items ($120 Sintra + $66 Oceanarium + $250 Helicopter) and voids the $114 unused reserve on AUTH1
  await ctx.engine.closeTrip();
  p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  assert.equal(p.kind, 'close');
  assert.deepEqual(
    p.actions.map((a) => [a.type, a.cents]),
    [['capture', 6600], ['capture', 12000], ['capture', 25000], ['void', 11400]]
  );
  await confirmAndRun(ctx);
  s = ctx.store.peek();
  for (const item of s.plan.items) {
    assert.equal(itemState(s.ledger, item.id).status, 'paid');
  }
  assert.equal(reserves(s.ledger).every((r) => !r.open), true);
  assert.equal(ctx.fake.auths.get(reserves(s.ledger)[0].id).status, 'VOIDED');
  const rec = await ctx.engine.reconcile();
  assert.equal(rec.allMatch, true, JSON.stringify(rec));
});

test('the ledger equals what PayPal reports both mid-trip and after closeTrip', async () => {
  const ctx = setup();
  await checkout(ctx);
  const boat = ctx.store.peek().plan.items.find((i) => i.title.includes('boat')).id;
  const apt = ctx.store.peek().plan.items.find((i) => i.category === 'lodging').id;
  ctx.script.change = { summary: 'Cheaper flat, no boat.', operations: [{ op: 'remove', itemId: boat }, { op: 'reprice', itemId: apt, amount: 480 }] };
  await ctx.engine.requestChange('Cheaper flat and skip the boat');
  const p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]).sort(), [['refund', 6000], ['release', 18000]]);
  await confirmAndRun(ctx);

  // Mid-trip reconcile: Sintra is still HELD, AUTH1 is PARTIALLY_CAPTURED in PayPal
  const midRec = await ctx.engine.reconcile();
  assert.equal(midRec.allMatch, true, JSON.stringify(midRec));
  assert.equal(midRec.heldItemsCheck.length, 1);
  assert.equal(midRec.heldItemsCheck[0].valid, true);

  // Close trip: captures Sintra ($120) and voids the $180 unused reserve on AUTH1
  await ctx.engine.closeTrip();
  await confirmAndRun(ctx);
  const endRec = await ctx.engine.reconcile();
  assert.equal(endRec.allMatch, true, JSON.stringify(endRec));
  assert.equal(endRec.heldItemsCheck.length, 0);
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

  ctx.script.aiError = null;
  ctx.script.change = { summary: 'x', operations: [{ op: 'remove', itemId: 'does-not-exist' }] };
  await assert.rejects(ctx.engine.requestChange('Drop the thing'), /unknown item/);
  assert.equal(ctx.store.peek().activeProposal, null);
  assert.equal(ctx.fake.calls.filter((c) => MONEY.test(c)).length, before);
});

test('a PayPal failure mid-way through closeTrip is reported, nothing is silently half-applied, and retry finishes it', async () => {
  const ctx = setup();
  await checkout(ctx);
  await ctx.engine.closeTrip();

  // Make the second capture fail once
  const real = ctx.fake.fetchImpl; let caps = 0; let broken = true;
  const flaky = async (url, init = {}) => (broken && init.method === 'POST' && /capture$/.test(new URL(url).pathname) && ++caps === 2 ? new Response(JSON.stringify({ name: 'X', message: 'Temporarily unavailable' }), { status: 503 }) : real(url, init));
  const { createEngine } = await import('../src/engine.js');
  const engine = createEngine({ store: ctx.store, paypal: createPayPal({ clientId: 'id', secret: 's', fetchImpl: flaky }), ai: { planTrip: async () => {}, changeTrip: async () => {} }, now: () => ctx.clock.t });
  const p = ctx.store.peek().proposals[ctx.store.peek().activeProposal];
  const boat = ctx.store.peek().plan.items.find((i) => i.title.includes('boat')).id;
  const tour = ctx.store.peek().plan.items.find((i) => i.title.includes('Sintra')).id;

  await engine.confirm(p.id, p.digest);
  let s = ctx.store.peek();
  assert.equal(s.proposals[p.id].status, 'failed');
  assert.match(s.proposals[p.id].error, /Temporarily unavailable/);
  assert.equal(itemState(s.ledger, boat).status, 'paid');
  assert.equal(itemState(s.ledger, tour).status, 'held');

  broken = false;
  await engine.retry(p.id);
  s = ctx.store.peek();
  assert.equal(s.proposals[p.id].status, 'executed');
  assert.equal(itemState(s.ledger, tour).status, 'paid');
  assert.equal(s.ledger.filter((f) => f.op === 'capture' && f.itemId === boat).length, 1, 'retry must not capture twice');
});

test('reconcile flags a mismatch when PayPal authorization is VOIDED while items on it are still HELD', () => {
  // 1. Legacy per-item authorize rows sharing one voided PayPal authorization (exact bug from 51U586321V080991T):
  const legacyLedger = [];
  appendFact(legacyLedger, { op: 'authorize', itemId: 'i1', id: '51U586321V080991T', orderId: '7TA63620MF0285309', status: 'CREATED', cents: 60000, at: 1 });
  appendFact(legacyLedger, { op: 'authorize', itemId: 'i2', id: '51U586321V080991T', orderId: '7TA63620MF0285309', status: 'CREATED', cents: 12000, at: 1 });
  appendFact(legacyLedger, { op: 'authorize', itemId: 'i3', id: '51U586321V080991T', orderId: '7TA63620MF0285309', status: 'CREATED', cents: 48000, at: 1 });
  appendFact(legacyLedger, { op: 'capture', itemId: 'i1', id: '3TY27370H01715255', parentId: '51U586321V080991T', status: 'COMPLETED', cents: 60000, at: 2 });
  appendFact(legacyLedger, { op: 'void', itemId: 'i2', id: '51U586321V080991T', status: 'VOIDED', cents: 12000, at: 3 });

  assert.equal(itemState(legacyLedger, 'i3').status, 'held');
  const remote = {
    '51U586321V080991T': { status: 'VOIDED', cents: 120000 },
    '3TY27370H01715255': { status: 'COMPLETED', cents: 60000 },
  };
  const rec1 = reconcile(legacyLedger, remote);
  assert.equal(rec1.allMatch, false, 'must report mismatch when an item is HELD on a VOIDED PayPal authorization');

  // 2. Reserve + quota model where PayPal authorization is VOIDED externally while an item is still HELD:
  const reserveLedger = [];
  appendFact(reserveLedger, { op: 'authorize', itemId: '_reserve', id: '51U586321V080991T', orderId: '7TA63620MF0285309', status: 'CREATED', cents: 120000, at: 1 });
  appendFact(reserveLedger, { op: 'allocate', itemId: 'i1', id: '51U586321V080991T', status: 'ALLOCATED', cents: 60000, at: 1 });
  appendFact(reserveLedger, { op: 'allocate', itemId: 'i2', id: '51U586321V080991T', status: 'ALLOCATED', cents: 12000, at: 1 });
  appendFact(reserveLedger, { op: 'allocate', itemId: 'i3', id: '51U586321V080991T', status: 'ALLOCATED', cents: 48000, at: 1 });
  appendFact(reserveLedger, { op: 'capture', itemId: 'i1', id: '3TY27370H01715255', parentId: '51U586321V080991T', status: 'COMPLETED', cents: 60000, at: 2 });
  appendFact(reserveLedger, { op: 'release', itemId: 'i2', id: '51U586321V080991T', status: 'RELEASED', cents: 12000, at: 3 });

  assert.equal(itemState(reserveLedger, 'i3').status, 'held');
  const rec2 = reconcile(reserveLedger, remote);
  assert.equal(rec2.allMatch, false, 'must report mismatch when PayPal says VOIDED while item i3 is still HELD');
  assert.equal(rec2.heldItemsCheck.find((h) => h.itemId === 'i3')?.valid, false);
});
