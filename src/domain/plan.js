// The plan is the single source of truth for what the group intends to buy.
// The model proposes; this module is where the hard rules live.
export const CATEGORIES = ['lodging', 'transport', 'activity', 'food'];
export const LIMITS = { maxItems: 12, maxItemCents: 200000, maxTravelers: 8, maxDays: 14, currency: 'USD' };

export class PlanError extends Error {}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const dayDate = (startDate, day) => (isIsoDate(startDate) ? addDays(startDate, day - 1) : null);
export const lastDay = (plan) => Math.max(1, ...plan.items.map((i) => i.day));
export const tripEndDate = (plan) => (isIsoDate(plan.startDate) ? addDays(plan.startDate, lastDay(plan) - 1) : null);

// Lodging is prepaid by default; any item can be marked prepaid or not. Prepaid items are charged when booked,
// everything else stays a hold until the trip closes, so a change can usually release a hold instead of refunding.
function normItem(raw, travelers, id) {
  const title = clean(raw.title, 80);
  if (!title) throw new PlanError('Every item needs a title.');
  const category = String(raw.category ?? '').toLowerCase();
  if (!CATEGORIES.includes(category)) throw new PlanError(`"${clean(raw.title, 40)}" has an unknown category "${raw.category}".`);
  const dollars = Number(raw.amount);
  if (!Number.isFinite(dollars) || dollars < 0) throw new PlanError(`"${clean(raw.title, 40)}" needs an amount of $0 or more.`);
  if (dollars > 0 && dollars < 0.01) throw new PlanError(`"${clean(raw.title, 40)}" has an amount below one cent.`);
  const amountCents = Math.round(dollars * 100);
  if (amountCents > LIMITS.maxItemCents) throw new PlanError(`"${clean(raw.title, 40)}" is above the $${LIMITS.maxItemCents / 100} per-item limit.`);
  const day = Number(raw.day);
  if (!Number.isInteger(day) || day < 1 || day > LIMITS.maxDays) throw new PlanError(`"${clean(raw.title, 40)}" has an invalid day.`);
  let participants = Array.isArray(raw.participants) ? raw.participants.map((p) => clean(p, 40)).filter((p) => travelers.includes(p)) : [];
  if (participants.length === 0) participants = [...travelers];
  const prepaid = amountCents > 0 && (raw.prepaid === undefined || raw.prepaid === null ? category === 'lodging' : Boolean(raw.prepaid));
  const item = { id, day, title, category, amountCents, participants, prepaid };
  if (raw.placeId) item.placeId = clean(raw.placeId, 60);
  if (raw.amountBasis) item.amountBasis = clean(raw.amountBasis, 40);
  return item;
}

// `ctx.budgetSource` is set by the host only ('user' for a number the person typed or confirmed, 'text' for a number
// the person's own words contain), never by the model. `ctx.startDate` is the trip's first day.
export function normalizePlan(raw, prev = null, ctx = {}) {
  if (!raw || typeof raw !== 'object') throw new PlanError('The plan was not a valid object.');
  const travelers = [...new Set((raw.travelers ?? prev?.travelers ?? []).map((t) => clean(t, 40)).filter(Boolean))];
  if (travelers.length < 1 || travelers.length > LIMITS.maxTravelers) throw new PlanError(`A trip needs 1-${LIMITS.maxTravelers} travelers.`);
  let counter = prev?.nextId ?? 1;
  const items = (raw.items ?? []).map((it) => normItem(it, travelers, it.id && prev?.items.some((p) => p.id === it.id) ? it.id : `i${counter++}`));
  if (items.length === 0) throw new PlanError('The plan has no items.');
  if (items.length > LIMITS.maxItems) throw new PlanError(`A plan can hold at most ${LIMITS.maxItems} items (got ${items.length}).`);
  const budgetCents = raw.budget == null ? (prev?.budgetCents ?? null) : Math.round(Number(raw.budget) * 100);
  if (budgetCents != null && (!Number.isFinite(budgetCents) || budgetCents <= 0)) throw new PlanError('The budget must be a positive number.');
  const total = items.reduce((a, b) => a + b.amountCents, 0);
  if (budgetCents != null && total > budgetCents) {
    throw new PlanError(`The plan totals $${(total / 100).toFixed(2)} which is over the $${(budgetCents / 100).toFixed(2)} budget.`);
  }
  const startDate = ctx.startDate !== undefined ? ctx.startDate : (prev?.startDate ?? null);
  if (startDate != null && !isIsoDate(startDate)) throw new PlanError('The start date must look like 2026-05-14.');
  return {
    title: clean(raw.title ?? prev?.title, 80) || 'Untitled trip',
    destination: clean(raw.destination ?? prev?.destination, 80),
    currency: LIMITS.currency,
    budgetCents,
    budgetSource: ctx.budgetSource !== undefined ? ctx.budgetSource : (prev?.budgetSource ?? null),
    startDate,
    travelers,
    items: items.sort((a, b) => a.day - b.day),
    nextId: counter,
  };
}

// Operations the agent (or a person) can apply. The code, not the model, builds the new plan from them.
//   remove {itemId} | reprice {itemId, amount} | update_item {itemId, day?, title?, category?, amount?, participants?, prepaid?}
//   add {item} | set_travelers {travelers} | set_budget {amount}
export const HUMAN_ONLY_OPS = ['set_budget'];

export function applyChange(plan, change) {
  if (!change || !Array.isArray(change.operations) || change.operations.length === 0) {
    throw new PlanError('The change did not contain any operations.');
  }
  const items = plan.items.map((i) => ({ ...i, amount: i.amountCents / 100 }));
  let travelers = plan.travelers;
  let budget = plan.budgetCents == null ? null : plan.budgetCents / 100;
  let budgetSource = plan.budgetSource ?? null;
  const find = (op) => {
    const it = items.find((i) => i.id === op.itemId);
    if (!it) throw new PlanError(`Cannot ${op.op.replace('_', ' ')} unknown item ${op.itemId}.`);
    return it;
  };
  for (const op of change.operations) {
    if (op.op === 'remove') {
      items.splice(items.indexOf(find(op)), 1);
    } else if (op.op === 'reprice') {
      find(op).amount = Number(op.amount);
    } else if (op.op === 'update_item') {
      const it = find(op);
      for (const k of ['day', 'title', 'category', 'participants', 'prepaid']) if (op[k] !== undefined) it[k] = op[k];
      if (op.amount !== undefined) it.amount = Number(op.amount);
    } else if (op.op === 'add') {
      items.push({ ...op.item });
    } else if (op.op === 'set_travelers') {
      if (!Array.isArray(op.travelers)) throw new PlanError('set_travelers needs a list of names.');
      travelers = op.travelers;
    } else if (op.op === 'set_budget') {
      budget = Number(op.amount);
      budgetSource = 'user';
    } else {
      throw new PlanError(`Unknown operation "${op.op}".`);
    }
  }
  return normalizePlan({ ...plan, budget, travelers, items }, plan, { budgetSource });
}

export const planTotalCents = (plan) => plan.items.reduce((a, b) => a + b.amountCents, 0);

export function perPersonCents(plan) {
  const out = Object.fromEntries(plan.travelers.map((t) => [t, 0]));
  for (const it of plan.items) {
    const share = Math.floor(it.amountCents / it.participants.length);
    let rest = it.amountCents - share * it.participants.length;
    for (const p of it.participants) { out[p] += share + (rest > 0 ? 1 : 0); if (rest > 0) rest--; }
  }
  return out;
}
