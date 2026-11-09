// Talking to a Workers AI model: one call in, normalized tool calls out. Nothing here decides anything.
export const MODELS = {
  // Measured before choosing: no bad tool-call formats, fast, cheap (see eval/). Thinking is off: it only added minutes.
  gemma: { id: '@cf/google/gemma-4-26b-a4b-it', extra: { chat_template_kwargs: { enable_thinking: false } } },
  oss: { id: '@cf/openai/gpt-oss-120b', extra: {} },
  glm: { id: '@cf/zai-org/glm-4.7-flash', extra: {} },
};

export class ModelError extends Error {
  constructor(message, { code = 'MODEL', timeout = false } = {}) { super(message); this.code = code; this.timeout = timeout; }
}

// Workers AI answers in the chat-completions shape for these models (older ones add a legacy `response` field).
export function parseResponse(res) {
  const c = res?.choices?.[0];
  if (c) {
    const m = c.message ?? {};
    return {
      text: m.content ?? '',
      finish: c.finish_reason ?? null,
      usage: res.usage ?? null,
      calls: (m.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function?.name, raw: t.function?.arguments })),
    };
  }
  return {
    text: typeof res?.response === 'string' ? res.response : '',
    finish: null,
    usage: res?.usage ?? null,
    calls: (res?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.name ?? t.function?.name, raw: t.arguments ?? t.function?.arguments })),
  };
}

// `run(modelId, input)` is env.AI.run in the Worker and a REST call in the evaluation harness.
export async function callModel({ run, model, messages, tools, temperature = 0.3, maxTokens = 4000, seed, timeoutMs = 90_000 }) {
  const cfg = MODELS[model];
  if (!cfg) throw new ModelError(`Unknown model ${model}`);
  const input = { messages, tools, temperature, max_tokens: maxTokens, ...(seed ? { seed } : {}), ...cfg.extra };
  const t0 = Date.now();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new ModelError('The model took too long to answer.', { code: 'TIMEOUT', timeout: true })), timeoutMs); });
  try {
    const res = await Promise.race([run(cfg.id, input), timeout]);
    return { ...parseResponse(res), ms: Date.now() - t0, model };
  } catch (e) {
    if (e instanceof ModelError) throw e;
    throw new ModelError(String(e?.message ?? e).slice(0, 200), { code: 'API' });
  } finally {
    clearTimeout(timer);
  }
}

// Neurons are what Workers AI bills. The response says how many it used; if it does not, estimate from tokens.
const RATE_PER_M = { gemma: [9091, 27273], oss: [31818, 68182], glm: [5500, 36400], llama: [26668, 204805] };
export function neuronsOf(model, usage) {
  if (usage?.neurons != null) return Number(usage.neurons);
  const [i, o] = RATE_PER_M[model] ?? [30000, 100000];
  return ((usage?.prompt_tokens ?? 0) * i + (usage?.completion_tokens ?? 0) * o) / 1e6;
}
export const NEURON_USD = 0.011 / 1000;
