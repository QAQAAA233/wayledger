import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { createEngine } from '../src/engine.js';
import { handleRequest } from '../src/api.js';
import { itemState, reserves } from '../src/domain/ledger.js';
import { PROPOSAL_TTL_MS } from '../src/domain/proposal.js';
import { fakePayPalFetch, fakeEnv, fakeSources, scriptedModel, makeEngine, newTrip, checkoutAsBuyer, planner, PLAN_PROMPT, SAMPLE_PLAN } from './helpers.js';
import { PLAN } from './storm.js';

// Second-round review, findings 5 and 6: a hold that PayPal no longer has (voided from outside, or run out) is a fact
// the trip learns, shows and has a way out of. It never leaves the trip stuck, and no model is woken to find out.
const MONEY = /POST .*\/(orders|authorize|capture|void|refund)/;
const HOUR = 3_600_000;
function setup(raw = SAMPLE_PLAN) {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  return { fake, paypal, ...makeEngine({ ai: planner(raw), paypal }) };
}
const state = (ctx) => ctx.store.peek();
const active = (ctx) => state(ctx).proposals[state(ctx).activeProposal];
const LIMITS = (ctx) => ({ enabled: true, refundCapCents: 100000, planIncreaseCapCents: 21000, validUntil: ctx.clock.t + 5 * 24 * HOUR });
async function booked(ctx, terms) {
  await newTrip(ctx);
  if (terms) await ctx.engine.setMandateTerms(terms);
  await checkoutAsBuyer(ctx);
  return [...ctx.fake.auths.keys()][0];
}
const voidedEvent = (authId, id = 'WH-1') => ({ id, event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: authId, status: 'VOIDED' } });
const titles = (list) => list.map((x) => x.title).sort();

// ---- finding 5: closing after the hold is gone ------------------------------------------------------------------------

for (const [how, issue] of [['voided from outside', 'AUTHORIZATION_VOIDED'], ['run out', 'AUTHORIZATION_EXPIRED']]) {
  test(`finding 5: closing a trip whose hold was ${how} ends in a closed trip, not in a stuck one`, async () => {
    const ctx = setup();
    const authId = await booked(ctx, LIMITS(ctx));
    if (issue === 'AUTHORIZATION_EXPIRED') ctx.fake.expire(authId); else ctx.fake.voidOutside(authId);
    await ctx.engine.closeTrip();
    const close = active(ctx);
    await ctx.engine.confirm(close.id, close.digest); // PayPal refuses the charges: the hold is gone
    const s = state(ctx);
    assert.equal(s.proposals[close.id].status, 'stopped', 'not "failed": there is nothing left to retry');
    assert.match(s.proposals[close.id].error, /no longer holds/i);
    assert.equal(s.activeProposal, null, 'nothing blocks the next step');
    assert.equal(s.ledger.some((f) => f.op === 'void' && f.external && f.id === authId), true, 'the loss is in the ledger, marked as PayPal\'s doing');
    assert.equal(reserves(s.ledger)[0].voided, true);
    const v = ctx.engine.view(s, { owner: true });
    assert.deepEqual(titles(v.holdLost.short), ['Sintra day trip', 'Sunset boat tour']);
    assert.equal(v.holdLost.cents, 30000);
    assert.equal(v.holdLost.canRehold, true);

    await ctx.engine.closeTrip();
    assert.notEqual(state(ctx).closedAt, null, 'closing again has nothing left to charge and closes');
    assert.match(state(ctx).events.at(-1).text, /Never booked: .*Sunset boat tour/);
    const rec = await ctx.engine.reconcile();
    assert.equal(rec.rows.every((r) => r.match) && rec.heldItemsCheck.every((h) => h.valid), true, 'PayPal says the same thing the ledger does');
    assert.deepEqual(titles(rec.planCheck.mismatches), ['Sintra day trip', 'Sunset boat tour'], 'and the plan check still says which items have no money');
  });
}

test('finding 5: a change that could not finish because the hold was gone keeps what the person asked for; the money is what is missing', async () => {
  const ctx = setup(PLAN); // boat is paid in advance here
  const authId = await booked(ctx, LIMITS(ctx));
  ctx.fake.voidOutside(authId);
  await ctx.engine.submitEdit({ ops: [{ op: 'add', item: { day: 3, title: 'Sailing lesson', category: 'activity', amount: 100, prepaid: true, participants: ['Ana', 'Ben', 'Cy'] } }] });
  const p = active(ctx);
  await ctx.engine.confirm(p.id, p.digest);
  const s = state(ctx);
  assert.equal(s.proposals[p.id].status, 'stopped');
  assert.equal(s.plan.items.some((i) => i.title === 'Sailing lesson'), true, 'the traveler\'s confirmed plan stands');
  assert.equal(ctx.engine.view(s, { owner: true }).holdLost.short.some((x) => x.title === 'Sailing lesson'), true, 'and the screen says it has no money behind it');
});

test('finding 5: a proposal that failed before anything ran can be worked out again (the way out of a stuck "retry")', async () => {
  const ctx = setup();
  await booked(ctx, LIMITS(ctx));
  await ctx.engine.closeTrip();
  const p = active(ctx);
  const real = ctx.fake.fetchImpl;
  const down = async (url, init = {}) => (init.method === 'POST' && /capture$/.test(new URL(url).pathname) ? new Response(JSON.stringify({ name: 'X', message: 'PayPal is down' }), { status: 503 }) : real(url, init));
  const engine = createEngine({ store: ctx.store, paypal: createPayPal({ clientId: 'i', secret: 's', fetchImpl: down }), ai: planner(), now: () => ctx.clock.t });
  await engine.confirm(p.id, p.digest);
  assert.equal(state(ctx).proposals[p.id].status, 'failed');
  await assert.rejects(ctx.engine.closeTrip(), (e) => e.code === 'PREVIOUS_FAILED');
  ctx.clock.t += PROPOSAL_TTL_MS + 16 * 60_000;
  await engine.retry(p.id);
  assert.ok(['failed', 'expired'].includes(state(ctx).proposals[p.id].status), 'retrying does not help while it is down and after it expired');
  await ctx.engine.refreshProposal(p.id);
  const fresh = active(ctx);
  assert.notEqual(fresh.id, p.id);
  assert.equal(fresh.status, 'pending');
  await ctx.engine.confirm(fresh.id, fresh.digest);
  assert.notEqual(state(ctx).closedAt, null);
});

test('finding 5: a proposal that stopped halfway is worked out again from what really happened, and the agent\'s refund limit counts what already went out', async () => {
  const ctx = setup(PLAN);
  await booked(ctx, LIMITS(ctx));
  const real = ctx.fake.fetchImpl; let refunds = 0;
  const flaky = async (url, init = {}) => (init.method === 'POST' && /refund$/.test(new URL(url).pathname) && ++refunds === 2 ? new Response(JSON.stringify({ name: 'X', message: 'PayPal is down' }), { status: 503 }) : real(url, init));
  const engine = createEngine({ store: ctx.store, paypal: createPayPal({ clientId: 'i', secret: 's', fetchImpl: flaky }), ai: planner(), now: () => ctx.clock.t });
  const apartment = state(ctx).plan.items.find((i) => /apartment/.test(i.title)).id;
  const boat = state(ctx).plan.items.find((i) => /boat/.test(i.title)).id;
  const out = await engine.submitEdit({ ops: [{ op: 'remove', itemId: apartment }, { op: 'remove', itemId: boat }] });
  assert.equal(out.outcome, 'failed', 'the second refund did not go through');
  const failed = state(ctx).proposals[out.proposalId];
  assert.equal(failed.status, 'failed');
  assert.equal(state(ctx).mandate.used.refundCents, 54000, 'the refund that went out is counted at once, not when the proposal finishes');
  await assert.rejects(ctx.engine.submitEdit({ ops: [{ op: 'remove', itemId: boat }] }), (e) => e.code === 'PREVIOUS_FAILED');

  await ctx.engine.refreshProposal(failed.id);
  const rest = active(ctx);
  assert.deepEqual(rest.actions.map((a) => [a.type, a.cents]), [['refund', 18000]], 'only what is still to do');
  await ctx.engine.confirm(rest.id, rest.digest);
  assert.equal(state(ctx).proposals[rest.id].status, 'executed');
  assert.equal((await ctx.engine.reconcile()).allMatch, true);
  assert.equal(itemState(state(ctx).ledger, boat).paidCents, 0);
  assert.equal(state(ctx).mandate.used.refundCents, 54000, 'a person\'s yes does not use up the agent\'s limit');
});

// ---- finding 6: PayPal says the hold is gone -----------------------------------------------------------------------------

function world() {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const model = scriptedModel([{ calls: [{ name: 'no_change', args: { note: 'should never be asked' } }] }]);
  const w = fakeEnv({ ai: planner(), paypal, run: model, sources: fakeSources() });
  const IP = { 'cf-connecting-ip': '198.51.100.9' };
  const call = (method, path, body, headers = {}) => handleRequest(new Request(`https://wayledger.test${path}`, { method, headers: { 'content-type': 'application/json', ...IP, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), w.env, { paypal }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { fake, w, model, call };
}
const hooks = (id = 'tx-1') => ({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-id': id, 'paypal-transmission-sig': 'good-signature', 'paypal-transmission-time': new Date().toISOString() });
const SOON = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);

test('finding 6: PayPal reports the hold voided: the trip records it, shows it, offers a new hold, and no model is called', async () => {
  const t = world();
  const made = (await t.call('POST', '/api/trips', { prompt: PLAN_PROMPT, startDate: SOON })).body;
  const h = { 'x-owner-token': made.ownerToken };
  const p = made.proposal;
  await t.call('POST', `/api/trips/${made.id}/proposals/${p.id}/confirm`, { digest: p.digest }, h);
  const order = await t.call('POST', `/api/trips/${made.id}/proposals/${p.id}/order`, {}, h);
  await t.call('POST', `/api/trips/${made.id}/proposals/${p.id}/approve`, { orderId: order.body.orderId }, h);
  const authId = [...t.fake.auths.keys()][0];
  t.fake.voidOutside(authId);

  const ev = { ...voidedEvent(authId, 'WH-EVT-VOID'), resource: { id: authId, status: 'VOIDED', custom_id: made.id } };
  const out = await t.call('POST', '/api/webhooks/paypal', ev, hooks());
  assert.deepEqual([out.status, out.body.stored], [200, true]);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(t.model.log.length, 0, 'a fact PayPal signed is not a question for a model');
  const v = (await t.call('GET', `/api/trips/${made.id}`, undefined, h)).body;
  assert.equal(v.runs.length, 0);
  assert.equal(v.holdLost.canRehold, true);
  assert.deepEqual(titles(v.holdLost.short), ['Sintra day trip', 'Sunset boat tour']);
  assert.equal(v.reserves[0].voided, true);
  assert.ok(v.events.some((e) => /PayPal cancelled the hold/i.test(e.text)));
  const again = await t.call('POST', '/api/webhooks/paypal', ev, hooks('tx-2'));
  assert.equal(again.body.stored, false);
  assert.equal(v.ledger.filter((f) => f.op === 'void').length, 1, 'once');

  // the way on: a new hold for the items that lost theirs, which the person approves in PayPal
  const re = (await t.call('POST', `/api/trips/${made.id}/rehold`, {}, h)).body;
  assert.equal(re.proposal.kind, 'checkout');
  assert.deepEqual(re.proposal.actions.filter((a) => a.itemId !== '_buffer').map((a) => [a.title, a.cents]).sort(), [['Sintra day trip', 12000], ['Sunset boat tour', 18000]]);
  assert.equal(re.proposal.actions.find((a) => a.itemId === '_buffer').cents, 21000, 'and the buffer the agent works with');
  await t.call('POST', `/api/trips/${made.id}/proposals/${re.proposal.id}/confirm`, { digest: re.proposal.digest }, h);
  const o2 = await t.call('POST', `/api/trips/${made.id}/proposals/${re.proposal.id}/order`, {}, h);
  const done = await t.call('POST', `/api/trips/${made.id}/proposals/${re.proposal.id}/approve`, { orderId: o2.body.orderId }, h);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.holdLost, null, 'the banner goes away by itself once the money follows the plan again');
  assert.equal((await t.call('GET', `/api/trips/${made.id}/reconcile`)).body.allMatch, true);
});

test('finding 6: a hold we released ourselves is not a surprise', async () => {
  const ctx = setup();
  const authId = await booked(ctx, LIMITS(ctx));
  await ctx.engine.closeTrip();
  const close = active(ctx);
  await ctx.engine.confirm(close.id, close.digest);
  const before = state(ctx).ledger.length;
  const out = await ctx.engine.recordWebhook(voidedEvent(authId, 'WH-OURS'));
  assert.equal(out.stored, true);
  assert.equal(state(ctx).ledger.length, before, 'our own void changes nothing');
  assert.equal(ctx.engine.view(state(ctx), { owner: true }).holdLost, null);
});

test('finding 6: a trip with nothing short has nothing to hold', async () => {
  const ctx = setup();
  await booked(ctx, LIMITS(ctx));
  const before = ctx.fake.calls.filter((c) => MONEY.test(c)).length;
  await assert.rejects(ctx.engine.rehold(), (e) => e.code === 'NOTHING_TO_HOLD');
  await assert.rejects(ctx.engine.recordWebhook(voidedEvent('NOPE')).then(() => ctx.engine.rehold()), (e) => e.code === 'NOTHING_TO_HOLD');
  assert.equal(ctx.fake.calls.filter((c) => MONEY.test(c)).length, before, 'and nothing was sent to PayPal');
});

// ---- the schedule notices what no webhook told it ---------------------------------------------------------------------------

test('finding 6: at its scheduled look the trip asks PayPal about its open holds, so a hold voided without any event is found anyway', async () => {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const model = scriptedModel([{ calls: [{ name: 'no_change', args: { note: 'should not be asked' } }] }]);
  const w = fakeEnv({ ai: planner(), paypal, run: model, sources: fakeSources() });
  const IP = { 'cf-connecting-ip': '198.51.100.9' };
  const call = (method, path, body, headers = {}) => handleRequest(new Request(`https://wayledger.test${path}`, { method, headers: { 'content-type': 'application/json', ...IP, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), w.env, { paypal }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const made = (await call('POST', '/api/trips', { prompt: PLAN_PROMPT, startDate: SOON })).body;
  const h = { 'x-owner-token': made.ownerToken };
  const p = made.proposal;
  await call('POST', `/api/trips/${made.id}/proposals/${p.id}/confirm`, { digest: p.digest }, h);
  const order = await call('POST', `/api/trips/${made.id}/proposals/${p.id}/order`, {}, h);
  await call('POST', `/api/trips/${made.id}/proposals/${p.id}/approve`, { orderId: order.body.orderId }, h);
  const authId = [...fake.auths.keys()][0];

  // nothing is wrong yet: the look changes nothing
  await call('POST', `/api/trips/${made.id}/wake`, { demo: false }, h);
  assert.equal((await call('GET', `/api/trips/${made.id}`, undefined, h)).body.holdLost, null);

  fake.voidOutside(authId); // and no event is ever delivered
  const woke = await call('POST', `/api/trips/${made.id}/wake`, { demo: false }, h);
  assert.equal(woke.status, 202);
  const v = (await call('GET', `/api/trips/${made.id}`, undefined, h)).body;
  assert.deepEqual(titles(v.holdLost.short), ['Sintra day trip', 'Sunset boat tour']);
  assert.equal(v.ledger.filter((f) => f.op === 'void' && f.external).length, 1);
  assert.equal(model.log.length, 0, 'finding out is not a question for a model');
  await call('POST', `/api/trips/${made.id}/wake`, { demo: false }, h);
  assert.equal((await call('GET', `/api/trips/${made.id}`, undefined, h)).body.ledger.filter((f) => f.op === 'void').length, 1, 'a second look records nothing twice');
});
