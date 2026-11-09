import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { createPayPal } from '../src/paypal.js';
import { fakeEnv, fakePayPalFetch, SAMPLE_PLAN } from './helpers.js';

const call = (env, method, path, body, headers = {}) =>
  handleRequest(new Request(`https://wayledger.test${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env)
    .then(async (r) => ({ status: r.status, body: await r.json() }));

function setup(vars = {}) {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const script = { calls: 0 };
  const ai = {
    planTrip: async (_p, validate) => { script.calls++; return validate(SAMPLE_PLAN); },
    changeTrip: async (_plan, _t, validate) => { script.calls++; return validate({ summary: 'ok', operations: [{ op: 'reprice', itemId: 'i2', amount: 150 }] }); },
  };
  return { ...fakeEnv({ ai, paypal, vars }), script, fake };
}
const IP = { 'cf-connecting-ip': '203.0.113.7' };
const NO_SUCH_TRIP = 'a'.repeat(24);

test('asking about a trip that does not exist costs nothing from the demo allowance', async () => {
  const { env, quota, script } = setup({ AI_PER_IP_HOUR: '3' });
  for (let i = 0; i < 6; i++) {
    const r = await call(env, 'POST', `/api/trips/${NO_SUCH_TRIP}/changes`, { text: 'It will rain on Saturday' }, IP);
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'NOT_FOUND');
  }
  assert.equal(quota.has('ip:203.0.113.7'), false, 'no allowance was spent');
  assert.equal(script.calls, 0, 'the model was never called');
  const made = await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends, $1200' }, IP);
  assert.equal(made.status, 200);
  assert.equal(quota.get('ip:203.0.113.7').n, 1, 'a real request still spends exactly one');
});

test('a visitor over the hourly allowance gets a clear 429, and a plain retry button is not offered', async () => {
  const { env } = setup({ AI_PER_IP_HOUR: '2' });
  for (let i = 0; i < 2; i++) assert.equal((await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends' }, IP)).status, 200);
  const r = await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends' }, IP);
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, 'RATE_LIMIT');
  assert.equal(r.body.error.retry, undefined, 'retrying immediately cannot help, so the error is not marked retryable');
});

test('a judge code lifts the per-visitor limit, keeps its own daily budget, and a wrong code gets nothing extra', async () => {
  const { env, quota } = setup({ AI_PER_IP_HOUR: '1', JUDGE_CODE: 'open-sesame', AI_JUDGE_PER_DAY: '3' });
  const judge = { ...IP, 'x-judge-code': 'open-sesame' };
  for (let i = 0; i < 3; i++) assert.equal((await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends' }, judge)).status, 200);
  const spent = await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends' }, judge);
  assert.equal(spent.status, 429, 'the judging budget is finite so a leaked code cannot run up the bill');
  assert.equal(quota.has('ip:203.0.113.7'), false, 'judges do not use the public visitor allowance');

  const wrong = { ...IP, 'x-judge-code': 'guess' };
  assert.equal((await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends' }, wrong)).status, 200);
  assert.equal((await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends' }, wrong)).status, 429);
});

test('without a configured judge code the header means nothing', async () => {
  const { env } = setup({ AI_PER_IP_HOUR: '1' });
  const h = { ...IP, 'x-judge-code': 'undefined' };
  assert.equal((await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends' }, h)).status, 200);
  assert.equal((await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends' }, h)).status, 429);
});

test('malformed input is a 400 and spends nothing', async () => {
  const { env, quota } = setup();
  const bad = await handleRequest(new Request('https://wayledger.test/api/trips', { method: 'POST', body: '{not json', headers: IP }), env);
  assert.equal(bad.status, 400);
  const short = await call(env, 'POST', '/api/trips', { prompt: 'hi' }, IP);
  assert.equal(short.status, 400);
  assert.equal(quota.size, 0);
});

test('the refresh route re-derives an expired proposal without calling the model', async () => {
  let t = 1_000_000;
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const script = { calls: 0 };
  const ai = { planTrip: async (_p, v) => { script.calls++; return v(SAMPLE_PLAN); }, changeTrip: async () => { throw new Error('unused'); } };
  const { env } = fakeEnv({ ai, paypal, now: () => t });
  const made = await call(env, 'POST', '/api/trips', { prompt: 'Lisbon for three friends' }, IP);
  const id = made.body.id; const first = made.body.proposal;
  t += 16 * 60 * 1000;
  const late = await call(env, 'POST', `/api/trips/${id}/proposals/${first.id}/confirm`, { digest: first.digest });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'EXPIRED');
  const again = await call(env, 'POST', `/api/trips/${id}/proposals/${first.id}/refresh`, {});
  assert.equal(again.status, 200);
  assert.notEqual(again.body.proposal.id, first.id);
  assert.equal(again.body.proposal.status, 'pending');
  assert.deepEqual(again.body.proposal.actions.map((a) => [a.type, a.cents]), first.actions.map((a) => [a.type, a.cents]));
  assert.ok(again.body.proposal.expiresAt > t);
  assert.equal(script.calls, 1, 'only the original planning call used the model');
});
