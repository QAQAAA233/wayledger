import { CATEGORIES, LIMITS, PlanError } from './domain/plan.js';

// The model reads the person's words and decides what the trip should look like.
// It has no money tools at all: it can only return a plan or a list of plan edits.
export const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class AIError extends Error {}

const itemSchema = {
  type: 'object',
  properties: {
    day: { type: 'integer' },
    title: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    amount: { type: 'number' },
    participants: { type: 'array', items: { type: 'string' } },
  },
  required: ['day', 'title', 'category', 'amount', 'participants'],
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    destination: { type: 'string' },
    budget: { type: ['number', 'null'] },
    travelers: { type: 'array', items: { type: 'string' } },
    items: { type: 'array', items: itemSchema },
  },
  required: ['title', 'destination', 'budget', 'travelers', 'items'],
};

const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['remove', 'reprice', 'add'] },
          itemId: { type: 'string' },
          amount: { type: 'number' },
          item: itemSchema,
        },
        required: ['op'],
      },
    },
  },
  required: ['summary', 'operations'],
};

const PLAN_SYSTEM = `You are the planning agent of Wayledger, a group-trip planner where every paid item becomes a PayPal hold.
Turn the traveler's request into a trip plan. Reply with JSON only.
Rules:
- Currency is USD. "amount" is the total for the whole group for that item, in dollars.
- At most ${LIMITS.maxItems} paid items in total. Prefer the few that matter most: lodging, the main transport, 2-4 activities, 1-2 notable meals.
- category is one of: ${CATEGORIES.join(', ')}.
- day is the trip day number starting at 1.
- travelers: use the names the person gave; if none, use "Traveler 1", "Traveler 2" for the stated group size (default 2).
- participants: names from travelers who share that item (all of them unless the request says otherwise).
- If the person states a budget, the sum of all amounts must stay under it. Otherwise set budget to null.
- Use realistic prices for the destination. Never invent real businesses' booking confirmations.`;

const CHANGE_SYSTEM = `You are the planning agent of Wayledger. The trip below is already planned and some items may already be paid or on hold.
The traveler tells you what changed. Decide the smallest set of plan edits that handles it. Reply with JSON only.
Operations:
- {"op":"remove","itemId":"i3"}
- {"op":"reprice","itemId":"i3","amount":120}   (new total in dollars for the whole group)
- {"op":"add","item":{day,title,category,amount,participants}}
To replace something, remove it and add the replacement. Only use itemIds that exist. Keep the total under the budget if one is set.
"summary" is one or two plain sentences to the traveler saying what you changed and why. Do not mention refunds or holds: the system works those out.`;

async function run(env, system, user, schema, validate) {
  let lastError = '';
  let planRule = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = [{ role: 'system', content: system }, { role: 'user', content: attempt === 0 ? user : `${user}\n\nYour previous reply was rejected: ${lastError}. Reply again with corrected JSON only.` }];
    let out;
    try {
      out = await env.AI.run(MODEL, { messages, max_tokens: 1800, temperature: 0.2, response_format: { type: 'json_schema', json_schema: schema } });
    } catch (e) {
      console.error('Workers AI call failed', e);
      throw new AIError('The planning model is busy right now. Nothing was changed - please try again in a moment.');
    }
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

export function createAI(env) {
  return {
    planTrip: (prompt, validate) => run(env, PLAN_SYSTEM, prompt, PLAN_SCHEMA, validate),
    changeTrip: (plan, prompt, validate) => {
      const view = { title: plan.title, budget: plan.budgetCents == null ? null : plan.budgetCents / 100, travelers: plan.travelers, items: plan.items.map((i) => ({ id: i.id, day: i.day, title: i.title, category: i.category, amount: i.amountCents / 100, participants: i.participants })) };
      return run(env, CHANGE_SYSTEM, `Current plan:\n${JSON.stringify(view)}\n\nWhat changed:\n${prompt}`, CHANGE_SCHEMA, validate);
    },
  };
}
