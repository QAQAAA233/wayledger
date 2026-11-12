import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal, PayPalError } from '../src/paypal.js';

function client(base = 'https://api-m.sandbox.paypal.com') {
  const calls = [];
  const record = { id: 'CAPTURE123', custom_id: '1234567890abcdef12345678' };
  const paypal = createPayPal({ base, clientId: 'fixture', secret: 'fixture', fetchImpl: async (url, init) => {
    calls.push([url, init.method]);
    return Response.json(url.endsWith('/v1/oauth2/token') ? { access_token: 'fixture', expires_in: 3600 } : record);
  } });
  return { paypal, calls, record };
}

test('both PayPal payment hosts still use the configured base and cached token', async () => {
  const { paypal, calls, record } = client();
  for (const host of ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']) {
    assert.deepEqual(await paypal.getByLink('https://' + host + '/v2/payments/captures/CAPTURE123?unused=1#detail'), record);
  }
  const base = 'https://api-m.sandbox.paypal.com';
  assert.deepEqual(calls, [[base + '/v1/oauth2/token', 'POST'], [base + '/v2/payments/captures/CAPTURE123', 'GET'], [base + '/v2/payments/captures/CAPTURE123', 'GET']]);
});

test('normalized path escapes are rejected before OAuth or any resource request', async () => {
  const { paypal, calls } = client();
  for (const host of ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']) {
    for (const escape of ['../../', '%2e%2e/%2e%2e/', '.%2e/%2e./', '..' + String.fromCharCode(92) + '../']) {
      await assert.rejects(paypal.getByLink('https://' + host + '/v2/payments/' + escape + 'v1/identity/oauth2/userinfo'), PayPalError);
    }
  }
  assert.deepEqual(calls, []);
});

test('other origins, userinfo and sibling paths cannot trigger authenticated requests', async () => {
  const { paypal, calls } = client();
  for (const root of ['https://example.test', 'https://api-m.sandbox.paypal.com.example.test', 'http://api-m.sandbox.paypal.com', 'https://api-m.sandbox.paypal.com:444', 'https://api-m.paypal.com', 'https://person@api-m.sandbox.paypal.com']) {
    await assert.rejects(paypal.getByLink(root + '/v2/payments/captures/CAPTURE123'), PayPalError);
  }
  for (const path of ['/v2/payments-other/captures/CAPTURE123', '/v2/checkout/orders/ORDER123']) {
    await assert.rejects(paypal.getByLink('https://api-m.sandbox.paypal.com' + path), PayPalError);
  }
  for (const href of ['not a URL', '/v2/payments/captures/CAPTURE123']) await assert.rejects(paypal.getByLink(href), TypeError);
  assert.deepEqual(calls, []);
});

test('the accepted alias follows the configured PayPal environment', async () => {
  const { paypal, calls, record } = client('https://api-m.paypal.com');
  assert.deepEqual(await paypal.getByLink('https://api.paypal.com/v2/payments/captures/CAPTURE123'), record);
  assert.equal(calls.at(-1)[0], 'https://api-m.paypal.com/v2/payments/captures/CAPTURE123');
  const count = calls.length;
  await assert.rejects(paypal.getByLink('https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE123'), PayPalError);
  assert.equal(calls.length, count);
});
