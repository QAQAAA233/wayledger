import { createEngine, UserFacingError } from './engine.js';

// One trip = one object. The runner serializes every call on that trip (a PayPal call awaits network
// I/O and must not interleave with another money step) and turns results and errors into plain data
// so they can cross the Durable Object boundary. It has no Cloudflare imports, so tests run it as is.
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

  async function dispatch(method, args) {
    const state = await storage.get('state');
    if (method !== 'createTrip' && !state) throw new UserFacingError('Trip not found.', 'NOT_FOUND');
    if (method === 'exists') return true;
    if (method === 'view') return engine.view(state);
    if (method === 'reconcile') return engine.reconcile();
    if (method === 'createOrder') return engine.createOrder(...args);
    return engine.view(await engine[method](...args));
  }

  return {
    call: (method, args = []) => serial(() => dispatch(method, args)).then(
      (v) => ({ ok: true, v }),
      (e) => ({ ok: false, e: { name: e.constructor.name, message: e.message, code: e.code, debugId: e.debugId } }),
    ),
  };
}
