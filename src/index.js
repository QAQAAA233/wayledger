import { DurableObject } from 'cloudflare:workers';
import { handleRequest } from './api.js';
import { createTripObject } from './trip-object.js';
import { addNeurons, neuronsToday, takeQuota } from './quota.js';

// One Durable Object per trip. The work is in createTripObject; this class only gives it its storage and its alarm.
export class TripDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.trip = createTripObject({ storage: ctx.storage, env });
  }

  call(method, args, token) { return this.trip.call(method, args, token); }

  alarm() { return this.trip.alarm(); }
}

// Public demo allowances (see guardAI in api.js) and the AI's daily money guard.
export class Quota extends DurableObject {
  take(key, limit, windowMs) { return takeQuota(this.ctx.storage, key, limit, windowMs); }
  addNeurons(day, n) { return addNeurons(this.ctx.storage, day, n); }
  neuronsToday(day) { return neuronsToday(this.ctx.storage, day); }
}

export default { fetch: (request, env) => handleRequest(request, env) };
