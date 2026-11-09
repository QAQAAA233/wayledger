import { DurableObject } from 'cloudflare:workers';
import { handleRequest } from './api.js';
import { createTripRunner } from './trip-runner.js';
import { takeQuota } from './quota.js';
import { createPayPal } from './paypal.js';
import { createAI } from './ai.js';

// One Durable Object per trip. The runner serializes requests because a PayPal call awaits
// network I/O and must not interleave with another money step on the same trip.
export class TripDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runner = createTripRunner({
      storage: ctx.storage,
      paypal: createPayPal({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, base: env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com' }),
      ai: createAI(env),
    });
  }

  call(method, args) {
    return this.runner.call(method, args);
  }
}

// Public demo allowances (see guardAI in api.js).
export class Quota extends DurableObject {
  take(key, limit, windowMs) {
    return takeQuota(this.ctx.storage, key, limit, windowMs);
  }
}

export default { fetch: handleRequest };
