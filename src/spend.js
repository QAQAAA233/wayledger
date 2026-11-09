import { BudgetExhausted } from './agent/loop.js';
import { DEFAULT_DAILY_NEURONS } from './quota.js';

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// The AI's daily money guard, backed by the Quota object. Code only: nothing a model says can change it.
export const spendGuard = (env, now = () => Date.now()) => {
  const q = () => env.QUOTA.get(env.QUOTA.idFromName('q'));
  const cap = Number(env.AI_DAILY_NEURONS ?? DEFAULT_DAILY_NEURONS);
  return {
    check: async () => { if ((await q().neuronsToday(utcDay(now()))) >= cap) throw new BudgetExhausted(); },
    add: (n) => q().addNeurons(utcDay(now()), n),
  };
};
