import { sha256Hex } from './hash.js';
import { chargesNow } from './delta.js';

// The mandate: limits the person signs once, with their first PayPal approval, inside which the agent may change the
// plan and move money on its own. Everything here is decided by code from numbers; the model can read the limits and
// can ask for a change, but nothing the model writes ever decides whether a change is inside them.
//
//   refundCapCents       the most the agent may cancel or refund in total (bookings it takes out of the plan, and money it gives back)
//   planIncreaseCapCents the most the agent may raise the plan's total above where it stood when the limits were signed
//   validUntil           epoch ms; after that every change waits for the person
export const MANDATE_ACTIONS = ['release', 'allocate', 'refund'];

// The weather the traveler signs as a reason for the agent to act on a wake-up: a forecast at or above either number backs a
// change. Without a forecast that crosses one, the agent has no basis of its own and can only report.
export const DEFAULT_WEATHER = { rainPct: 70, windKph: 50 };

const dollars = (c) => `$${(c / 100).toFixed(2)}`;

// The room the agent has for raising the plan is held as a buffer, so it can never be more than the budget leaves above the plan.
export const raiseRoomCents = (planTotalCents, budgetCents) => (budgetCents == null ? Infinity : Math.max(0, Math.floor((budgetCents - planTotalCents) / 100) * 100));

export function defaultTerms({ planTotalCents, validUntil, budgetCents = null }) {
  const whole = (c) => Math.round(c / 100) * 100;
  return {
    enabled: true,
    refundCapCents: whole(planTotalCents * 0.25),
    planIncreaseCapCents: Math.min(whole(planTotalCents * 0.25), raiseRoomCents(planTotalCents, budgetCents)),
    weather: { ...DEFAULT_WEATHER },
    validUntil,
  };
}

function normalizeWeather(w) {
  const whole = (v, max, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`The ${what} limit must be a whole number from 1 to ${max}.`);
    return n;
  };
  return { rainPct: whole(w.rainPct, 100, 'chance-of-rain (%)'), windKph: whole(w.windKph, 200, 'wind (km/h)') };
}

export function normalizeTerms(raw, { maxValidUntil } = {}) {
  const num = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0) throw new Error('Limits must be amounts of $0 or more.');
    return n;
  };
  if (raw.enabled === false) return { enabled: false, refundCapCents: 0, planIncreaseCapCents: 0, weather: null, validUntil: 0 };
  const validUntil = Math.round(Number(raw.validUntil));
  if (!Number.isFinite(validUntil) || validUntil <= 0) throw new Error('Choose how long the limits last.');
  return {
    enabled: true,
    refundCapCents: Math.min(num(raw.refundCapCents), 500000),
    planIncreaseCapCents: Math.min(num(raw.planIncreaseCapCents), 500000),
    weather: raw.weather === undefined ? { ...DEFAULT_WEATHER } : normalizeWeather(raw.weather),
    validUntil: maxValidUntil ? Math.min(validUntil, maxValidUntil) : validUntil,
  };
}

export const mandateDigest = (m) => sha256Hex(JSON.stringify({ trip: m.tripId, terms: m.terms, baseline: m.baselineTotalCents, proposal: m.proposalId }));

export async function createMandate({ tripId, terms, baselineTotalCents, proposalId, now }) {
  const m = { id: `m${now.toString(36)}`, tripId, terms, baselineTotalCents, proposalId, createdAt: now, used: { refundCents: 0, cancelledCents: 0 }, uses: [] };
  m.digest = await mandateDigest(m);
  return m;
}

export async function mandateIntact(m) {
  return Boolean(m?.digest) && (await mandateDigest(m)) === m.digest;
}

// Is this change inside the signed limits? `facts` come from the engine, never from the model:
//   actions, humanOnly (the change touches the budget), planAfterTotalCents, now, operatorLossCents (what the terms say the
//   operator would keep)
export function evaluateMandate(mandate, { actions, humanOnly = false, planAfterTotalCents, now, operatorLossCents = 0, splitChanged = false, cancelledCents = 0 }) {
  const reasons = [];
  const refundCents = actions.filter((a) => a.type === 'refund').reduce((s, a) => s + a.cents, 0);
  const planIncreaseCents = mandate ? planAfterTotalCents - mandate.baselineTotalCents : 0;
  const remaining = mandate ? {
    refundCents: Math.max(0, mandate.terms.refundCapCents - mandate.used.refundCents),
    planIncreaseCents: mandate.terms.planIncreaseCapCents - Math.max(0, planIncreaseCents),
  } : null;
  if (!mandate || !mandate.terms?.enabled) {
    reasons.push({ code: 'NO_MANDATE', text: 'You have not given the agent limits to work within.' });
  } else {
    if (now >= mandate.terms.validUntil) reasons.push({ code: 'MANDATE_EXPIRED', text: 'Your limits ran out, so every change waits for you.' });
    if (mandate.used.refundCents + refundCents > mandate.terms.refundCapCents) {
      reasons.push({ code: 'REFUND_OVER_LIMIT', text: `This refunds ${dollars(refundCents)}, but only ${dollars(remaining.refundCents)} of your ${dollars(mandate.terms.refundCapCents)} refund limit is left.` });
    }
    // Bookings taken out of the plan count against the same limit, held or paid: the agent cannot take a trip apart on its own.
    const cancelLeft = Math.max(0, mandate.terms.refundCapCents - (mandate.used.cancelledCents ?? 0));
    if (cancelledCents > cancelLeft && !reasons.some((r) => r.code === 'REFUND_OVER_LIMIT')) {
      reasons.push({ code: 'CANCEL_OVER_LIMIT', text: `This takes ${dollars(cancelledCents)} of bookings out of the plan, but only ${dollars(cancelLeft)} of your ${dollars(mandate.terms.refundCapCents)} limit for cancelling and refunding is left.` });
    }
    if (planIncreaseCents > mandate.terms.planIncreaseCapCents) {
      reasons.push({ code: 'PLAN_INCREASE_OVER_LIMIT', text: `This raises the plan by ${dollars(planIncreaseCents)}, over your ${dollars(mandate.terms.planIncreaseCapCents)} limit.` });
    }
  }
  if (actions.some((a) => a.type === 'hold')) reasons.push({ code: 'NEEDS_PAYPAL_APPROVAL', text: 'This needs a new PayPal hold, and only you can approve that in PayPal.' });
  if (actions.some((a) => !MANDATE_ACTIONS.includes(a.type) && a.type !== 'hold')) reasons.push({ code: 'SETTLEMENT_IS_YOURS', text: 'Charging or releasing the trip hold at the end is always your decision.' });
  // a charge that no other reason already covers: a capture is settlement, a hold is a new PayPal approval; what is left
  // is setting money aside for something paid in advance, which charges it on the spot
  const charging = actions.filter((a) => chargesNow(a) && a.type === 'allocate');
  if (charging.length) reasons.push({ code: 'CHARGE_IS_YOURS', text: `This would charge ${dollars(charging.reduce((s, a) => s + a.cents, 0))} of your money now, and only you can say yes to a charge.` });
  if (splitChanged) reasons.push({ code: 'SPLIT_IS_YOURS', text: 'This changes who is on the trip or who shares an item, so it needs your OK.' });
  if (humanOnly) reasons.push({ code: 'BUDGET_IS_YOURS', text: 'Only you can change your budget.' });
  if (operatorLossCents > 0) reasons.push({ code: 'LOSS_TO_OPERATOR', text: `By your terms this would cost you ${dollars(operatorLossCents)} that the operator keeps, so it needs your OK.` });
  return { within: reasons.length === 0, reasons, refundCents, cancelledCents, planIncreaseCents, remaining };
}

export function describeTerms(terms) {
  if (!terms?.enabled) return 'The agent may not act on its own. Every change waits for your OK.';
  const weather = terms.weather ? ` On its own check it acts on the weather only when the forecast reaches ${terms.weather.rainPct}% chance of rain or wind of ${terms.weather.windKph} km/h.` : '';
  return `The agent may cancel or refund up to ${dollars(terms.refundCapCents)} in total and raise the plan by up to ${dollars(terms.planIncreaseCapCents)}, until ${new Date(terms.validUntil).toISOString().slice(0, 10)}.${weather} Anything beyond that waits for you.`;
}
