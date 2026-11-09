import { runAgentLoop } from './loop.js';
import { createTools } from './tools.js';
import { AGENT_SYSTEM, userMessageFor } from './prompts.js';
import { dayDate, lastDay } from '../domain/plan.js';
import { UserFacingError } from '../engine.js';

// Runs the agent for one trip. A run is a record in the trip's storage whose trace grows event by event, so the screen
// can follow it while it works. The work itself happens in a Durable Object alarm, not inside a request: starting a
// run returns at once, and nothing about the agent ever blocks the calls that move money.
export const WAKE_EVERY_MS = 6 * 3_600_000;
const STALE_MS = 220_000;
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

const summaryOf = (run) => ({ id: run.id, trigger: run.trigger, status: run.status, startedAt: run.startedAt ?? run.createdAt, finishedAt: run.finishedAt ?? null, outcome: run.final ? `${run.final.kind}${run.final.outcome ? `:${run.final.outcome}` : ''}` : null, simulated: Boolean(run.simulated) });

// A forecast day counts as notable when it is stormy, very wet or very windy; used to decide whether a scheduled
// check is worth waking the model for. The model, not this code, decides what to do about it.
const notable = (f) => Boolean(f?.available) && (f.rainChancePct >= 70 || [95, 96, 99].includes(f.weatherCode) || f.windKph >= 50);
const bucket = (f) => (!f?.available ? 'none' : `${f.rainChancePct >= 70 ? 'wet' : f.rainChancePct >= 40 ? 'damp' : 'dry'}${[95, 96, 99].includes(f.weatherCode) ? '+thunder' : ''}${f.windKph >= 50 ? '+wind' : ''}`);
const line = (date, f) => `${date}: ${f.summary}, ${f.rainChancePct}% chance of rain, wind up to ${f.windKph} km/h`;

export function createAgentRunner({ storage, trip, run, sources, spend, models, now = () => Date.now(), wakeEveryMs = WAKE_EVERY_MS }) {
  const getRun = (id) => storage.get(`run:${id}`);
  const putRun = (r) => storage.put(`run:${r.id}`, r);

  async function activeRun() {
    const id = await storage.get('activeRun');
    if (!id) return null;
    const r = await getRun(id);
    if (!r || !['queued', 'running'].includes(r.status)) { await storage.delete('activeRun'); return null; }
    if (now() - (r.heartbeatAt ?? r.createdAt) > STALE_MS) {
      r.status = 'error'; r.finishedAt = now(); r.final = { kind: 'stopped', why: 'The agent was interrupted, so nothing was changed.' };
      r.events.push({ seq: r.events.length + 1, at: now(), kind: 'result', title: 'Stopped', detail: r.final.why });
      await putRun(r); await storage.delete('activeRun'); await trip.mutate('noteRun', [summaryOf(r)]);
      return null;
    }
    return r;
  }

  async function schedule(item) {
    const list = (await storage.get('schedule')) ?? [];
    list.push(item);
    await storage.put('schedule', list);
    await storage.setAlarm(Math.min(...list.map((i) => i.at)));
  }

  async function start({ trigger, text = '', diff = '', simulatedForecast = null }) {
    const s = await trip.state();
    if (!s?.plan) throw new UserFacingError('Trip not found.', 'NOT_FOUND');
    if (s.closedAt) throw new UserFacingError('This trip is closed. Start a new trip to plan something else.', 'TRIP_CLOSED');
    if (await activeRun()) throw new UserFacingError('The agent is already working on this trip. Wait for it to finish.', 'RUN_ACTIVE');
    const r = { id: uid(), tripId: s.id, trigger, text: String(text).slice(0, 800), diff, simulated: Boolean(simulatedForecast), simulatedForecast, status: 'queued', createdAt: now(), heartbeatAt: now(), events: [], final: null };
    await putRun(r);
    await storage.put('activeRun', r.id);
    await trip.mutate('noteRun', [summaryOf(r)]);
    await schedule({ id: uid(), at: now(), kind: 'run', runId: r.id });
    return r;
  }

  async function execute(runId) {
    const r = await getRun(runId);
    if (!r || r.status !== 'queued') return;
    r.status = 'running'; r.startedAt = now();
    const emit = async (e) => { r.events.push({ seq: r.events.length + 1, at: now(), ...e }); r.heartbeatAt = now(); await putRun(r); };
    await emit({ kind: 'wake', title: { message: 'Read your message', wake: 'Woke up for its scheduled check', demo: 'Woke up (demo button)' }[r.trigger] ?? 'Started', detail: r.trigger === 'message' ? `“${r.text}”` : r.diff, simulated: r.simulated });
    try {
      const s = await trip.state();
      const tools = createTools();
      const ctx = {
        runId: r.id, now, sources, seenPlaces: new Map(), simulated: new Map(), simulatedForecast: r.simulatedForecast,
        // what the traveler wrote in this run: the only words a name, a price or a share may be taken from
        travelerText: r.text,
        readState: () => trip.state(),
        simulate: (ops) => trip.simulate(ops),
        recordPolicy: (raw) => trip.mutate('recordPolicy', [raw]),
        submitEdit: (payload) => trip.mutate('submitEdit', [payload]),
      };
      const result = await runAgentLoop({
        system: AGENT_SYSTEM,
        userMessage: userMessageFor(r.trigger, { text: r.text, at: new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC', diff: r.diff }),
        tools, ctx, run, models, spend,
        emit,
        now,
      });
      r.final = result.final; r.stats = { modelCalls: result.modelCalls, nudges: result.nudges, neurons: result.neurons, ms: result.ms, model: result.model };
      const f = result.final;
      if (f.kind === 'submitted') {
        if (f.outcome === 'executed') await emit({ kind: 'result', title: 'Inside your limits, so it went ahead', detail: f.summary, effect: f.effect });
        else if (f.outcome === 'proposed') await emit({ kind: 'result', title: 'Waiting for your OK', detail: (f.reasons ?? []).join(' ') || f.summary, waiting: true });
        else if (f.outcome === 'updated') await emit({ kind: 'result', title: 'Updated the plan (no money moves)', detail: f.summary });
        else await emit({ kind: 'result', title: 'PayPal stopped partway', detail: 'The steps that went through are in the ledger. Retry finishes the rest.', failed: true });
        if (f.outcome === 'executed' && f.money) {
          const rec = await trip.reconcile();
          const ok = rec.rows.filter((x) => x.match).length;
          await emit({ kind: 'paypal_check', title: 'Checked PayPal against the ledger', detail: `${ok} of ${rec.rows.length} PayPal records match${rec.planCheck?.applicable ? (rec.planCheck.ok ? '; every item has the money the plan says' : '; the plan and the money disagree') : ''}.`, ok: rec.allMatch });
        }
      } else if (f.kind === 'asked') await emit({ kind: 'result', title: 'Needs your answer', detail: f.question, waiting: true });
      else if (f.kind === 'no_change') await emit({ kind: 'result', title: 'Nothing to change', detail: f.note });
      else await emit({ kind: 'result', title: 'Stopped', detail: f.why, failed: true });
      r.status = f.kind === 'stopped' ? 'error' : 'done';
    } catch (e) {
      r.status = 'error';
      r.final = { kind: 'stopped', why: 'Something went wrong, so nothing was changed.' };
      await emit({ kind: 'result', title: 'Stopped', detail: r.final.why, failed: true });
      console.error('agent run failed', e);
    }
    r.finishedAt = now();
    await putRun(r);
    await storage.delete('activeRun');
    await trip.mutate('noteRun', [summaryOf(r)]);
  }

  // A scheduled look at the forecast. A model is woken only when something worth deciding about is there.
  async function wake({ simulated = false } = {}) {
    const s = await trip.state();
    if (!s?.plan || s.closedAt) return null;
    const dates = [...new Set(s.plan.items.map((i) => i.day))].sort((a, b) => a - b).map((d) => [d, dayDate(s.plan.startDate, d)]).filter(([, date]) => date);
    if (simulated) {
      const day = s.plan.items.find((i) => i.category === 'activity')?.day ?? Math.min(2, lastDay(s.plan));
      const date = dayDate(s.plan.startDate, day);
      if (!date) throw new UserFacingError('Add a start date first: the forecast needs real dates.', 'BAD_INPUT');
      const fake = { summary: 'thunderstorms', weatherCode: 95, rainChancePct: 85, windKph: 55, tempMaxC: 17, tempMinC: 12 };
      return start({ trigger: 'demo', simulatedForecast: { [date]: fake }, diff: `SIMULATED forecast for day ${day} (${date}): ${line(date, fake)}. This is not a real forecast.` });
    }
    const snap = {};
    for (const [, date] of dates) snap[date] = await sources.forecast({ destination: s.plan.destination, date });
    const last = await storage.get('lastForecast');
    await storage.put('lastForecast', Object.fromEntries(Object.entries(snap).map(([d, f]) => [d, { available: f.available, rainChancePct: f.rainChancePct, windKph: f.windKph, weatherCode: f.weatherCode, summary: f.summary }])));
    const changed = Object.entries(snap).filter(([d, f]) => (last ? bucket(f) !== bucket(last[d]) : notable(f)));
    if (changed.length === 0) {
      const have = Object.values(snap).filter((f) => f.available).length;
      const r = { id: uid(), tripId: s.id, trigger: 'wake', text: '', diff: '', status: 'done', createdAt: now(), startedAt: now(), finishedAt: now(), heartbeatAt: now(), final: { kind: 'no_change', note: `Checked the forecast for ${have} of ${dates.length} trip day(s). Nothing changed that matters.` }, events: [] };
      r.events.push({ seq: 1, at: now(), kind: 'wake', title: 'Woke up for its scheduled check', detail: 'Looked at the real forecast for every trip day.' });
      r.events.push({ seq: 2, at: now(), kind: 'result', title: 'Nothing to change', detail: r.final.note });
      await putRun(r);
      await trip.mutate('noteRun', [summaryOf(r)]);
      return r;
    }
    const diff = `Forecast ${last ? 'changed' : 'now'}: ${changed.map(([d, f]) => (f.available ? line(d, f) : `${d}: no forecast`)).join('; ')}.`;
    return start({ trigger: 'wake', diff });
  }

  async function ensureWake() {
    const s = await trip.state();
    if (!s?.mandate?.terms?.enabled || s.closedAt || now() >= s.mandate.terms.validUntil) return;
    const list = (await storage.get('schedule')) ?? [];
    if (list.some((i) => i.kind === 'wake')) return;
    await schedule({ id: uid(), at: now() + wakeEveryMs, kind: 'wake' });
  }

  // The Durable Object alarm: do whatever is due, then set the alarm for what comes next. Never throws: the platform
  // would retry a failed alarm, and a retry must not run the agent twice.
  async function processDue() {
    const list = (await storage.get('schedule')) ?? [];
    const due = list.filter((i) => i.at <= now());
    await storage.put('schedule', list.filter((i) => i.at > now()));
    for (const item of due) {
      try {
        if (item.kind === 'run') await execute(item.runId);
        if (item.kind === 'wake') { await wake({}); await ensureWake(); }
      } catch (e) { console.error('scheduled item failed', item.kind, e); }
    }
    const rest = (await storage.get('schedule')) ?? [];
    if (rest.length) await storage.setAlarm(Math.min(...rest.map((i) => i.at)));
  }

  return { start, execute, wake, ensureWake, processDue, getRun, activeRun, schedule };
}
