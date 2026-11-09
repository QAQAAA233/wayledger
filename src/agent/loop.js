import { callModel, neuronsOf } from './model.js';
import { parseArgs } from './schema.js';
import { runTool, toolDefs } from './tools.js';

// The agent loop: the model asks for a tool, code runs it, the model sees the result and decides the next step, until
// it submits, asks, or says nothing needs to change. The host guards here are not optional: a model can send badly
// formed arguments, answer in plain text instead of finishing, or stall, and none of that may change anything.
export class BudgetExhausted extends Error {
  constructor(message = "Today's AI budget for this demo is used up. It resets at 00:00 UTC.") { super(message); this.code = 'BUDGET'; }
}

const DEFAULTS = { maxTurns: 12, maxNudges: 2, totalMs: 170_000, callMs: 90_000, maxTokens: 4000 };
const NUDGE = 'Finish now: call submit_edit with an option you simulated, or ask_traveler, or no_change. Do not answer in plain text.';

export async function runAgentLoop({ system, userMessage, tools, ctx, run, models, spend, emit, now = () => Date.now(), limits = {} }) {
  const L = { ...DEFAULTS, ...limits };
  const messages = [{ role: 'system', content: system }, { role: 'user', content: userMessage }];
  const defs = toolDefs(tools);
  const started = now();
  let nudges = 0;
  let modelCalls = 0;
  let neurons = 0;
  let modelIdx = 0;
  let final = null;
  const stats = () => ({ modelCalls, nudges, neurons: Math.round(neurons * 10) / 10, ms: now() - started, model: models[modelIdx] });

  for (let turn = 1; turn <= L.maxTurns && !final; turn++) {
    if (now() - started > L.totalMs) { final = { kind: 'stopped', why: 'It was taking too long, so it stopped without changing anything.' }; break; }
    try { await spend.check(); } catch (e) { final = { kind: 'stopped', why: e.message, budget: true }; break; }

    let res = null;
    while (!res) {
      try {
        res = await callModel({ run, model: models[modelIdx], messages, tools: defs, maxTokens: L.maxTokens, timeoutMs: L.callMs });
      } catch (e) {
        await emit({ kind: 'model_error', title: 'The AI model did not answer', detail: e.message, model: models[modelIdx] });
        if (modelIdx + 1 < models.length) { modelIdx++; await emit({ kind: 'note', title: 'Switched to the backup model', detail: `Using ${models[modelIdx]}.` }); continue; }
        final = { kind: 'stopped', why: 'The AI model is not answering right now. Nothing was changed.' };
        break;
      }
    }
    if (final) break;
    modelCalls++;
    const used = neuronsOf(res.model, res.usage);
    neurons += used;
    try { await spend.add(used); } catch { /* the budget check on the next turn reports it */ }
    await emit({ kind: 'model', turn, model: res.model, ms: res.ms, neurons: Math.round(used * 10) / 10, asked: res.calls.map((c) => c.name) });

    if (res.calls.length === 0) {
      if (nudges < L.maxNudges) {
        nudges++;
        if (res.text) messages.push({ role: 'assistant', content: res.text });
        messages.push({ role: 'user', content: NUDGE });
        await emit({ kind: 'guard', title: 'Reminded the agent to finish', detail: 'It answered in plain text without choosing.' });
        continue;
      }
      final = { kind: 'stopped', why: 'The agent did not reach a decision, so nothing was changed.' };
      break;
    }

    // What goes back into the conversation is cleaned: arguments that were not JSON are replaced by {} (the API would
    // refuse the whole request otherwise), and the model is told what was wrong in the tool's answer.
    const ids = res.calls.map((c, i) => c.id ?? `call_${turn}_${i}`);
    const parsed = res.calls.map((c) => parseArgs(c.raw));
    messages.push({
      role: 'assistant',
      content: res.text || '',
      tool_calls: res.calls.map((c, i) => ({ id: ids[i], type: 'function', function: { name: c.name, arguments: parsed[i].ok ? JSON.stringify(parsed[i].value) : '{}' } })),
    });
    for (let i = 0; i < res.calls.length; i++) {
      const t0 = now();
      let out;
      try {
        out = await runTool(tools, res.calls[i], parsed[i], ctx);
      } catch (e) {
        out = { result: { error: `The tool failed: ${String(e.message).slice(0, 160)}` }, event: { title: `${res.calls[i].name} failed`, detail: String(e.message).slice(0, 160), rejected: true } };
      }
      if (out.decision) await emit({ kind: 'decision', ...out.decision });
      if (out.event) await emit({ kind: 'tool', tool: res.calls[i].name, ms: now() - t0, ...out.event });
      messages.push({ role: 'tool', tool_call_id: ids[i], content: JSON.stringify(out.result).slice(0, 6000) });
      if (out.final) { final = out.final; break; }
    }
  }
  if (!final) final = { kind: 'stopped', why: 'The agent ran out of steps without a decision, so nothing was changed.' };
  return { final, ...stats() };
}
