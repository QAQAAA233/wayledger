import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { createPayPal } from '../src/paypal.js';
import { fakeEnv, fakePayPalFetch, fakeSources, scriptedModel, planner, untilRunDone, PLAN_PROMPT } from './helpers.js';

const call = (env, method, path, body, headers = {}, deps) =>
  handleRequest(new Request(`https://wayledger.test${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env, deps)
    .then(async (r) => ({ status: r.status, body: await r.json() }));

const SOON = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const IP = { 'cf-connecting-ip': '203.0.113.7' };
const NO_SUCH_TRIP = 'a'.repeat(24);
const T = (name, args = {}) => ({ name, args });

function setup({ vars = {}, run, sources } = {}) {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const script = { calls: 0 };
  const ai = { planTrip: async (_p, validate) => { script.calls++; return validate(structuredClone((await import('./helpers.js')).SAMPLE_PLAN)); } };
  const model = run ?? scriptedModel([{ calls: [T('get_trip')] }, { calls: [T('no_change', { note: 'nothing to do' })] }]);
  const w = fakeEnv({ ai, paypal, run: model, sources: sources ?? fakeSources(), vars });
  return { ...w, script, fake, paypal, model, stop: w.stop };
}
const plan = (env, headers = IP) => call(env, 'POST', '/api/trips', { prompt: PLAN_PROMPT, startDate: SOON }, headers);

test('asking about a trip that does not exist costs nothing from the demo allowance', async () => {
  const { env, quota, script, model } = setup({ vars: { AI_PER_IP_HOUR: '3' } });
  for (let i = 0; i < 6; i++) {
    for (const path of ['changes', 'wake']) {
      const r = await call(env, 'POST', `/api/trips/${NO_SUCH_TRIP}/${path}`, { text: 'It will rain on Saturday', demo: true }, IP);
      assert.equal(r.status, 404);
      assert.equal(r.body.error.code, 'NOT_FOUND');
    }
  }
  assert.equal(quota.has('ip:203.0.113.7'), false, 'no allowance was spent');
  assert.equal(script.calls + model.log.length, 0, 'the model was never called');
  const made = await plan(env);
  assert.equal(made.status, 200);
  assert.equal(quota.get('ip:203.0.113.7').n, 1, 'a real request still spends exactly one');
});

test('a visitor over the hourly allowance gets a clear 429, and a plain retry button is not offered', async () => {
  const { env } = setup({ vars: { AI_PER_IP_HOUR: '2' } });
  for (let i = 0; i < 2; i++) assert.equal((await plan(env)).status, 200);
  const r = await plan(env);
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, 'RATE_LIMIT');
  assert.equal(r.body.error.retry, undefined, 'retrying immediately cannot help, so the error is not marked retryable');
});

test('a judge code lifts the per-visitor limit, keeps its own daily budget, and a wrong code gets nothing extra', async () => {
  const { env, quota } = setup({ vars: { AI_PER_IP_HOUR: '1', JUDGE_CODE: 'open-sesame', AI_JUDGE_PER_DAY: '3' } });
  const judge = { ...IP, 'x-judge-code': 'open-sesame' };
  for (let i = 0; i < 3; i++) assert.equal((await plan(env, judge)).status, 200);
  const spent = await plan(env, judge);
  assert.equal(spent.status, 429, 'the judging budget is finite so a leaked code cannot run up the bill');
  assert.equal(quota.has('ip:203.0.113.7'), false, 'judges do not use the public visitor allowance');

  const wrong = { ...IP, 'x-judge-code': 'guess' };
  assert.equal((await plan(env, wrong)).status, 200);
  assert.equal((await plan(env, wrong)).status, 429);
});

test('without a configured judge code the header means nothing', async () => {
  const { env } = setup({ vars: { AI_PER_IP_HOUR: '1' } });
  const h = { ...IP, 'x-judge-code': 'undefined' };
  assert.equal((await plan(env, h)).status, 200);
  assert.equal((await plan(env, h)).status, 429);
});

test('malformed input is a 400 and spends nothing', async () => {
  const { env, quota } = setup();
  const bad = await handleRequest(new Request('https://wayledger.test/api/trips', { method: 'POST', body: '{not json', headers: IP }), env);
  assert.equal(bad.status, 400);
  const short = await call(env, 'POST', '/api/trips', { prompt: 'hi' }, IP);
  assert.equal(short.status, 400);
  const date = await call(env, 'POST', '/api/trips', { prompt: PLAN_PROMPT, startDate: 'someday' }, IP);
  assert.equal(date.status, 400);
  assert.equal(quota.has('neurons'), false);
});

test('only the person who planned a trip can act on it; anyone with the link can look, and does not see what is needed to confirm', async () => {
  const { env } = setup();
  const made = await plan(env);
  const { id, ownerToken } = made.body;
  assert.match(ownerToken, /^[0-9a-f]{48}$/);
  assert.equal(made.body.owner, true);
  const digest = made.body.proposal.digest;
  assert.match(digest, /^[0-9a-f]{64}$/);

  const stranger = await call(env, 'GET', `/api/trips/${id}`);
  assert.equal(stranger.status, 200);
  assert.equal(stranger.body.owner, false);
  assert.equal(stranger.body.proposal.digest, null, 'the digest is what a confirmation needs; strangers do not get it');
  const mine = await call(env, 'GET', `/api/trips/${id}`, undefined, { 'x-owner-token': ownerToken });
  assert.equal(mine.body.owner, true);
  assert.equal(mine.body.proposal.digest, digest);

  const pid = made.body.proposal.id;
  for (const [path, body] of [[`proposals/${pid}/confirm`, { digest }], [`proposals/${pid}/order`, {}], [`proposals/${pid}/approve`, { orderId: 'X' }], [`proposals/${pid}/refresh`, {}], ['close', {}], ['budget', { amount: 5000 }], ['documents', { text: 'Sunset boat tour: free cancellation until 6 May 12:00' }], ['mandate', { enabled: false }], ['changes', { text: 'Swap the boat tour please' }], ['wake', { demo: true }]]) {
    for (const headers of [{}, { 'x-owner-token': 'wrong' }, { 'x-owner-token': ownerToken.replace(/./, (c) => (c === 'a' ? 'b' : 'a')) }]) {
      const r = await call(env, 'POST', `/api/trips/${id}/${path}`, body, { ...IP, ...headers });
      assert.equal(r.status, 403, `${path} with ${JSON.stringify(headers)}`);
      assert.equal(r.body.error.code, 'NOT_OWNER');
    }
  }
  const ok = await call(env, 'POST', `/api/trips/${id}/proposals/${pid}/confirm`, { digest }, { 'x-owner-token': ownerToken });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.proposal.status, 'confirmed');
});

test('the agent runs in the background: the request returns at once and the screen follows the run', async () => {
  const { env, model } = setup();
  const made = await plan(env);
  const { id, ownerToken } = made.body;
  const h = { ...IP, 'x-owner-token': ownerToken };
  const started = await call(env, 'POST', `/api/trips/${id}/changes`, { text: 'A storm is forecast for day 2.' }, h);
  assert.equal(started.status, 202);
  const run = await untilRunDone(env, id, started.body.runId);
  assert.equal(run.final.kind, 'no_change');
  assert.equal(model.log.length, 2);
  const polled = await call(env, 'GET', `/api/trips/${id}/runs/${started.body.runId}`);
  assert.equal(polled.status, 200);
  assert.deepEqual(polled.body.events.filter((e) => e.title).map((e) => e.title), ['Read your message', 'Looked at your trip', 'Decided nothing needs to change', 'Nothing to change']);
  assert.equal((await call(env, 'GET', `/api/trips/${id}/runs/nope`)).status, 404);
  const view = await call(env, 'GET', `/api/trips/${id}`, undefined, { 'x-owner-token': ownerToken });
  assert.equal(view.body.runs[0].id, started.body.runId);
});

test('the AI\'s daily budget is a hard stop in code: when it is spent, nothing starts and the person is told plainly', async () => {
  const { env, quota, model, script } = setup({ vars: { AI_DAILY_NEURONS: '5' } });
  const made = await plan(env);
  assert.equal(made.status, 200);
  const day = new Date().toISOString().slice(0, 10);
  quota.set(`neurons:${day}`, 5);
  const calls = script.calls;
  const blocked = await plan(env);
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error.message, /AI budget.*used up.*trips and money are unchanged/i);
  const run = await call(env, 'POST', `/api/trips/${made.body.id}/changes`, { text: 'Swap the boat tour please' }, { ...IP, 'x-owner-token': made.body.ownerToken });
  assert.equal(run.status, 429);
  assert.equal(script.calls, calls, 'no planner call');
  assert.equal(model.log.length, 0, 'no agent call');
  quota.set(`neurons:${day}`, 4);
  assert.equal((await plan(env)).status, 200, 'it comes back by itself when the day turns or the budget allows');
});

test('budget, documents and limits are set by the person through their own routes, with input checked', async () => {
  const { env } = setup();
  const made = await plan(env);
  const { id, ownerToken } = made.body;
  const h = { ...IP, 'x-owner-token': ownerToken };
  assert.equal((await call(env, 'POST', `/api/trips/${id}/budget`, { amount: 'lots' }, h)).status, 400);
  assert.equal((await call(env, 'POST', `/api/trips/${id}/budget`, { amount: 100 }, h)).status, 409);
  const b = await call(env, 'POST', `/api/trips/${id}/budget`, { amount: 1500 }, h);
  assert.deepEqual([b.status, b.body.plan.budgetCents, b.body.plan.budgetSource], [200, 150000, 'user']);
  assert.equal((await call(env, 'POST', `/api/trips/${id}/documents`, { text: 'short' }, h)).status, 400);
  const d = await call(env, 'POST', `/api/trips/${id}/documents`, { text: 'Sunset boat tour: free cancellation until 6 May 12:00.' }, h);
  assert.equal(d.body.documents.length, 1);
  const m = await call(env, 'POST', `/api/trips/${id}/mandate`, { enabled: true, refundCap: 100, planIncreaseCap: 50, validUntil: SOON }, h);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.deepEqual([m.body.proposal.mandateTerms.refundCapCents, m.body.proposal.mandateTerms.planIncreaseCapCents], [10000, 5000]);
  assert.equal((await call(env, 'POST', `/api/trips/${id}/mandate`, { enabled: true, refundCap: -5, planIncreaseCap: 50, validUntil: SOON }, h)).status, 400);
});

test('the refresh route re-derives an expired proposal without calling the model', async () => {
  let t = Date.now();
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const script = { calls: 0 };
  const ai = { planTrip: async (_p, v) => { script.calls++; return v(structuredClone((await import('./helpers.js')).SAMPLE_PLAN)); } };
  const { env } = fakeEnv({ ai, paypal, now: () => t, run: scriptedModel([{ text: 'unused' }]) });
  const made = await call(env, 'POST', '/api/trips', { prompt: PLAN_PROMPT, startDate: SOON }, IP);
  const { id, ownerToken } = made.body; const first = made.body.proposal;
  const h = { 'x-owner-token': ownerToken };
  t += 16 * 60 * 1000;
  const late = await call(env, 'POST', `/api/trips/${id}/proposals/${first.id}/confirm`, { digest: first.digest }, h);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'EXPIRED');
  const again = await call(env, 'POST', `/api/trips/${id}/proposals/${first.id}/refresh`, {}, h);
  assert.equal(again.status, 200);
  assert.notEqual(again.body.proposal.id, first.id);
  assert.equal(again.body.proposal.status, 'pending');
  assert.deepEqual(again.body.proposal.actions.map((a) => [a.type, a.cents]), first.actions.map((a) => [a.type, a.cents]));
  assert.ok(again.body.proposal.expiresAt > t);
  assert.equal(script.calls, 1, 'only the original planning call used the model');
});

test('a trip saved by an earlier version opens read-only with the new parts empty, instead of failing', async () => {
  const { env, storageOf } = setup();
  const made = await plan(env);
  const { id } = made.body;
  const old = storageOf(id).mem.get('state');
  for (const k of ['documents', 'policies', 'webhooks', 'runs', 'mandate', 'mandateDraft', 'holdFrom', 'ownerTokenHash']) delete old[k];
  const seen = await call(env, 'GET', `/api/trips/${id}`);
  assert.equal(seen.status, 200);
  assert.deepEqual([seen.body.documents, seen.body.policies, seen.body.runs, seen.body.mandate, seen.body.owner], [[], [], [], null, false]);
  const tryIt = await call(env, 'POST', `/api/trips/${id}/close`, {}, { 'x-owner-token': made.body.ownerToken });
  assert.equal(tryIt.status, 403, 'nobody owns it any more, so nothing can be done to it');
});
