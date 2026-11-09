import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/api.js';
import { createPayPal } from '../src/paypal.js';
import { fakeEnv, fakePayPalFetch, fakeSources, scriptedModel, planner, SAMPLE_PLAN, PLAN_PROMPT } from './helpers.js';

// Second-round review, finding 7: the judges' share of the day's AI budget is theirs, and a request from someone who may
// not act on a trip costs nothing from anyone's allowance.
const call = (env, method, path, body, headers = {}) =>
  handleRequest(new Request(`https://wayledger.test${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env)
    .then(async (r) => ({ status: r.status, body: await r.json() }));
const SOON = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const IP = { 'cf-connecting-ip': '203.0.113.7' };
const T = (name, args = {}) => ({ name, args });

function setup(vars = {}) {
  const fake = fakePayPalFetch();
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const model = scriptedModel([{ calls: [T('get_trip')] }, { calls: [T('no_change', { note: 'nothing to do' })] }]);
  return fakeEnv({ ai: planner(), paypal, run: model, sources: fakeSources(), vars });
}
const plan = (env, headers = IP) => call(env, 'POST', '/api/trips', { prompt: PLAN_PROMPT, startDate: SOON }, headers);
const spendNeurons = (env, n) => env.QUOTA.get(env.QUOTA.idFromName('q')).addNeurons(new Date().toISOString().slice(0, 10), n);

test('finding 7: when the public has used its share of the day\'s AI budget, the judges still have theirs', async () => {
  const { env } = setup({ AI_DAILY_NEURONS: '1000', AI_PUBLIC_SHARE: '0.7', AI_PER_IP_HOUR: '50', JUDGE_CODE: 'open-sesame', AI_JUDGE_PER_DAY: '50' });
  await spendNeurons(env, 800); // more than the public 700, less than the day's 1000
  const publicTry = await plan(env);
  assert.equal(publicTry.status, 429);
  assert.equal(publicTry.body.error.code, 'RATE_LIMIT');
  assert.match(publicTry.body.error.message, /judge code/i, 'and the message tells a judge what to do');
  const judge = await plan(env, { ...IP, 'x-judge-code': 'open-sesame' });
  assert.equal(judge.status, 200, JSON.stringify(judge.body));
  await spendNeurons(env, 300); // the whole day is gone: nobody starts anything, judges included
  assert.equal((await plan(env, { ...IP, 'x-judge-code': 'open-sesame' })).status, 429);
});

test('finding 7: someone who may not act on a trip is refused before anything is spent, however often they try', async () => {
  const { env, quota } = setup({ AI_PER_IP_HOUR: '3' });
  const made = await plan(env);
  const { id, ownerToken } = made.body;
  for (let i = 0; i < 8; i++) {
    for (const path of ['changes', 'wake']) {
      const r = await call(env, 'POST', `/api/trips/${id}/${path}`, { text: 'Swap the boat tour please', demo: true }, { ...IP, 'x-owner-token': 'not-the-owner' });
      assert.equal(r.status, 403, path);
      assert.equal(r.body.error.code, 'NOT_OWNER');
    }
  }
  assert.equal(quota.get('ip:203.0.113.7').n, 1, 'only the planning used the allowance');
  const owner = await call(env, 'POST', `/api/trips/${id}/changes`, { text: 'Swap the boat tour please' }, { ...IP, 'x-owner-token': ownerToken });
  assert.equal(owner.status, 202, JSON.stringify(owner.body));
});

test('finding 7: the default split gives the public most of the day and keeps a share back for the judges', async () => {
  const { env } = setup({ AI_DAILY_NEURONS: '1000', AI_PER_IP_HOUR: '50' }); // no AI_PUBLIC_SHARE set
  await spendNeurons(env, 650);
  assert.equal((await plan(env)).status, 200, 'under the default public share');
  await spendNeurons(env, 100); // 750: over 70%
  assert.equal((await plan(env)).status, 429);
});
