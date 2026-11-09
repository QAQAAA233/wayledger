import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { createPayPal } from '../src/paypal.js';
import { fakeEnv, fakePayPalFetch, fakeSources, scriptedModel, planner, PLAN_PROMPT } from './helpers.js';

// PayPal events: believed only after PayPal itself confirms the signature, once, and only when recent.
const SOON = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const IP = { 'cf-connecting-ip': '198.51.100.9' };

async function booked() {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const w = fakeEnv({ ai: planner(), paypal, run: scriptedModel([{ calls: [{ name: 'no_change', args: { note: 'looked' } }] }]), sources: fakeSources() });
  const call = (method, path, body, headers = {}) => handleRequest(new Request(`https://wayledger.test${path}`, { method, headers: { 'content-type': 'application/json', ...IP, ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }), w.env, { paypal }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const made = (await call('POST', '/api/trips', { prompt: PLAN_PROMPT, startDate: SOON })).body;
  const h = { 'x-owner-token': made.ownerToken };
  const p = made.proposal;
  await call('POST', `/api/trips/${made.id}/proposals/${p.id}/confirm`, { digest: p.digest }, h);
  const order = await call('POST', `/api/trips/${made.id}/proposals/${p.id}/order`, {}, h);
  await call('POST', `/api/trips/${made.id}/proposals/${p.id}/approve`, { orderId: order.body.orderId }, h);
  const view = async () => (await call('GET', `/api/trips/${made.id}`, undefined, h)).body;
  const authId = [...fake.auths.keys()][0];
  return { w, fake, call, made, h, view, authId };
}
const headers = (over = {}) => ({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-id': 'tx-1', 'paypal-transmission-sig': 'good-signature', 'paypal-transmission-time': new Date().toISOString(), ...over });
const event = (tripId, authId, over = {}) => ({ id: 'WH-EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: authId, status: 'COMPLETED', custom_id: tripId, amount: { value: '540.00', currency_code: 'USD' } }, ...over });

test('an event PayPal signed is kept on the trip and shown, once', async () => {
  const t = await booked();
  const e = event(t.made.id, t.authId);
  const first = await t.call('POST', '/api/webhooks/paypal', e, headers());
  assert.deepEqual([first.status, first.body.stored], [200, true]);
  const again = await t.call('POST', '/api/webhooks/paypal', e, headers());
  assert.equal(again.body.stored, false, 'the same event delivered twice is kept once');
  const v = await t.view();
  assert.deepEqual(v.webhooks.map((w) => [w.type, w.known]), [['PAYMENT.CAPTURE.COMPLETED', true]]);
  assert.ok(v.events.some((x) => /PayPal reported: capture completed/.test(x.text)));
  assert.ok(t.fake.calls.includes('POST /v1/notifications/verify-webhook-signature'), 'PayPal itself checked the signature');
});

test('a forged, unsigned, stale or incomplete event is refused with 401 and changes nothing', async () => {
  const t = await booked();
  const e = event(t.made.id, t.authId);
  for (const [label, h] of [
    ['bad signature', headers({ 'paypal-transmission-sig': 'forged' })],
    ['no signature headers', {}],
    ['a missing header', (() => { const x = headers(); delete x['paypal-cert-url']; return x; })()],
    ['a replay from an hour ago', headers({ 'paypal-transmission-time': new Date(Date.now() - 3600_000).toISOString() })],
  ]) {
    const r = await t.call('POST', '/api/webhooks/paypal', e, h);
    assert.equal(r.status, 401, label);
    assert.equal(r.body.error.code, 'BAD_SIGNATURE');
  }
  const noId = await handleRequest(new Request('https://wayledger.test/api/webhooks/paypal', { method: 'POST', headers: headers(), body: JSON.stringify(e) }), { ...t.w.env, PAYPAL_WEBHOOK_ID: undefined }, { paypal: createPayPal({ clientId: 'i', secret: 's', fetchImpl: t.fake.fetchImpl }) });
  assert.equal(noId.status, 401, 'without a registered webhook id nothing can be believed');
  assert.equal((await t.view()).webhooks.length, 0);
  assert.equal((await t.call('POST', '/api/webhooks/paypal', 'not json', headers())).status, 401);
});

test('an event about something that is not one of our trips is acknowledged and ignored', async () => {
  const t = await booked();
  const r = await t.call('POST', '/api/webhooks/paypal', event('not-a-trip', 'X1'), headers());
  assert.deepEqual([r.status, r.body.ignored], [200, 'not about a trip of ours']);
  assert.equal((await t.view()).webhooks.length, 0);
});

test('a refund event finds its trip through the charge it points up to', async () => {
  const t = await booked();
  const capId = (await t.view()).ledger.find((f) => f.op === 'capture').id;
  const href = `https://api.sandbox.paypal.com/v2/payments/captures/${capId}`;
  const refund = { id: 'WH-EVT-2', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REFUND-X', status: 'COMPLETED', amount: { value: '10.00' }, links: [{ rel: 'up', href }] } };
  const r = await t.call('POST', '/api/webhooks/paypal', refund, headers({ 'paypal-transmission-id': 'tx-2' }));
  assert.deepEqual([r.status, r.body.stored], [200, true]);
  const evil = { ...refund, id: 'WH-EVT-3', resource: { ...refund.resource, links: [{ rel: 'up', href: 'https://example.com/v2/payments/captures/X' }] } };
  const e = await t.call('POST', '/api/webhooks/paypal', evil, headers({ 'paypal-transmission-id': 'tx-3' }));
  assert.equal(e.body.ignored, 'not about a trip of ours', 'a link that is not PayPal\'s payments API is never followed');
});

test('an authorization voided from outside is flagged and wakes the agent, which can read PayPal\'s side of it', async () => {
  const t = await booked();
  const out = await t.call('POST', '/api/webhooks/paypal', event(t.made.id, t.authId, { id: 'WH-EVT-9', event_type: 'PAYMENT.AUTHORIZATION.VOIDED', resource: { id: t.authId, status: 'VOIDED', custom_id: t.made.id } }), headers({ 'paypal-transmission-id': 'tx-9' }));
  assert.equal(out.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  const v = await t.view();
  assert.equal(v.runs.some((r) => r.trigger === 'webhook'), true);
  assert.equal(v.webhooks[0].type, 'PAYMENT.AUTHORIZATION.VOIDED');
});
