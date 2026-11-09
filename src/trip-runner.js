import { createEngine, UserFacingError } from './engine.js';
import { sha256Hex } from './domain/hash.js';

// One trip = one object. The runner runs every state-changing call on that trip one at a time (a PayPal call awaits
// network I/O and must not interleave with another money step) and turns results and errors into plain data so they
// can cross the Durable Object boundary. Reads never wait for a money step. It has no Cloudflare imports, so tests
// run it as is.
//
// Who may act: the person who planned the trip holds a secret token (its hash is stored with the trip). Anyone with the
// link can look; only the holder can confirm, approve, close, change the budget, paste documents or start the agent.
const OWNER_ONLY = new Set(['confirm', 'createOrder', 'approveOrder', 'retry', 'refreshProposal', 'rehold', 'closeTrip', 'setBudget', 'addDocument', 'setMandateTerms']);
const RETURNS_VIEW = new Set(['confirm', 'approveOrder', 'retry', 'refreshProposal', 'rehold', 'closeTrip', 'setBudget', 'addDocument', 'setMandateTerms', 'openDueCheckout']);
const READS = new Set(['view', 'exists', 'state']);
// What the agent and the webhook receiver may call on the trip without a person's token.
const INTERNAL = new Set(['recordPolicy', 'submitEdit', 'noteRun', 'reconcile', 'recordWebhook', 'openDueCheckout']);

const errData = (e) => ({ name: e.constructor.name, message: e.message, code: e.code, debugId: e.debugId, issue: e.issue });

export function createTripRunner({ storage, paypal, ai, now, ttlMs }) {
  const engine = createEngine({
    store: { get: () => storage.get('state'), put: (s) => storage.put('state', s) },
    paypal,
    ai,
    now,
    ttlMs,
  });
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const ownerOf = async (state, token) => Boolean(token) && engine.isOwner(state, await sha256Hex(String(token)));

  async function dispatch(method, args, token, internal) {
    if (method === 'createTrip') return engine.view(await engine.createTrip(...args), { owner: true });
    const state = await storage.get('state');
    if (!state) throw new UserFacingError('Trip not found.', 'NOT_FOUND');
    if (method === 'exists') return true;
    if (method === 'state') return state;
    if (method === 'view') {
      if (state.holdFrom && state.holdFrom <= new Date(engine.now()).toISOString().slice(0, 10)) await serial(() => engine.openDueCheckout());
      const s = await storage.get('state');
      return engine.view(s, { owner: await ownerOf(s, token) });
    }
    if (OWNER_ONLY.has(method) && !(await ownerOf(state, token))) throw new UserFacingError('Only the person who planned this trip can do that. Open the trip in the browser where you planned it.', 'NOT_OWNER');
    if (!OWNER_ONLY.has(method) && !INTERNAL.has(method) && !RETURNS_VIEW.has(method)) throw new UserFacingError('Unknown request.', 'NOT_FOUND');
    if (internal && !INTERNAL.has(method)) throw new UserFacingError('Not allowed.', 'NOT_FOUND');
    if (method === 'createOrder') return engine.createOrder(...args);
    if (RETURNS_VIEW.has(method)) return engine.view(await engine[method](...args), { owner: true });
    return engine[method](...args);
  }

  const call = (method, args = [], token = null, internal = false) => {
    const work = () => dispatch(method, args, token, internal);
    return (READS.has(method) ? work() : serial(work)).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: errData(e) }));
  };

  return {
    call,
    // For the agent: the same trip, no token, a short list of things it may do, and plain exceptions.
    facade: {
      state: () => storage.get('state'),
      simulate: async (ops) => engine.simulate(await storage.get('state'), ops),
      mutate: async (method, args = []) => {
        const r = await call(method, args, null, true);
        if (!r.ok) throw Object.assign(new Error(r.e.message), { code: r.e.code });
        return r.v;
      },
      reconcile: async () => {
        const r = await call('reconcile', [], null, true);
        if (!r.ok) throw Object.assign(new Error(r.e.message), { code: r.e.code });
        return r.v;
      },
    },
    isOwner: async (token) => ownerOf(await storage.get('state'), token),
  };
}
