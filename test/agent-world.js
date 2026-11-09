import assert from 'node:assert/strict';
import { createPayPal } from '../src/paypal.js';
import { sha256Hex } from '../src/domain/hash.js';
import { fakePayPalFetch, fakeEnv, fakeSources, planner, untilRunDone, PLAN_PROMPT } from './helpers.js';
import { TERMS, PLAN, PLACES, STORM } from './storm.js';

// A booked trip with the agent's alarm running, for tests that script the model. The real engine, ledger, tools, guards,
// runner and alarm are all real; only the model, PayPal's HTTP and the forecast/place services are replaced at the edge.
export const CLOCK0 = Date.parse('2026-05-01T09:00:00Z');
// the buffer in the hold is as big as the raise allowed: $180, enough to set aside the replacement for the $180 boat tour
export const TERMS_OK = { enabled: true, refundCapCents: 21000, planIncreaseCapCents: 18000, validUntil: Date.parse('2026-05-10T00:00:00Z') };

export async function world({ run, sources = fakeSources({ forecasts: STORM, places: PLACES }), terms, checkout = true, vars = {}, spend, plan = PLAN, docs = true, models } = {}) {
  const clock = { t: CLOCK0 };
  const fake = fakePayPalFetch({ now: () => clock.t });
  const paypal = createPayPal({ clientId: 'id', secret: 's', fetchImpl: fake.fetchImpl });
  const w = fakeEnv({ paypal, run, sources, ai: planner(plan), now: () => clock.t, vars, spend, models });
  const id = 'ab'.repeat(12);
  const token = 'owner-secret';
  const trip = w.env.TRIP.get(id);
  const created = await trip.call('createTrip', [id, { prompt: PLAN_PROMPT, startDate: '2026-05-04', ownerTokenHash: await sha256Hex(token) }]);
  assert.ok(created.ok, JSON.stringify(created));
  const call = (m, a = []) => trip.call(m, a, token);
  if (terms) assert.ok((await call('setMandateTerms', [terms])).ok);
  if (checkout) {
    const p = (await call('view')).v.proposal;
    assert.ok((await call('confirm', [p.id, p.digest])).ok);
    const o = await call('createOrder', [p.id]);
    assert.ok((await call('approveOrder', [p.id, o.v.orderId])).ok);
  }
  if (docs) assert.ok((await call('addDocument', [TERMS])).ok);
  return { w, trip, call, clock, fake, id, token, view: async () => (await call('view')).v, state: () => w.storageOf(id).mem.get('state') };
}

export const STORM_REQUEST = 'A storm is forecast for the boat tour day. Swap it for something indoors.';
export const startRun = async (wd, text = STORM_REQUEST) => {
  const r = await wd.call('startRun', [text]);
  assert.ok(r.ok, JSON.stringify(r));
  return untilRunDone(wd.w.env, wd.id, r.v.runId, { token: wd.token });
};
// The schedule's own wake-up with a forecast difference, the way the evaluation starts it.
export const wakeRun = async (wd, diff = 'Forecast now: 2026-05-05: thunderstorms, 90% chance of rain, wind up to 60 km/h.') => {
  const r = await wd.w.objects.get(wd.id).agent.start({ trigger: 'wake', diff });
  return untilRunDone(wd.w.env, wd.id, r.id, { token: wd.token });
};
export const moneyCalls = (wd) => wd.fake.calls.filter((c) => /POST .*\/(orders|authorize|capture|void|refund)/.test(c));
export const titles = (run) => run.events.filter((e) => e.title).map((e) => e.title);
