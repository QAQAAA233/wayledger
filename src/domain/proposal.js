import { netCents } from './delta.js';

// A proposal is the ONLY way money can move. The agent can create one; only a human
// confirmation bound to its digest lets the executor act on it.
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;

export class MoneyGuardError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const canonical = (p) => JSON.stringify({ trip: p.tripId, kind: p.kind, actions: p.actions, cap: p.capCents, exp: p.expiresAt, plan: p.newPlan ?? null });

export async function createProposal({ id, tripId, kind, summary, actions, newPlan = null, now }) {
  if (actions.length === 0) throw new MoneyGuardError('NO_ACTIONS', 'This change does not move any money.');
  const proposal = {
    id, tripId, kind, summary,
    actions,
    newPlan,
    capCents: actions.reduce((a, x) => a + x.cents, 0),
    netCents: netCents(actions),
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_MS,
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
  if (now >= proposal.expiresAt) { proposal.status = 'expired'; throw new MoneyGuardError('EXPIRED', 'This proposal expired. Ask for the change again to get a fresh one.'); }
  if ((await sha256Hex(canonical(proposal))) !== proposal.digest) throw new MoneyGuardError('TAMPERED', 'The proposal no longer matches its digest.');
  if (shownDigest !== proposal.digest) throw new MoneyGuardError('STALE_VIEW', 'The amounts on screen are out of date. Reload and review again.');
  proposal.status = 'confirmed';
  proposal.confirmation = { at: now, digest: shownDigest };
  return proposal;
}

// Every single PayPal money call goes through this check first.
export async function assertMayMove(proposal, action, movedSoFarCents, now) {
  if (!['confirmed', 'executing'].includes(proposal.status) || !proposal.confirmation) {
    throw new MoneyGuardError('NOT_CONFIRMED', 'No person has confirmed this action.');
  }
  if (proposal.confirmation.digest !== proposal.digest || (await sha256Hex(canonical(proposal))) !== proposal.digest) {
    throw new MoneyGuardError('TAMPERED', 'The proposal changed after it was confirmed.');
  }
  if (now >= proposal.expiresAt) throw new MoneyGuardError('EXPIRED', 'The confirmation expired before this action ran.');
  if (!proposal.actions.some((a) => a === action || JSON.stringify(a) === JSON.stringify(action))) {
    throw new MoneyGuardError('NOT_IN_PROPOSAL', 'This action is not part of the confirmed proposal.');
  }
  if (movedSoFarCents + action.cents > proposal.capCents) throw new MoneyGuardError('OVER_CAP', 'This would exceed the confirmed cap.');
}
