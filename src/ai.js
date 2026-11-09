import { CATEGORIES, LIMITS, PlanError } from './domain/plan.js';
import { PLAN_SYSTEM_TEXT, AGENT_SYSTEM } from './agent/prompts.js';
import { neuronsOf } from './agent/model.js';
import { UserFacingError } from './engine.js';

// The first plan is one structured call: the model reads the person's request and proposes a plan. Everything that
// happens after that (changes, checks, money) is the agent loop in src/agent/.
export const PLANNER_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class AIError extends Error {}

const itemSchema = {
  type: 'object',
  properties: {
    day: { type: 'integer' },
    title: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    amount: { type: 'number' },
    participants: { type: 'array', items: { type: 'string' } },
    prepaid: { type: 'boolean' },
  },
  required: ['day', 'title', 'category', 'amount', 'participants'],
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    destination: { type: 'string' },
    budget: { type: ['number', 'null'] },
    budgetQuote: { type: ['string', 'null'] },
    travelers: { type: 'array', items: { type: 'string' } },
    items: { type: 'array', items: itemSchema },
  },
  required: ['title', 'destination', 'budget', 'budgetQuote', 'travelers', 'items'],
};

const PLAN_SYSTEM = PLAN_SYSTEM_TEXT({ maxItems: LIMITS.maxItems, categories: CATEGORIES });

async function run(env, spend, system, user, schema, validate) {
  let lastError = '';
  let planRule = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await spend?.check(); } catch (e) { throw new UserFacingError(e.message, 'RATE_LIMIT'); }
    const messages = [{ role: 'system', content: system }, { role: 'user', content: attempt === 0 ? user : `${user}\n\nYour previous reply was rejected: ${lastError}. Reply again with corrected JSON only.` }];
    let out;
    try {
      out = await env.AI.run(PLANNER_MODEL, { messages, max_tokens: 1800, temperature: 0.2, response_format: { type: 'json_schema', json_schema: schema } });
    } catch (e) {
      console.error('Workers AI call failed', e);
      throw new AIError('The planning model is busy right now. Nothing was changed - please try again in a moment.');
    }
    try { await spend?.add(neuronsOf('llama', out?.usage)); } catch { /* counted next time */ }
    try {
      const raw = out?.response ?? out;
      const parsed = typeof raw === 'string' ? JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) : raw;
      return validate(parsed);
    } catch (e) {
      lastError = String(e.message ?? e).slice(0, 200);
      planRule = e instanceof PlanError ? lastError : '';
    }
  }
  // Plan rules (budget, limits) are worth showing; parser and model internals are not.
  throw new AIError(`The model's answer could not be used${planRule ? `: ${planRule}` : ''}. Nothing was changed - you can try again.`);
}

export function createAI(env, { spend } = {}) {
  return {
    // Words that must never turn up in a trip title: the prompts themselves.
    secrets: [PLAN_SYSTEM, AGENT_SYSTEM],
    planTrip: (prompt, validate, { startDate } = {}) => run(env, spend, PLAN_SYSTEM, `${startDate ? `The trip starts on ${startDate}.\n` : ''}${prompt}`, PLAN_SCHEMA, validate),
  };
}
