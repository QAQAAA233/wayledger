import { readFileSync } from 'node:fs';
import { createEngine } from '../src/engine.js';
import { createTripRunner } from '../src/trip-runner.js';
import { takeQuota } from '../src/quota.js';
import { fromCents } from '../src/domain/money.js';

// Real PayPal sandbox responses to POST /v2/checkout/orders, captured with test/fixtures (see the file's note).
const SANDBOX_ORDER = JSON.parse(readFileSync(new URL('./fixtures/sandbox_create_order.json', import.meta.url), 'utf8')).samples;

// A stand-in for PayPal that behaves like the REST API at the HTTP layer, used only by tests.
// `skew` lets a test make PayPal answer with a different amount than we asked for.
export function fakePayPalFetch({ skew = {}, failOn = null } = {}) {
  const auths = new Map(); const caps = new Map(); const refs = new Map(); const orders = new Map();
  let n = 0; const calls = [];
  const res = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg123' } });
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = init.body && !String(init.body).startsWith('grant_type') ? JSON.parse(init.body) : null;
    calls.push(`${method} ${path}`);
    if (path === '/v1/oauth2/token') return res(200, { access_token: 't', expires_in: 3600 });
    if (failOn && `${method} ${path}`.match(failOn)) return res(422, { name: 'UNPROCESSABLE_ENTITY', message: 'Simulated failure', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
    if (path === '/v2/checkout/orders' && method === 'POST') {
      if (body.intent === 'AUTHORIZE' && (body.purchase_units?.length ?? 0) !== 1) {
        return res(422, { name: 'UNPROCESSABLE_ENTITY', message: 'UNSUPPORTED_INTENT', details: [{ issue: 'UNSUPPORTED_INTENT' }] });
      }
      const id = `ORDER${++n}`; orders.set(id, body);
      // PayPal answers a wallet order with 200 PAYER_ACTION_REQUIRED + a payer-action link, other orders with 201 CREATED.
      const sample = body.payment_source?.paypal ? SANDBOX_ORDER.create_order_paypal_source : SANDBOX_ORDER.create_order_card_source;
      return res(sample.status, { ...sample.body, id });
    }
    let m;
    if ((m = path.match(/^\/v2\/checkout\/orders\/(\w+)$/)) && method === 'GET') {
      const o = orders.get(m[1]);
      return res(200, { id: m[1], status: 'COMPLETED', purchase_units: o.purchase_units });
    }
    if ((m = path.match(/^\/v2\/checkout\/orders\/(\w+)\/authorize$/))) {
      const o = orders.get(m[1]);
      return res(201, { id: m[1], status: 'COMPLETED', purchase_units: o.purchase_units.map((pu) => {
        const id = `AUTH${++n}`;
        const items = (pu.items ?? [{ sku: pu.reference_id, unit_amount: pu.amount }]).map((it) => ({
          ...it,
          unit_amount: { currency_code: 'USD', value: skew[it.sku] ?? it.unit_amount.value },
        }));
        const totalCents = items.reduce((a, it) => a + Math.round(Number(it.unit_amount.value) * 100), 0);
        auths.set(id, { id, status: 'CREATED', amount: { value: fromCents(totalCents), currency_code: 'USD' } });
        return { reference_id: pu.reference_id, items, payments: { authorizations: [{ id }] } };
      }) });
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)$/)) && method === 'GET') return res(200, auths.get(m[1]));
    if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)\/capture$/))) {
      const a = auths.get(m[1]); const id = `CAP${++n}`;
      caps.set(id, { id, status: 'COMPLETED', amount: body.amount });
      a.captured = (a.captured ?? 0) + Math.round(Number(body.amount.value) * 100);
      a.status = a.captured >= Math.round(Number(a.amount.value) * 100) ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
      return res(201, { id, status: 'COMPLETED' });
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)\/void$/))) { auths.get(m[1]).status = 'VOIDED'; return res(204, null); }
    if ((m = path.match(/^\/v2\/payments\/captures\/(\w+)$/)) && method === 'GET') return res(200, caps.get(m[1]));
    if ((m = path.match(/^\/v2\/payments\/captures\/(\w+)\/refund$/))) {
      const cap = caps.get(m[1]);
      const id = `REF${++n}`;
      refs.set(id, { id, status: 'COMPLETED', amount: body.amount });
      cap.refunded = (cap.refunded ?? 0) + Math.round(Number(body.amount.value) * 100);
      cap.status = cap.refunded >= Math.round(Number(cap.amount.value) * 100) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      return res(201, { id, status: 'COMPLETED' });
    }
    if ((m = path.match(/^\/v2\/payments\/refunds\/(\w+)$/))) return res(200, refs.get(m[1]));
    return res(404, { name: 'NOT_FOUND', message: `no route ${method} ${path}` });
  };
  return { fetchImpl, calls, auths, caps, refs, orders };
}

export const SAMPLE_PLAN = {
  title: 'Lisbon long weekend', destination: 'Lisbon', budget: 1200, travelers: ['Ana', 'Ben', 'Cy'],
  items: [
    { day: 1, title: 'Alfama apartment (3 nights)', category: 'lodging', amount: 540, participants: ['Ana', 'Ben', 'Cy'] },
    { day: 2, title: 'Sunset boat tour', category: 'activity', amount: 180, participants: ['Ana', 'Ben', 'Cy'] },
    { day: 3, title: 'Sintra day trip', category: 'transport', amount: 120, participants: ['Ana', 'Ben'] },
  ],
};

export function memoryStore() {
  let state = null;
  return { get: async () => (state ? structuredClone(state) : state), put: async (s) => { state = structuredClone(s); }, peek: () => state };
}

export function makeEngine({ ai, paypal, clock = { t: 1_000_000 } }) {
  const store = memoryStore();
  const engine = createEngine({ store, paypal, ai, now: () => clock.t });
  return { engine, store, clock };
}

export const cents = (s) => Math.round(Number(s) * 100);
export { fromCents };

// An in-memory stand-in for the Worker environment: a Durable Object namespace per kind, backed by the
// real trip runner, so route and browser tests exercise the real routing, engine and ledger.
export function fakeEnv({ ai, paypal, now = () => Date.now(), ttlMs, vars = {} } = {}) {
  const runners = new Map();
  const memory = () => {
    const mem = new Map();
    return { mem, storage: { get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : undefined), put: async (k, v) => { mem.set(k, structuredClone(v)); } } };
  };
  const quota = memory();
  const runnerFor = (id) => {
    if (!runners.has(id)) runners.set(id, createTripRunner({ storage: memory().storage, paypal, ai, now, ttlMs }));
    return runners.get(id);
  };
  return {
    env: {
      PAYPAL_CLIENT_ID: 'test-client-id',
      ...vars,
      TRIP: { idFromName: (name) => name, get: (id) => ({ call: (method, args) => runnerFor(id).call(method, args) }) },
      QUOTA: { idFromName: (name) => name, get: () => ({ take: (key, limit, windowMs) => takeQuota(quota.storage, key, limit, windowMs) }) },
    },
    quota: quota.mem,
  };
}
