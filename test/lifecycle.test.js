import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { createEngine } from '../src/engine.js';
import { AIError } from '../src/ai.js';
import { toCents } from '../src/domain/money.js';
import { itemState, reserves, appendFact, reconcile } from '../src/domain/ledger.js';
import { fakePayPalFetch, makeEngine, newTrip, checkoutAsBuyer, planner, SAMPLE_PLAN } from './helpers.js';

const MONEY = /POST .*\/(orders|authorize|capture|void|refund)/;

// These tests are about the money, so the agent is left out: a change is handed to the engine the way the agent hands
// it over (submitEdit). With no limits signed (mandate disabled) every change waits for the person, as it did before
// the agent existed.
function setup({ failOn, skew } = {}) {
  const fake = fakePayPalFetch({ failOn, skew });
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  return { fake, paypal, ...makeEngine({ ai: planner(), paypal }) };
}
const active = (ctx) => ctx.store.peek().proposals[ctx.store.peek().activeProposal];
const change = (ctx, ops) => ctx.engine.submitEdit({ ops, agentNote: 'note' });

async function booked(ctx) {
  await newTrip(ctx);
  await ctx.engine.setMandateTerms({ enabled: false });
  await checkoutAsBuyer(ctx);
}
async function confirmAndRun(ctx) {
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  if (p.actions.some((a) => a.type === 'hold')) {
    const { orderId } = await ctx.engine.createOrder(p.id);
    await ctx.engine.approveOrder(p.id, orderId);
  }
  return p.id;
}

test('checkout places one trip hold, sets money aside for each item, and charges only the prepaid lodging', async () => {
  const ctx = setup();
  await booked(ctx);
  const s = ctx.store.peek();
  const states = Object.fromEntries(s.plan.items.map((i) => [i.title, itemState(s.ledger, i.id).status]));
  assert.deepEqual(states, { 'Alfama apartment (3 nights)': 'paid', 'Sunset boat tour': 'held', 'Sintra day trip': 'held' });
  const res = reserves(s.ledger);
  assert.equal(res.length, 1);
  assert.equal(res[0].authorizedCents, 84000);
  assert.equal(res[0].capturedCents, 54000);
  assert.equal(res[0].heldCents, 30000);
  assert.equal(res[0].unusedCents, 0);
  assert.equal(Object.values(s.proposals).at(-1).status, 'executed');
  assert.match(res[0].expiresAt, /^\d{4}-\d{2}-\d{2}T/, 'the hold remembers when PayPal says it lapses');
});

test('weather change, refund, and close trip: money freed and set aside again, a new hold when the hold is exceeded, a refund, and the closing charges and release', async () => {
  const ctx = setup();
  await booked(ctx);
  const boat = ctx.store.peek().plan.items.find((i) => i.title.includes('boat')).id;

  // 1. Removing the $180 boat tour frees $180 inside the hold (no PayPal call), and a $66 oceanarium is set aside from it.
  await change(ctx, [{ op: 'remove', itemId: boat }, { op: 'add', item: { day: 2, title: 'Oceanarium tickets', category: 'activity', amount: 66, participants: ['Ana', 'Ben', 'Cy'] } }]);
  let p = active(ctx);
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]), [['release', 18000], ['allocate', 6600]]);
  assert.equal(p.netCents, 6600 - 18000);
  assert.equal(ctx.store.peek().plan.items.some((i) => i.title.includes('boat')), true, 'the plan only changes once confirmed');

  const voidCallsBefore = ctx.fake.calls.filter((c) => /\/void$/.test(c)).length;
  await confirmAndRun(ctx);
  assert.equal(ctx.fake.calls.filter((c) => /\/void$/.test(c)).length, voidCallsBefore, 'removing an uncharged item does not void the PayPal authorization');

  let s = ctx.store.peek();
  assert.equal(s.plan.items.some((i) => i.title.includes('boat')), false);
  assert.equal(itemState(s.ledger, boat).status, 'released');
  assert.equal(reserves(s.ledger)[0].unusedCents, 18000 - 6600);

  // 2. A $250 helicopter tour is more than the $114 left in the hold: a new PayPal hold is needed.
  await change(ctx, [{ op: 'add', item: { day: 3, title: 'Helicopter tour', category: 'activity', amount: 250, participants: ['Ana', 'Ben', 'Cy'] } }]);
  p = active(ctx);
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]), [['hold', 25000]]);
  await confirmAndRun(ctx);
  assert.equal(reserves(ctx.store.peek().ledger).length, 2);

  // 3. Dropping the charged apartment triggers a PayPal refund
  s = ctx.store.peek();
  const apt = s.plan.items.find((i) => i.category === 'lodging').id;
  await change(ctx, [{ op: 'remove', itemId: apt }]);
  p = active(ctx);
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]), [['refund', 54000]]);
  await confirmAndRun(ctx);
  assert.equal(itemState(ctx.store.peek().ledger, apt).status, 'refunded');
  assert.ok(ctx.fake.refs.size === 1 && [...ctx.fake.refs.values()][0].note === 'Wayledger: your trip plan changed', 'PayPal gets fixed words, not text from a model');

  // 4. Close trip: charges all remaining held items; the last charge on each hold is final, so PayPal releases the $114 left in the first hold
  await ctx.engine.closeTrip();
  p = active(ctx);
  assert.equal(p.kind, 'close');
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]), [['capture', 6600], ['capture', 12000], ['capture', 25000]]);
  assert.equal(p.actions.filter((a) => a.finalCapture).reduce((n, a) => n + a.releasesCents, 0), 11400, 'the final charges release the rest of the holds');
  await confirmAndRun(ctx);
  s = ctx.store.peek();
  for (const item of s.plan.items) assert.equal(itemState(s.ledger, item.id).status, 'paid');
  assert.equal(reserves(s.ledger).every((r) => !r.open), true);
  assert.equal(ctx.fake.auths.get(reserves(s.ledger)[0].id).status, 'CAPTURED', 'a final charge closes the hold at PayPal');
  const rec = await ctx.engine.reconcile();
  assert.equal(rec.allMatch, true, JSON.stringify(rec));
  assert.equal(rec.planCheck.ok, true, 'the money follows the plan');
});

test('the ledger equals what PayPal reports both mid-trip and after closeTrip', async () => {
  const ctx = setup();
  await booked(ctx);
  const boat = ctx.store.peek().plan.items.find((i) => i.title.includes('boat')).id;
  const apt = ctx.store.peek().plan.items.find((i) => i.category === 'lodging').id;
  await change(ctx, [{ op: 'remove', itemId: boat }, { op: 'reprice', itemId: apt, amount: 480 }]);
  const p = active(ctx);
  assert.deepEqual(p.actions.map((a) => [a.type, a.cents]).sort(), [['refund', 6000], ['release', 18000]]);
  await confirmAndRun(ctx);

  const midRec = await ctx.engine.reconcile();
  assert.equal(midRec.allMatch, true, JSON.stringify(midRec));
  assert.equal(midRec.heldItemsCheck.length, 1);
  assert.equal(midRec.heldItemsCheck[0].valid, true);

  await ctx.engine.closeTrip();
  await confirmAndRun(ctx);
  const endRec = await ctx.engine.reconcile();
  assert.equal(endRec.allMatch, true, JSON.stringify(endRec));
  assert.equal(endRec.heldItemsCheck.length, 0);
  for (const f of ctx.store.peek().ledger.filter((x) => x.op === 'refund')) assert.equal(f.cents, toCents(ctx.fake.refs.get(f.id).amount.value));
});

test('if PayPal answers with a different amount than confirmed, nothing is recorded and the unrequested hold is given back', async () => {
  const probe = setup();
  await newTrip(probe);
  const boatId = probe.store.peek().plan.items.find((i) => i.title.includes('boat')).id;
  const skewed = setup({ skew: { [boatId]: '181.00' } });
  await newTrip(skewed);
  await skewed.engine.setMandateTerms({ enabled: false });
  const p = active(skewed);
  await skewed.engine.confirm(p.id, p.digest);
  const { orderId } = await skewed.engine.createOrder(p.id);
  await assert.rejects(skewed.engine.approveOrder(p.id, orderId), /does not match the confirmed amount.*released/s);
  assert.equal(skewed.store.peek().ledger.length, 0);
  assert.equal(skewed.fake.calls.some((c) => /capture|refund/.test(c)), false);
  const voids = skewed.fake.calls.filter((c) => /authorizations\/\w+\/void$/.test(c));
  assert.equal(voids.length, 1, 'the stray authorization was voided so nothing keeps holding the buyer\'s money');
  assert.equal([...skewed.fake.auths.values()][0].status, 'VOIDED');
});

test('a planning failure leaves nothing behind', async () => {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const ctx = makeEngine({ ai: { planTrip: async () => { throw new AIError('The planning model is busy right now.'); } }, paypal });
  await assert.rejects(newTrip(ctx), /busy/);
  assert.equal(ctx.store.peek(), null);
  assert.deepEqual(fake.calls.filter((c) => MONEY.test(c)), []);
});

test('a PayPal failure mid-way through closeTrip is reported, nothing is silently half-applied, and retry finishes it', async () => {
  const ctx = setup();
  await booked(ctx);
  await ctx.engine.closeTrip();

  // Make the second charge fail once
  const real = ctx.fake.fetchImpl; let caps = 0; let broken = true;
  const flaky = async (url, init = {}) => (broken && init.method === 'POST' && /capture$/.test(new URL(url).pathname) && ++caps === 2 ? new Response(JSON.stringify({ name: 'X', message: 'Temporarily unavailable' }), { status: 503 }) : real(url, init));
  const engine = createEngine({ store: ctx.store, paypal: createPayPal({ clientId: 'id', secret: 's', fetchImpl: flaky }), ai: planner(), now: () => ctx.clock.t });
  const p = active(ctx);
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
  assert.equal(s.ledger.filter((f) => f.op === 'capture' && f.itemId === boat).length, 1, 'retry must not charge twice');
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

  // 2. Hold + set-aside model where PayPal authorization is VOIDED externally while an item is still HELD:
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

test('the plan must be the money: an item with no funds or funds on a removed item is reported as a mismatch', async () => {
  const ctx = setup();
  await booked(ctx);
  assert.equal((await ctx.engine.reconcile()).planCheck.ok, true);
  const s = ctx.store.peek();
  s.plan.items.push({ id: 'i9', day: 3, title: 'Ghibli Museum', category: 'activity', amountCents: 4000, participants: ['Ana'], prepaid: false });
  await ctx.store.put(s);
  const rec = await ctx.engine.reconcile();
  assert.equal(rec.planCheck.ok, false);
  assert.equal(rec.allMatch, false, 'a plan the money does not follow is not a clean ledger');
  assert.deepEqual(rec.planCheck.mismatches.map((m) => [m.title, m.kind]), [['Ghibli Museum', 'unfunded']]);
});
