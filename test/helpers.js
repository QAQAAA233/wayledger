import { readFileSync } from 'node:fs';
import { createEngine } from '../src/engine.js';
import { createTripObject } from '../src/trip-object.js';
import { addNeurons, neuronsToday, takeQuota } from '../src/quota.js';
import { fromCents } from '../src/domain/money.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).samples;
// Real PayPal sandbox responses, captured with the scripts in eval/ (see each fixture's note). The fake below builds
// every answer by copying one of these and changing the ids, amounts and statuses, so the shapes are PayPal's own.
const SANDBOX_ORDER = fixture('sandbox_create_order.json');
const SANDBOX = fixture('sandbox_resources.json');
const clone = (o) => JSON.parse(JSON.stringify(o));
const cents = (s) => Math.round(Number(s) * 100);
export { cents };

// A stand-in for PayPal that behaves like the REST API at the HTTP layer, used only by tests.
// `skew` lets a test make PayPal answer with a different amount than we asked for.
export function fakePayPalFetch({ skew = {}, failOn = null, now = () => Date.now() } = {}) {
  const auths = new Map(); const caps = new Map(); const refs = new Map(); const orders = new Map();
  let n = 0; const calls = [];
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const res = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg123' } });

  const authBody = (a) => ({ ...clone(SANDBOX.get_authorization.body), id: a.id, status: a.status, amount: a.amount, custom_id: a.customId, create_time: iso(a.created), update_time: iso(now()), expiration_time: iso(a.created + 29 * 86400_000), supplementary_data: { related_ids: { order_id: a.orderId } } });
  const capBody = (c) => ({ ...clone(SANDBOX.get_capture.body), id: c.id, status: c.status, amount: c.amount, custom_id: c.customId });
  const refBody = (r) => ({ id: r.id, status: r.status, amount: r.amount, create_time: iso(r.created), update_time: iso(r.created), note_to_payer: r.note, links: [] });
  const orderBody = (id) => {
    const o = orders.get(id);
    const base = clone(SANDBOX.get_order.body);
    const pu = o.body.purchase_units[0];
    const mine = [...auths.values()].filter((a) => a.orderId === id);
    base.id = id;
    base.status = o.authorized ? 'COMPLETED' : 'APPROVED';
    base.purchase_units[0] = {
      ...base.purchase_units[0], reference_id: pu.reference_id, amount: pu.amount, custom_id: pu.custom_id, description: pu.description, items: pu.items,
      payments: { authorizations: mine.map(authBody), captures: [...caps.values()].filter((c) => mine.some((a) => a.id === c.authId)).map(capBody), refunds: [...refs.values()].filter((r) => caps.get(r.capId) && mine.some((a) => a.id === caps.get(r.capId).authId)).map(refBody) },
    };
    return base;
  };

  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = init.body && !String(init.body).startsWith('grant_type') ? JSON.parse(init.body) : null;
    calls.push(`${method} ${path}`);
    if (path === '/v1/oauth2/token') return res(200, { access_token: 't', expires_in: 3600 });
    if (path === '/v1/notifications/verify-webhook-signature') return res(200, { verification_status: body.transmission_sig === 'good-signature' && body.webhook_id === 'WEBHOOK123' ? 'SUCCESS' : 'FAILURE' });
    if (failOn && `${method} ${path}`.match(failOn)) return res(422, { name: 'UNPROCESSABLE_ENTITY', message: 'Simulated failure', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
    if (path === '/v2/checkout/orders' && method === 'POST') {
      if (body.intent === 'AUTHORIZE' && (body.purchase_units?.length ?? 0) !== 1) {
        return res(422, { name: 'UNPROCESSABLE_ENTITY', message: 'UNSUPPORTED_INTENT', details: [{ issue: 'UNSUPPORTED_INTENT' }] });
      }
      const id = `ORDER${++n}`; orders.set(id, { body });
      // PayPal answers a wallet order with 200 PAYER_ACTION_REQUIRED + a payer-action link, other orders with 201 CREATED.
      const sample = body.payment_source?.paypal ? SANDBOX_ORDER.create_order_paypal_source : SANDBOX_ORDER.create_order_card_source;
      return res(sample.status, { ...sample.body, id });
    }
    let m;
    if ((m = path.match(/^\/v2\/checkout\/orders\/(\w+)$/)) && method === 'GET') return res(200, orderBody(m[1]));
    if ((m = path.match(/^\/v2\/checkout\/orders\/(\w+)\/authorize$/))) {
      const o = orders.get(m[1]);
      o.authorized = true;
      return res(201, { id: m[1], status: 'COMPLETED', purchase_units: o.body.purchase_units.map((pu) => {
        const id = `AUTH${++n}`;
        const items = (pu.items ?? [{ sku: pu.reference_id, unit_amount: pu.amount }]).map((it) => ({
          ...it,
          unit_amount: { currency_code: 'USD', value: skew[it.sku] ?? it.unit_amount.value },
        }));
        const totalCents = items.reduce((a, it) => a + Math.round(Number(it.unit_amount.value) * 100), 0);
        auths.set(id, { id, status: 'CREATED', orderId: m[1], customId: pu.custom_id, created: now(), amount: { value: fromCents(totalCents), currency_code: 'USD' } });
        return { reference_id: pu.reference_id, items, payments: { authorizations: [authBody(auths.get(id))] } };
      }) });
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)$/)) && method === 'GET') return res(200, authBody(auths.get(m[1])));
    if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)\/capture$/))) {
      const a = auths.get(m[1]); const id = `CAP${++n}`;
      caps.set(id, { id, status: 'COMPLETED', amount: body.amount, authId: a.id, customId: a.customId });
      a.captured = (a.captured ?? 0) + Math.round(Number(body.amount.value) * 100);
      a.status = a.captured >= Math.round(Number(a.amount.value) * 100) ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
      return res(201, { id, status: 'COMPLETED' });
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/(\w+)\/void$/))) { auths.get(m[1]).status = 'VOIDED'; return res(204, null); }
    if ((m = path.match(/^\/v2\/payments\/captures\/(\w+)$/)) && method === 'GET') return res(200, capBody(caps.get(m[1])));
    if ((m = path.match(/^\/v2\/payments\/captures\/(\w+)\/refund$/))) {
      const cap = caps.get(m[1]);
      const refundedSoFar = cap.refunded ?? 0;
      if (refundedSoFar + Math.round(Number(body.amount.value) * 100) > Math.round(Number(cap.amount.value) * 100)) {
        return res(422, { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed, semantically incorrect, or failed business validation.', details: [{ issue: 'REFUND_AMOUNT_EXCEEDED' }] });
      }
      const id = `REF${++n}`;
      refs.set(id, { id, status: 'COMPLETED', amount: body.amount, capId: cap.id, created: now(), note: body.note_to_payer });
      cap.refunded = refundedSoFar + Math.round(Number(body.amount.value) * 100);
      cap.status = cap.refunded >= Math.round(Number(cap.amount.value) * 100) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      return res(201, { id, status: 'COMPLETED' });
    }
    if ((m = path.match(/^\/v2\/payments\/refunds\/(\w+)$/))) return res(200, refBody(refs.get(m[1])));
    return res(404, { name: 'NOT_FOUND', message: `no route ${method} ${path}` });
  };
  return { fetchImpl, calls, auths, caps, refs, orders };
}

export const SAMPLE_PLAN = {
  title: 'Lisbon long weekend', destination: 'Lisbon', budget: 1200, budgetQuote: 'Budget $1,200 total', travelers: ['Ana', 'Ben', 'Cy'],
  items: [
    { day: 1, title: 'Alfama apartment (3 nights)', category: 'lodging', amount: 540, participants: ['Ana', 'Ben', 'Cy'] },
    { day: 2, title: 'Sunset boat tour', category: 'activity', amount: 180, participants: ['Ana', 'Ben', 'Cy'] },
    { day: 3, title: 'Sintra day trip', category: 'transport', amount: 120, participants: ['Ana', 'Ben'] },
  ],
};
// The person's request that SAMPLE_PLAN answers: the budget quote is in it word for word.
export const PLAN_PROMPT = 'Three friends, Ana, Ben and Cy, four days in Lisbon. Budget $1,200 total.';

export function memoryStore() {
  let state = null;
  return { get: async () => (state ? structuredClone(state) : state), put: async (s) => { state = structuredClone(s); }, peek: () => state };
}

// The engine alone, with a store you can read. `ai.planTrip(prompt, validate, opts)` is the only model call it makes.
export function makeEngine({ ai, paypal, clock = { t: 1_000_000 }, ttlMs }) {
  const store = memoryStore();
  const engine = createEngine({ store, paypal, ai, now: () => clock.t, ttlMs });
  return { engine, store, clock };
}

export const planner = (raw = SAMPLE_PLAN) => ({ planTrip: async (_p, validate) => validate(structuredClone(raw)) });

export async function newTrip(ctx, { prompt = PLAN_PROMPT, startDate = null, ownerTokenHash = 'owner-hash', id = 't1' } = {}) {
  return ctx.engine.createTrip(id, { prompt, startDate, ownerTokenHash });
}

// What the buyer does in PayPal: the person confirms, a PayPal order is created, the buyer approves.
export async function checkoutAsBuyer(ctx, { fundingSource = 'paypal' } = {}) {
  const s0 = ctx.store.peek();
  const p = s0.proposals[s0.activeProposal];
  await ctx.engine.confirm(p.id, p.digest);
  const { orderId } = await ctx.engine.createOrder(p.id, fundingSource);
  await ctx.engine.approveOrder(p.id, orderId);
  return p.id;
}

// ---- the Durable Object world, in memory -----------------------------------------------------------------------

const chat = (out) => ({
  choices: [{ index: 0, message: { role: 'assistant', content: out.text ?? '', tool_calls: (out.calls ?? []).map((c, k) => ({ id: `call_${k}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) } })) }, finish_reason: out.calls?.length ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240, neurons: out.neurons ?? 2 },
});

// A model that follows a script. Each step is `{ text?, calls?: [{name, args}] }`, or a function of what the model has
// been shown so far, so a step can depend on an earlier tool result. It is the stand-in for the real model in tests.
export function scriptedModel(steps) {
  let i = 0;
  const log = [];
  const run = async (modelId, input) => {
    log.push({ modelId, messages: structuredClone(input.messages), tools: input.tools?.map((t) => t.function.name) });
    const step = steps[Math.min(i++, steps.length - 1)];
    const out = typeof step === 'function' ? step({ messages: input.messages, turn: i }) : step;
    return chat(out);
  };
  run.log = log;
  return run;
}
// The last tool result the model has been shown, parsed.
export const lastToolResult = (messages) => { const t = [...messages].reverse().find((m) => m.role === 'tool'); return t ? JSON.parse(t.content) : null; };

export function fakeSources({ forecasts = {}, places = {}, paypal = null } = {}) {
  return {
    geocode: async () => ({ lat: 38.72, lon: -9.14 }),
    forecast: async ({ date }) => (forecasts[date] ? { available: true, date, source: 'Open-Meteo', weatherCode: 3, ...forecasts[date] } : { available: false, date, reason: 'No forecast is available: out of range.', source: 'Open-Meteo' }),
    places: async ({ kind }) => (places[kind] ? { available: true, places: places[kind].map((p) => ({ kind, indoor: true, ...p })), source: 'Wikidata' } : { available: false, reason: 'The places lookup did not answer. No places can be added right now.', source: 'Wikidata' }),
    paypalStatus: async (s) => (paypal ? paypal(s) : { available: false, reason: 'PayPal status is not available here.' }),
  };
}

// In-memory Durable Object storage with an alarm that really fires (after the delay it was set for).
function memoryStorage(onAlarm, now) {
  const mem = new Map();
  let timer = null;
  return {
    mem,
    get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : undefined),
    put: async (k, v) => { mem.set(k, structuredClone(v)); },
    delete: async (k) => { mem.delete(k); },
    // unref: a check set for hours ahead must not keep the test process alive
    setAlarm: async (at) => { clearTimeout(timer); timer = setTimeout(() => onAlarm(), Math.max(0, at - (now ? now() : Date.now()))); timer.unref?.(); },
    stop: () => clearTimeout(timer),
  };
}

// The Worker environment in memory: one trip object per id (the real createTripObject), a quota object, and the vars.
// `run` is the model stand-in, `sources` the forecast/places/PayPal-status stand-in. Both are used by every trip.
export function fakeEnv({ ai = planner(), paypal, run = scriptedModel([{ text: 'ok' }]), sources = fakeSources(), now, ttlMs, vars = {}, spend, models = ['gemma'] } = {}) {
  const objects = new Map();
  const stores = [];
  const quotaStore = memoryStorage(() => {});
  const q = { take: (k, l, w) => takeQuota(quotaStore, k, l, w), addNeurons: (d, n) => addNeurons(quotaStore, d, n), neuronsToday: (d) => neuronsToday(quotaStore, d) };
  const env = {
    PAYPAL_CLIENT_ID: 'test-client-id',
    PAYPAL_WEBHOOK_ID: 'WEBHOOK123',
    ...vars,
    QUOTA: { idFromName: (name) => name, get: () => q },
  };
  const objectFor = (id) => {
    if (!objects.has(id)) {
      const storage = memoryStorage(() => objects.get(id).alarm(), now);
      stores.push(storage);
      objects.set(id, createTripObject({ storage, env, deps: { paypal, ai, run, sources, now, ttlMs, spend, models } }));
      objects.get(id).storage = storage;
    }
    return objects.get(id);
  };
  env.TRIP = { idFromName: (name) => name, get: (id) => ({ call: (method, args, token) => objectFor(id).call(method, args, token) }) };
  return {
    env,
    quota: quotaStore.mem,
    objects,
    storageOf: (id) => objectFor(id).storage,
    stop: () => { stores.forEach((s) => s.stop()); quotaStore.stop(); },
  };
}

// Wait until the agent has finished the run (the alarm fires on its own); polls the trip object like the screen does.
export async function untilRunDone(env, tripId, runId, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await env.TRIP.get(tripId).call('getRun', [runId]);
    if (r.ok && ['done', 'error'].includes(r.v.status)) return r.v;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish: ${JSON.stringify(r.v?.status ?? r.e)}`);
    await new Promise((res) => setTimeout(res, 15));
  }
}

export { fromCents };
