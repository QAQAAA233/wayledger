import { netCents, chargesNow } from './delta.js';
import { sha256Hex } from './hash.js';
import { MANDATE_ACTIONS, mandateIntact } from './mandate.js';

export { sha256Hex };

// A proposal is the ONLY way money can move. Either a person confirms it for exactly the digest they were shown,
// or it is confirmed by the person's signed mandate, which code checks number by number. Nothing a model writes
// ever confirms anything.
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;

export class MoneyGuardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const canonical = (p) => JSON.stringify({
  trip: p.tripId, kind: p.kind, actions: p.actions, cap: p.capCents, exp: p.expiresAt, plan: p.newPlan ?? null,
  ...(p.unfunded ? { unfunded: p.unfunded } : {}),
  ...(p.mandateTerms ? { mandateTerms: p.mandateTerms } : {}),
  ...(p.humanOnly ? { humanOnly: p.humanOnly } : {}),
  ...(p.operatorLoss ? { operatorLoss: p.operatorLoss } : {}),
  ...(p.settleOnDay ? { settleOnDay: true } : {}),
});

// `summary` is written by code from the actions. `agentNote` is what the model said; it is shown apart, labelled,
// and is not part of what anyone confirms.
export async function createProposal({ id, tripId, kind, summary, actions, newPlan = null, unfunded, mandateTerms, humanOnly, operatorLoss, agentNote, source, settleOnDay, now, ttlMs = PROPOSAL_TTL_MS }) {
  // A change of the plan that moves no money is still a proposal: a person confirms it, or the signed limits do.
  if (actions.length === 0 && !newPlan && kind !== 'close') throw new MoneyGuardError('NO_ACTIONS', 'This change does not move any money.');
  const proposal = {
    id, tripId, kind, summary,
    actions,
    newPlan,
    ...(unfunded ? { unfunded } : {}),
    ...(mandateTerms ? { mandateTerms } : {}),
    ...(humanOnly ? { humanOnly } : {}),
    ...(operatorLoss ? { operatorLoss } : {}),
    ...(settleOnDay ? { settleOnDay: true } : {}),
    ...(agentNote ? { agentNote } : {}),
    ...(source ? { source } : {}),
    capCents: actions.reduce((a, x) => a + x.cents, 0),
    netCents: netCents(actions),
    createdAt: now,
    expiresAt: now + ttlMs,
    status: 'pending',
    confirmation: null,
    results: [],
  };
  proposal.digest = await sha256Hex(canonical(proposal));
  return proposal;
}

// Called by the confirm endpoint, i.e. by a person pressing the button, with the digest
// of what the screen showed. A changed or expired proposal cannot be confirmed.
export async function confirmProposal(proposal, shownDigest, now) {
  if (proposal.status !== 'pending') throw new MoneyGuardError('NOT_PENDING', `This proposal is already ${proposal.status}.`);
  if (now >= proposal.expiresAt) { proposal.status = 'expired'; throw new MoneyGuardError('EXPIRED', 'This proposal expired. Refresh it to get current amounts.'); }
  if ((await sha256Hex(canonical(proposal))) !== proposal.digest) throw new MoneyGuardError('TAMPERED', 'The proposal no longer matches its digest.');
  if (shownDigest !== proposal.digest) throw new MoneyGuardError('STALE_VIEW', 'The amounts on screen are out of date. Reload and review again.');
  proposal.status = 'confirmed';
  proposal.confirmation = { by: 'person', at: now, digest: shownDigest };
  return proposal;
}

// The signed mandate confirms a change only if code finds it inside the limits (`evaluation` comes from evaluateMandate).
export async function confirmByMandate(proposal, mandate, evaluation, now) {
  if (proposal.status !== 'pending') throw new MoneyGuardError('NOT_PENDING', `This proposal is already ${proposal.status}.`);
  if (now >= proposal.expiresAt) { proposal.status = 'expired'; throw new MoneyGuardError('EXPIRED', 'This proposal expired.'); }
  if ((await sha256Hex(canonical(proposal))) !== proposal.digest) throw new MoneyGuardError('TAMPERED', 'The proposal no longer matches its digest.');
  if (!evaluation?.within) throw new MoneyGuardError('OUTSIDE_MANDATE', 'This change is outside the limits you signed.');
  if (!(await mandateIntact(mandate))) throw new MoneyGuardError('MANDATE_TAMPERED', 'The signed limits no longer match their digest.');
  proposal.status = 'confirmed';
  proposal.confirmation = { by: 'mandate', at: now, digest: proposal.digest, mandateDigest: mandate.digest, refundCents: evaluation.refundCents };
  return proposal;
}

// The calendar confirms a charge only because the person approved it with the hold ("each item is charged on its day"):
// `settlement` is what the first approval stored. Code finds it still true; nothing a model writes is involved.
export async function confirmBySchedule(proposal, settlement, now) {
  if (proposal.status !== 'pending') throw new MoneyGuardError('NOT_PENDING', `This proposal is already ${proposal.status}.`);
  if (!settlement?.onDay) throw new MoneyGuardError('OUTSIDE_SCHEDULE', 'No approval says that items are charged on their day.');
  if ((await sha256Hex(canonical(proposal))) !== proposal.digest) throw new MoneyGuardError('TAMPERED', 'The proposal no longer matches its digest.');
  proposal.status = 'confirmed';
  proposal.confirmation = { by: 'schedule', at: now, digest: proposal.digest };
  return proposal;
}

// Every single PayPal money call goes through this check first: placing a hold, charging, refunding and releasing.
// `ctx.mandate` and `ctx.refundedSoFarCents` are supplied by the engine for mandate-confirmed proposals;
// `ctx.allowExpired` lets a proposal that already started finish (a retry), never begin, after it expired.
export async function assertMayMove(proposal, action, movedSoFarCents, now, ctx = {}) {
  if (!['confirmed', 'executing'].includes(proposal.status) || !proposal.confirmation) {
    throw new MoneyGuardError('NOT_CONFIRMED', 'No person has confirmed this action.');
  }
  if (proposal.confirmation.digest !== proposal.digest || (await sha256Hex(canonical(proposal))) !== proposal.digest) {
    throw new MoneyGuardError('TAMPERED', 'The proposal changed after it was confirmed.');
  }
  if (now >= proposal.expiresAt && !ctx.allowExpired) throw new MoneyGuardError('EXPIRED', 'The confirmation expired before this action ran.');
  if (!proposal.actions.some((a) => a === action || JSON.stringify(a) === JSON.stringify(action))) {
    throw new MoneyGuardError('NOT_IN_PROPOSAL', 'This action is not part of the confirmed proposal.');
  }
  if (movedSoFarCents + action.cents > proposal.capCents) throw new MoneyGuardError('OVER_CAP', 'This would exceed the confirmed cap.');
  if (proposal.confirmation.by === 'schedule') {
    // a schedule only ever charges an item on its day, or releases a finished trip's hold; never a refund, never early
    const settleKinds = ['capture', 'void'];
    if (!settleKinds.includes(action.type) || !action.settle || !ctx.settlement?.onDay) throw new MoneyGuardError('OUTSIDE_SCHEDULE', 'A schedule only charges an item on its day, as the person approved with the hold.');
    if (!ctx.settleDate || ctx.settleDate < action.dueOn) throw new MoneyGuardError('NOT_DUE', 'This has not happened yet, so it is not charged.');
  }
  if (proposal.confirmation.by === 'mandate') {
    const m = ctx.mandate;
    if (!m || m.digest !== proposal.confirmation.mandateDigest || !(await mandateIntact(m))) throw new MoneyGuardError('MANDATE_TAMPERED', 'The signed limits no longer match.');
    if (now >= m.terms.validUntil) throw new MoneyGuardError('MANDATE_EXPIRED', 'The signed limits ran out.');
    if (!MANDATE_ACTIONS.includes(action.type)) throw new MoneyGuardError('OUTSIDE_MANDATE', 'The signed limits do not cover this kind of action.');
    if (chargesNow(action)) throw new MoneyGuardError('OUTSIDE_MANDATE', 'The signed limits do not cover charging money; only a person can say yes to a charge.');
    if (action.type === 'refund' && m.used.refundCents + (ctx.refundedSoFarCents ?? 0) + action.cents > m.terms.refundCapCents) {
      throw new MoneyGuardError('OUTSIDE_MANDATE', 'This would exceed the refund limit you signed.');
    }
  }
}
