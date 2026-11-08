import { DurableObject } from 'cloudflare:workers';
import { createEngine, UserFacingError } from './engine.js';
import { createPayPal, PayPalError } from './paypal.js';
import { createAI, AIError } from './ai.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function errorResponse(e) {
  if (e instanceof UserFacingError) return json({ error: { message: e.message, code: e.code } }, e.code === 'NOT_FOUND' ? 404 : 409);
  if (e instanceof AIError) return json({ error: { message: e.message, code: 'AI_FAILED', retry: true } }, 502);
  if (e instanceof PayPalError) return json({ error: { message: e.message, code: 'PAYPAL_FAILED', debugId: e.debugId, retry: true } }, 502);
  console.error(e);
  return json({ error: { message: 'Something went wrong on our side. Nothing was changed.', code: 'INTERNAL' } }, 500);
}

// One Durable Object per trip. Requests are serialized because a PayPal call awaits
// network I/O and must not interleave with another money step on the same trip.
export class TripDO extends DurableObject {
  chain = Promise.resolve();

  engine() {
    const storage = this.ctx.storage;
    return createEngine({
      store: { get: () => storage.get('state'), put: (s) => storage.put('state', s) },
      paypal: createPayPal({ clientId: this.env.PAYPAL_CLIENT_ID, secret: this.env.PAYPAL_CLIENT_SECRET, base: this.env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com' }),
      ai: createAI(this.env),
    });
  }

  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async call(method, args) {
    return this.serial(async () => {
      const engine = this.engine();
      const state = await this.ctx.storage.get('state');
      if (method !== 'createTrip' && !state) throw new UserFacingError('Trip not found.', 'NOT_FOUND');
      if (method === 'view') return engine.view(state);
      if (method === 'reconcile') return engine.reconcile();
      if (method === 'createOrder') return engine.createOrder(...args);
      const out = await engine[method](...args);
      return engine.view(out);
    }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: { name: e.constructor.name, message: e.message, code: e.code, debugId: e.debugId } }));
  }
}

// Cheap abuse guard for the public demo: per-visitor and global daily caps on model calls.
export class Quota extends DurableObject {
  async take(key, limit, windowMs) {
    const now = Date.now();
    const rec = (await this.ctx.storage.get(key)) ?? { n: 0, reset: now + windowMs };
    if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
    if (rec.n >= limit) return false;
    rec.n++;
    await this.ctx.storage.put(key, rec);
    return true;
  }
}

async function guardAI(env, request) {
  const q = env.QUOTA.get(env.QUOTA.idFromName('q'));
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const day = new Date().toISOString().slice(0, 10);
  if (!(await q.take(`ip:${ip}`, Number(env.AI_PER_IP_HOUR ?? 15), 3600_000))) throw new UserFacingError('Demo limit reached for your connection. Please try again in an hour.', 'RATE_LIMIT');
  if (!(await q.take(`day:${day}`, Number(env.AI_PER_DAY ?? 400), 86400_000))) throw new UserFacingError('The public demo has reached its daily limit. Please try again tomorrow.', 'RATE_LIMIT');
}

function unwrap(res) {
  if (res.ok) return json(res.v);
  const { name, message, code, debugId } = res.e;
  if (name === 'UserFacingError') return json({ error: { message, code } }, code === 'NOT_FOUND' ? 404 : 409);
  if (name === 'AIError') return json({ error: { message, code: 'AI_FAILED', retry: true } }, 502);
  if (name === 'PayPalError') return json({ error: { message, code: 'PAYPAL_FAILED', debugId, retry: true } }, 502);
  return json({ error: { message: 'Something went wrong on our side. Nothing was changed.', code: 'INTERNAL' } }, 500);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // api, trips, :id, ...
    try {
      if (url.pathname === '/api/config') return json({ paypalClientId: env.PAYPAL_CLIENT_ID, mode: 'sandbox' });
      if (parts[0] !== 'api' || parts[1] !== 'trips') return json({ error: { message: 'Not found' } }, 404);

      if (parts.length === 2 && request.method === 'POST') {
        const { prompt } = await request.json();
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
      if (parts[3] === 'changes' && request.method === 'POST') {
        if (typeof body.text !== 'string' || body.text.trim().length < 4 || body.text.length > 800) throw new UserFacingError('Describe what changed (4-800 characters).', 'BAD_INPUT');
        await guardAI(env, request);
        return unwrap(await trip.call('requestChange', [body.text.trim()]));
      }
      if (parts[3] === 'proposals' && request.method === 'POST') {
        const pid = parts[4];
        if (parts[5] === 'confirm') return unwrap(await trip.call('confirm', [pid, String(body.digest ?? '')]));
        if (parts[5] === 'order') return unwrap(await trip.call('createOrder', [pid]));
        if (parts[5] === 'approve') return unwrap(await trip.call('approveOrder', [pid, String(body.orderId ?? '')]));
        if (parts[5] === 'retry') return unwrap(await trip.call('retry', [pid]));
      }
      return json({ error: { message: 'Not found' } }, 404);
    } catch (e) {
      return errorResponse(e);
    }
  },
};
