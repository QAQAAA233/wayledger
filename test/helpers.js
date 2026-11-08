import { createEngine } from '../src/engine.js';
import { fromCents } from '../src/domain/money.js';

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
    if (path === '/v2/checkout/orders' && method === 'POST') { const id = `ORDER${++n}`; orders.set(id, body); return res(201, { id, status: 'CREATED' }); }
    let m;
    if ((m = path.match(/^\/v2\/checkout\/orders\/(\w+)\/authorize$/))) {
      const o = orders.get(m[1]);
      return res(201, { id: m[1], status: 'COMPLETED', purchase_units: o.purchase_units.map((pu) => {
        const id = `AUTH${++n}`;
        const value = skew[pu.reference_id] ?? pu.amount.value;
        auths.set(id, { id, status: 'CREATED', amount: { value, currency_code: 'USD' } });
        return { reference_id: pu.reference_id, payments: { authorizations: [{ id }] } };
      }) });
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)$/)) && method === 'GET') return res(200, auths.get(m[1]));
    if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)\/capture$/))) {
      const a = auths.get(m[1]); const id = `CAP${++n}`;
      caps.set(id, { id, status: 'COMPLETED', amount: body.amount }); a.status = 'CAPTURED'; return res(201, { id, status: 'COMPLETED' });
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)\/void$/))) { auths.get(m[1]).status = 'VOIDED'; return res(204, null); }
    if ((m = path.match(/^\/v2\/payments\/captures\/(\w+)$/)) && method === 'GET') return res(200, caps.get(m[1]));
    if ((m = path.match(/^\/v2\/payments\/captures\/(\w+)\/refund$/))) { const id = `REF${++n}`; refs.set(id, { id, status: 'COMPLETED', amount: body.amount }); return res(201, { id, status: 'COMPLETED' }); }
    if ((m = path.match(/^\/v2\/payments\/refunds\/(\w+)$/))) return res(200, refs.get(m[1]));
    return res(404, { name: 'NOT_FOUND', message: `no route ${method} ${path}` });
  };
  return { fetchImpl, calls, auths, caps, refs };
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
