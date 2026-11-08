// The plan is the single source of truth for what the group intends to buy.
// The model proposes; this module is where the hard rules live.
export const CATEGORIES = ['lodging', 'transport', 'activity', 'food'];
// Lodging is prepaid (captured at booking); everything else stays an authorization hold
// until the trip needs it, so a change can usually be a void instead of a refund.
export const CAPTURE_AT_BOOKING = new Set(['lodging']);
export const LIMITS = { maxItems: 8, maxItemCents: 200000, maxTravelers: 8, maxDays: 14, currency: 'USD' };

export class PlanError extends Error {}

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function normItem(raw, travelers, id) {
  const category = String(raw.category ?? '').toLowerCase();
  if (!CATEGORIES.includes(category)) throw new PlanError(`"${clean(raw.title, 40)}" has an unknown category "${raw.category}".`);
  const dollars = Number(raw.amount);
  if (!Number.isFinite(dollars) || dollars <= 0) throw new PlanError(`"${clean(raw.title, 40)}" needs a positive amount.`);
  const amountCents = Math.round(dollars * 100);
  if (amountCents > LIMITS.maxItemCents) throw new PlanError(`"${clean(raw.title, 40)}" is above the $${LIMITS.maxItemCents / 100} per-item limit.`);
  const day = Number(raw.day);
  if (!Number.isInteger(day) || day < 1 || day > LIMITS.maxDays) throw new PlanError(`"${clean(raw.title, 40)}" has an invalid day.`);
  const title = clean(raw.title, 80);
  if (!title) throw new PlanError('Every item needs a title.');
  let participants = Array.isArray(raw.participants) ? raw.participants.map((p) => clean(p, 40)).filter((p) => travelers.includes(p)) : [];
  if (participants.length === 0) participants = [...travelers];
  return { id, day, title, category, amountCents, participants };
}

export function normalizePlan(raw, prev = null) {
  if (!raw || typeof raw !== 'object') throw new PlanError('The plan was not a valid object.');
  const travelers = [...new Set((raw.travelers ?? prev?.travelers ?? []).map((t) => clean(t, 40)).filter(Boolean))];
  if (travelers.length < 1 || travelers.length > LIMITS.maxTravelers) throw new PlanError(`A trip needs 1-${LIMITS.maxTravelers} travelers.`);
  let counter = prev?.nextId ?? 1;
  const items = (raw.items ?? []).map((it) => normItem(it, travelers, it.id && prev?.items.some((p) => p.id === it.id) ? it.id : `i${counter++}`));
  if (items.length === 0) throw new PlanError('The plan has no paid items.');
  if (items.length > LIMITS.maxItems) throw new PlanError(`A plan can hold at most ${LIMITS.maxItems} paid items (got ${items.length}).`);
  const budgetCents = raw.budget == null ? (prev?.budgetCents ?? null) : Math.round(Number(raw.budget) * 100);
  if (budgetCents != null && (!Number.isFinite(budgetCents) || budgetCents <= 0)) throw new PlanError('The budget must be a positive number.');
  const total = items.reduce((a, b) => a + b.amountCents, 0);
  if (budgetCents != null && total > budgetCents) {
    throw new PlanError(`The plan totals $${(total / 100).toFixed(2)} which is over the $${(budgetCents / 100).toFixed(2)} budget.`);
  }
  return {
    title: clean(raw.title ?? prev?.title, 80) || 'Untitled trip',
    destination: clean(raw.destination ?? prev?.destination, 80),
    currency: LIMITS.currency,
    budgetCents,
    travelers,
    items: items.sort((a, b) => a.day - b.day),
    nextId: counter,
  };
}

// A change is a list of small operations so that the code, not the model, builds the new plan.
export function applyChange(plan, change) {
  if (!change || !Array.isArray(change.operations) || change.operations.length === 0) {
    throw new PlanError('The change did not contain any operations.');
  }
  const items = plan.items.map((i) => ({ ...i, amount: i.amountCents / 100 }));
  for (const op of change.operations) {
    if (op.op === 'remove') {
      const idx = items.findIndex((i) => i.id === op.itemId);
      if (idx < 0) throw new PlanError(`Cannot remove unknown item ${op.itemId}.`);
      items.splice(idx, 1);
    } else if (op.op === 'reprice') {
      const it = items.find((i) => i.id === op.itemId);
      if (!it) throw new PlanError(`Cannot reprice unknown item ${op.itemId}.`);
      it.amount = Number(op.amount);
    } else if (op.op === 'add') {
      items.push({ ...op.item });
    } else {
      throw new PlanError(`Unknown operation "${op.op}".`);
    }
  }
  return normalizePlan({ ...plan, budget: plan.budgetCents == null ? null : plan.budgetCents / 100, items }, plan);
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
