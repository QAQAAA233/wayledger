import { UserFacingError } from './engine.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const STATUS_BY_CODE = { NOT_FOUND: 404, BAD_INPUT: 400, RATE_LIMIT: 429 };

// Errors cross the Durable Object boundary as plain data ({ name, message, code, debugId }).
function failure({ name, message, code, debugId }) {
  if (name === 'UserFacingError') return json({ error: { message, code } }, STATUS_BY_CODE[code] ?? 409);
  if (name === 'AIError') return json({ error: { message, code: 'AI_FAILED', retry: true } }, 502);
  if (name === 'PayPalError') return json({ error: { message, code: 'PAYPAL_FAILED', debugId, retry: true } }, 502);
  return json({ error: { message: 'Something went wrong on our side. Nothing was changed.', code: 'INTERNAL' } }, 500);
}

const unwrap = (res) => (res.ok ? json(res.v) : failure(res.e));

// Cheap abuse guard for the public demo: caps on model calls per visitor and per day. A judge code
// (a Worker secret given in the testing instructions) lifts the per-visitor limit and moves the
// visitor to a separate, larger daily budget, so judging is never blocked by the public limits.
async function guardAI(env, request) {
  const q = env.QUOTA.get(env.QUOTA.idFromName('q'));
  const day = new Date().toISOString().slice(0, 10);
  const code = request.headers.get('x-judge-code');
  if (env.JUDGE_CODE && code && code === env.JUDGE_CODE) {
    if (!(await q.take(`judge:${day}`, Number(env.AI_JUDGE_PER_DAY ?? 600), 86400_000))) throw new UserFacingError('The judging budget for today is used up. It resets at 00:00 UTC.', 'RATE_LIMIT');
    return;
  }
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  if (!(await q.take(`ip:${ip}`, Number(env.AI_PER_IP_HOUR ?? 15), 3600_000))) throw new UserFacingError('This connection has used its demo allowance for now. It refills within the hour. Judges can use the judge code from the testing instructions.', 'RATE_LIMIT');
  if (!(await q.take(`day:${day}`, Number(env.AI_PER_DAY ?? 400), 86400_000))) throw new UserFacingError('The public demo reached its daily limit. It resets at 00:00 UTC. Judges can use the judge code from the testing instructions.', 'RATE_LIMIT');
}

// `env.TRIP` and `env.QUOTA` are Durable Object namespaces in production and in-memory stand-ins in tests.
export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // api, trips, :id, ...
  try {
    if (url.pathname === '/api/config') return json({ paypalClientId: env.PAYPAL_CLIENT_ID, mode: 'sandbox' });
    if (parts[0] !== 'api' || parts[1] !== 'trips') return json({ error: { message: 'Not found' } }, 404);

    if (parts.length === 2 && request.method === 'POST') {
      const { prompt } = await request.json().catch(() => ({}));
      if (typeof prompt !== 'string' || prompt.trim().length < 8 || prompt.length > 1200) throw new UserFacingError('Describe the trip in a sentence or two (8-1200 characters).', 'BAD_INPUT');
      await guardAI(env, request);
      const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
      return unwrap(await env.TRIP.get(env.TRIP.idFromName(id)).call('createTrip', [id, prompt.trim()]));
    }

    const id = parts[2];
    if (!/^[0-9a-f]{24}$/.test(id ?? '')) return json({ error: { message: 'Not found' } }, 404);
    const trip = env.TRIP.get(env.TRIP.idFromName(id));
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (parts.length === 3 && request.method === 'GET') return unwrap(await trip.call('view', []));
    if (parts[3] === 'reconcile') return unwrap(await trip.call('reconcile', []));
    if (parts[3] === 'close' && request.method === 'POST') return unwrap(await trip.call('closeTrip', []));
    if (parts[3] === 'changes' && request.method === 'POST') {
      if (typeof body.text !== 'string' || body.text.trim().length < 4 || body.text.length > 800) throw new UserFacingError('Describe what changed (4-800 characters).', 'BAD_INPUT');
      // Look the trip up before spending any allowance: a request for a trip that does not exist costs nothing.
      const found = await trip.call('exists', []);
      if (!found.ok) return failure(found.e);
      await guardAI(env, request);
      return unwrap(await trip.call('requestChange', [body.text.trim()]));
    }
    if (parts[3] === 'proposals' && request.method === 'POST') {
      const pid = parts[4];
      if (parts[5] === 'confirm') return unwrap(await trip.call('confirm', [pid, String(body.digest ?? '')]));
      if (parts[5] === 'order') return unwrap(await trip.call('createOrder', [pid, body.fundingSource === 'card' ? 'card' : 'paypal']));
      if (parts[5] === 'approve') return unwrap(await trip.call('approveOrder', [pid, String(body.orderId ?? '')]));
      if (parts[5] === 'retry') return unwrap(await trip.call('retry', [pid]));
      if (parts[5] === 'refresh') return unwrap(await trip.call('refreshProposal', [pid]));
    }
    return json({ error: { message: 'Not found' } }, 404);
  } catch (e) {
    if (e instanceof UserFacingError) return failure({ name: 'UserFacingError', message: e.message, code: e.code });
    console.error(e);
    return json({ error: { message: 'Something went wrong on our side. Nothing was changed.', code: 'INTERNAL' } }, 500);
  }
}
