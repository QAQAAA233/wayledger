import { UserFacingError } from './engine.js';
import { createPayPal } from './paypal.js';
import { verifyWebhook, tripIdOf } from './webhooks.js';
import { DEFAULT_DAILY_NEURONS } from './quota.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const STATUS_BY_CODE = { NOT_FOUND: 404, BAD_INPUT: 400, RATE_LIMIT: 429, NOT_OWNER: 403, BAD_SIGNATURE: 401 };

// Errors cross the Durable Object boundary as plain data ({ name, message, code, debugId }).
function failure({ name, message, code, debugId, issue }) {
  if (name === 'UserFacingError') return json({ error: { message, code } }, STATUS_BY_CODE[code] ?? 409);
  if (name === 'AIError') return json({ error: { message, code: 'AI_FAILED', retry: true } }, 502);
  if (name === 'PayPalError') return json({ error: { message, code: 'PAYPAL_FAILED', debugId, issue, retry: true } }, 502);
  return json({ error: { message: 'Something went wrong on our side. Nothing was changed.', code: 'INTERNAL' } }, 500);
}

const unwrap = (res, status = 200) => (res.ok ? json(res.v, status) : failure(res.e));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Cheap abuse guard for the public demo: caps on model calls per visitor and per day, and the AI's own daily money
// guard. A judge code (a Worker secret given in the testing instructions) lifts the per-visitor limit and moves the
// visitor to a separate, larger daily budget. The day's AI allowance is split: the public may use AI_PUBLIC_SHARE of it
// (70% by default) and the rest is kept for judges, so judging is never blocked by the public using the day up. When
// the whole allowance is gone nobody starts anything, and the person is told so plainly.
async function guardAI(env, request) {
  const q = env.QUOTA.get(env.QUOTA.idFromName('q'));
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.AI_DAILY_NEURONS ?? DEFAULT_DAILY_NEURONS);
  const code = request.headers.get('x-judge-code');
  const judge = Boolean(env.JUDGE_CODE && code && code === env.JUDGE_CODE);
  const used = await q.neuronsToday(day);
  if (used >= cap) {
    throw new UserFacingError("Today's AI budget for this demo is used up, so the agent cannot start. Your trips and money are unchanged. It resets at 00:00 UTC.", 'RATE_LIMIT');
  }
  if (!judge && used >= Math.floor(cap * Number(env.AI_PUBLIC_SHARE ?? 0.7))) {
    throw new UserFacingError("The public share of today's AI budget for this demo is used up, so the agent cannot start for now. Your trips and money are unchanged. Judges can use the judge code from the testing instructions. It resets at 00:00 UTC.", 'RATE_LIMIT');
  }
  if (judge) {
    if (!(await q.take(`judge:${day}`, Number(env.AI_JUDGE_PER_DAY ?? 600), 86400_000))) throw new UserFacingError('The judging budget for today is used up. It resets at 00:00 UTC.', 'RATE_LIMIT');
    return;
  }
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  if (!(await q.take(`ip:${ip}`, Number(env.AI_PER_IP_HOUR ?? 15), 3600_000))) throw new UserFacingError('This connection has used its demo allowance for now. It refills within the hour. Judges can use the judge code from the testing instructions.', 'RATE_LIMIT');
  if (!(await q.take(`day:${day}`, Number(env.AI_PER_DAY ?? 400), 86400_000))) throw new UserFacingError('The public demo reached its daily limit. It resets at 00:00 UTC. Judges can use the judge code from the testing instructions.', 'RATE_LIMIT');
}

const dollarsToCents = (v) => Math.round(Number(v) * 100);

// `env.TRIP` and `env.QUOTA` are Durable Object namespaces in production and in-memory stand-ins in tests.
// `deps.paypal` lets a test replace the PayPal client the webhook route uses.
export async function handleRequest(request, env, deps = {}) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // api, trips, :id, ...
  try {
    if (url.pathname === '/api/config') return json({ paypalClientId: env.PAYPAL_CLIENT_ID, mode: 'sandbox' });

    if (parts[0] === 'api' && parts[1] === 'webhooks' && parts[2] === 'paypal' && request.method === 'POST') {
      const rawBody = await request.text();
      if (rawBody.length > 200_000) return json({ error: { message: 'Too large.', code: 'BAD_INPUT' } }, 413);
      const paypal = deps.paypal ?? createPayPal({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, base: env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com' });
      if (!(await verifyWebhook({ paypal, webhookId: env.PAYPAL_WEBHOOK_ID, headers: request.headers, rawBody }))) {
        return json({ error: { message: 'The signature could not be verified.', code: 'BAD_SIGNATURE' } }, 401);
      }
      const event = JSON.parse(rawBody);
      const tripId = await tripIdOf(event, paypal);
      if (!tripId) return json({ ok: true, ignored: 'not about a trip of ours' });
      return unwrap(await env.TRIP.get(env.TRIP.idFromName(tripId)).call('webhook', [event]));
    }

    if (parts[0] !== 'api' || parts[1] !== 'trips') return json({ error: { message: 'Not found' } }, 404);
    const token = request.headers.get('x-owner-token');

    if (parts.length === 2 && request.method === 'POST') {
      const { prompt, startDate } = await request.json().catch(() => ({}));
      if (typeof prompt !== 'string' || prompt.trim().length < 8 || prompt.length > 1200) throw new UserFacingError('Describe the trip in a sentence or two (8-1200 characters).', 'BAD_INPUT');
      await guardAI(env, request);
      const id = hex(crypto.getRandomValues(new Uint8Array(12)));
      const ownerToken = hex(crypto.getRandomValues(new Uint8Array(24)));
      const ownerTokenHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerToken))));
      const res = await env.TRIP.get(env.TRIP.idFromName(id)).call('createTrip', [id, { prompt: prompt.trim(), startDate: startDate || null, ownerTokenHash }]);
      return res.ok ? json({ ...res.v, ownerToken }) : failure(res.e);
    }

    const id = parts[2];
    if (!/^[0-9a-f]{24}$/.test(id ?? '')) return json({ error: { message: 'Not found' } }, 404);
    const trip = env.TRIP.get(env.TRIP.idFromName(id));
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (parts.length === 3 && request.method === 'GET') return unwrap(await trip.call('view', [], token));
    if (parts[3] === 'runs' && parts[4] && request.method === 'GET') return unwrap(await trip.call('getRun', [parts[4]]));
    if (parts[3] === 'reconcile') return unwrap(await trip.call('reconcile', []));
    if (request.method !== 'POST') return json({ error: { message: 'Not found' } }, 404);

    if (parts[3] === 'close') return unwrap(await trip.call('closeTrip', [], token));
    if (parts[3] === 'rehold') return unwrap(await trip.call('rehold', [], token));
    if (parts[3] === 'budget') return unwrap(await trip.call('setBudget', [body.amount], token));
    if (parts[3] === 'documents') return unwrap(await trip.call('addDocument', [body.text], token));
    if (parts[3] === 'mandate') {
      const terms = body.enabled === false ? { enabled: false } : {
        enabled: true,
        refundCapCents: dollarsToCents(body.refundCap),
        planIncreaseCapCents: dollarsToCents(body.planIncreaseCap),
        validUntil: Date.parse(`${String(body.validUntil)}T23:59:59Z`),
      };
      return unwrap(await trip.call('setMandateTerms', [terms], token));
    }
    if (parts[3] === 'changes') {
      if (typeof body.text !== 'string' || body.text.trim().length < 4 || body.text.length > 800) throw new UserFacingError('Describe what changed (4-800 characters).', 'BAD_INPUT');
      // Look the trip up, and who is asking, before spending any allowance: a request for a trip that does not exist, or from
      // someone who may not act on it, costs nothing.
      const found = await trip.call('exists', []);
      if (!found.ok) return failure(found.e);
      const may = await trip.call('mayAct', [], token);
      if (!may.ok) return failure(may.e);
      await guardAI(env, request);
      return unwrap(await trip.call('startRun', [body.text.trim()], token), 202);
    }
    if (parts[3] === 'wake') {
      const found = await trip.call('exists', []);
      if (!found.ok) return failure(found.e);
      const may = await trip.call('mayAct', [], token);
      if (!may.ok) return failure(may.e);
      await guardAI(env, request);
      return unwrap(await trip.call('wake', [{ demo: body.demo === true }], token), 202);
    }
    if (parts[3] === 'proposals') {
      const pid = parts[4];
      if (parts[5] === 'confirm') return unwrap(await trip.call('confirm', [pid, String(body.digest ?? '')], token));
      if (parts[5] === 'order') return unwrap(await trip.call('createOrder', [pid, body.fundingSource === 'card' ? 'card' : 'paypal'], token));
      if (parts[5] === 'approve') return unwrap(await trip.call('approveOrder', [pid, String(body.orderId ?? '')], token));
      if (parts[5] === 'retry') return unwrap(await trip.call('retry', [pid], token));
      if (parts[5] === 'refresh') return unwrap(await trip.call('refreshProposal', [pid], token));
    }
    return json({ error: { message: 'Not found' } }, 404);
  } catch (e) {
    if (e instanceof UserFacingError) return failure({ name: 'UserFacingError', message: e.message, code: e.code });
    console.error(e);
    return json({ error: { message: 'Something went wrong on our side. Nothing was changed.', code: 'INTERNAL' } }, 500);
  }
}
