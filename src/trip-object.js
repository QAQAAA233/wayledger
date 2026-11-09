import { createTripRunner } from './trip-runner.js';
import { createPayPal } from './paypal.js';
import { createAI } from './ai.js';
import { createAgentRunner } from './agent/runner.js';
import { createSources } from './agent/sources.js';
import { createToolkit } from './agent/toolkit.js';
import { spendGuard } from './spend.js';
import { UserFacingError, upgradeState } from './engine.js';

const errData = (e) => ({ name: e.constructor.name, message: e.message, code: e.code, debugId: e.debugId, issue: e.issue });

// Everything one trip's Durable Object does, without the Cloudflare class around it, so tests run the same code.
// State-changing calls run one at a time. The agent runs in the object's alarm, so a request never waits for it and
// the screen follows it by reading the run's record. `deps` replaces the edges in tests (PayPal, the models, the
// forecast and place sources, the AI budget, the clock).
export function createTripObject({ storage: raw, env, deps = {} }) {
  // every read of the trip's state goes through the upgrade, so no part of the app meets an older shape
  const storage = { get: async (k) => (k === 'state' ? upgradeState(await raw.get(k)) : raw.get(k)), put: (k, v) => raw.put(k, v), delete: (k) => raw.delete(k), setAlarm: (t) => raw.setAlarm(t) };
  const spend = deps.spend ?? spendGuard(env, deps.now);
  const paypal = deps.paypal ?? createPayPal({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, base: env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com' });
  const runner = createTripRunner({ storage, paypal, ai: deps.ai ?? createAI(env, { spend }), now: deps.now, ttlMs: deps.ttlMs });
  const cache = { get: (k) => storage.get(`cache:${k}`), put: (k, v) => storage.put(`cache:${k}`, v) };
  const agent = createAgentRunner({
    storage,
    trip: runner.facade,
    run: deps.run ?? ((id, input) => env.AI.run(id, input)),
    sources: deps.sources ?? createSources({ cache, toolkit: createToolkit({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET }) }),
    spend,
    models: deps.models ?? [env.AGENT_MODEL ?? 'gemma', env.AGENT_FALLBACK ?? 'oss'],
    now: deps.now,
    wakeEveryMs: Number(env.WAKE_EVERY_MS ?? 6 * 3_600_000),
  });

  const wrap = async (fn) => {
    try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e: errData(e) }; }
  };
  const requireOwner = async (token) => {
    if (!(await runner.isOwner(token))) throw new UserFacingError('Only the person who planned this trip can do that. Open the trip in the browser where you planned it.', 'NOT_OWNER');
  };

  async function call(method, args = [], token = null) {
    if (method === 'startRun') return wrap(async () => { await requireOwner(token); const r = await agent.start({ trigger: 'message', text: args[0] }); return { runId: r.id }; });
    if (method === 'wake') return wrap(async () => { await requireOwner(token); const r = await agent.wake({ simulated: Boolean(args[0]?.demo) }); return { runId: r?.id ?? null }; });
    if (method === 'getRun') return wrap(async () => {
      const r = await agent.getRun(args[0]);
      if (!r) throw new UserFacingError('Run not found.', 'NOT_FOUND');
      const { simulatedForecast, ...rest } = r;
      return rest;
    });
    if (method === 'webhook') {
      return wrap(async () => {
        const out = await runner.call('recordWebhook', [args[0]], null, true);
        if (!out.ok) throw Object.assign(new Error(out.e.message), { code: out.e.code });
        if (out.v.attention) {
          try { await agent.start({ trigger: 'webhook', diff: `PayPal reported ${args[0].event_type} for a hold the ledger still shows as open.` }); } catch { /* one run at a time, or the day's budget is spent */ }
        }
        return { stored: out.v.stored };
      });
    }
    const out = await runner.call(method, args, token);
    // The screen shows when the agent will look at the forecast next.
    if (method === 'view' && out.ok) out.v = { ...out.v, nextWakeAt: ((await storage.get('schedule')) ?? []).find((i) => i.kind === 'wake')?.at ?? null };
    // The agent's schedule starts with the first signed limits.
    if (out.ok && ['confirm', 'approveOrder', 'retry'].includes(method)) { try { await agent.ensureWake(); } catch (e) { console.error(e); } }
    return out;
  }

  // Durable Object alarm: whatever is due (an agent run, a scheduled forecast check). It never throws.
  async function alarm() {
    try { await agent.processDue(); } catch (e) { console.error('alarm failed', e); }
  }

  return { call, alarm, agent, runner };
}
