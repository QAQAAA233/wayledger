import { chargesNow } from './delta.js';
// Words for the traveler, written by code from plan differences and money actions. A model never writes these:
// what a proposal says it does is what it does. No internal terms (quota, reserve, cap) appear in any of it.
const usd = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const money = (c) => (c === 0 ? 'free' : usd(c));
const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

export function describeEdit(oldPlan, newPlan) {
  const lines = [];
  const oldById = new Map(oldPlan.items.map((i) => [i.id, i]));
  const newIds = new Set(newPlan.items.map((i) => i.id));
  for (const o of oldPlan.items) if (!newIds.has(o.id)) lines.push(`Remove ${o.title} (${money(o.amountCents)})`);
  for (const n of newPlan.items) {
    const o = oldById.get(n.id);
    if (!o) { lines.push(`Add ${n.title} (${money(n.amountCents)}, day ${n.day})`); continue; }
    if (o.title !== n.title) lines.push(`Rename ${o.title} to ${n.title}`);
    if (o.amountCents !== n.amountCents) lines.push(`Change ${n.title} from ${money(o.amountCents)} to ${money(n.amountCents)}`);
    if (o.day !== n.day) lines.push(`Move ${n.title} to day ${n.day}`);
    if (o.category !== n.category) lines.push(`Treat ${n.title} as ${n.category}`);
    if (o.prepaid !== n.prepaid) lines.push(`${n.title} is now ${n.prepaid ? 'paid in advance' : 'paid when the trip closes'}`);
    if (JSON.stringify(o.participants) !== JSON.stringify(n.participants)) lines.push(`${n.title} is now shared by ${list(n.participants)}`);
  }
  const left = oldPlan.travelers.filter((t) => !newPlan.travelers.includes(t));
  const joined = newPlan.travelers.filter((t) => !oldPlan.travelers.includes(t));
  if (left.length) lines.push(`${list(left)} ${left.length === 1 ? 'leaves' : 'leave'} the trip`);
  if (joined.length) lines.push(`${list(joined)} ${joined.length === 1 ? 'joins' : 'join'} the trip`);
  if (oldPlan.budgetCents !== newPlan.budgetCents) lines.push(`Budget changes from ${oldPlan.budgetCents == null ? 'none' : usd(oldPlan.budgetCents)} to ${newPlan.budgetCents == null ? 'none' : usd(newPlan.budgetCents)}`);
  return lines;
}

export function describeAction(a) {
  switch (a.type) {
    case 'hold': if (a.itemId === '_buffer') return `Hold ${usd(a.cents)} more as a buffer for changes (released at the end if unused)`; return a.captureAfter ? `Charge ${usd(a.cents)} now for ${a.title} (paid in advance)` : `Hold ${usd(a.cents)} with PayPal for ${a.title} (charged when the trip closes)`;
    case 'allocate': return `Set aside ${usd(a.cents)} of your trip hold for ${a.title}`;
    case 'release': return `Free ${usd(a.cents)} of your trip hold that was set aside for ${a.title}`;
    case 'capture': return `Charge ${usd(a.cents)} for ${a.title}`;
    case 'void': return `Release the unused ${usd(a.cents)} of your trip hold`;
    case 'refund': return `Refund ${usd(a.cents)} for ${a.title} to your PayPal`;
    default: return a.title;
  }
}

// What really happens at PayPal. Setting money aside inside a hold and freeing it again never touch PayPal.
export function paypalEffect(actions) {
  const sum = (f) => actions.filter(f).reduce((s, a) => s + a.cents, 0);
  const chargeCents = sum(chargesNow);
  const holdCents = sum((a) => a.type === 'hold' && !a.captureAfter);
  const refundCents = sum((a) => a.type === 'refund');
  const voidCents = sum((a) => a.type === 'void');
  return { chargeCents, holdCents, refundCents, voidCents, mostCanMoveCents: chargeCents + holdCents + refundCents, touchesPayPal: chargeCents + holdCents + refundCents + voidCents > 0 };
}

export function describeEffect(actions) {
  if (actions.length === 0) return 'No money moves.';
  const e = paypalEffect(actions);
  if (!e.touchesPayPal) return 'This change stays inside your trip hold. PayPal does not move until you close the trip.';
  const parts = [];
  if (e.chargeCents) parts.push(`charge ${usd(e.chargeCents)}`);
  if (e.refundCents) parts.push(`refund ${usd(e.refundCents)}`);
  if (e.holdCents) parts.push(`place a new hold of ${usd(e.holdCents)}`);
  if (e.voidCents) parts.push(`release ${usd(e.voidCents)} of the unused hold`);
  const inside = actions.some((a) => a.type === 'allocate' || a.type === 'release');
  return `At PayPal this will ${list(parts)}.${inside ? ' The rest is just moved around inside your trip hold.' : ''}`;
}

export function proposalSummary(kind, oldPlan, newPlan) {
  if (kind === 'checkout') return 'Place one hold with PayPal for the whole trip and set money aside for each item. Items paid in advance are charged now.';
  if (kind === 'rehold') return 'Place a new hold with PayPal for the items whose hold was cancelled, and set money aside for each. Items paid in advance are charged now.';
  if (kind === 'close') return 'Close the trip: charge what is still held and release what is left of your trip hold.';
  const lines = oldPlan && newPlan ? describeEdit(oldPlan, newPlan) : [];
  return lines.length ? `${lines.join('. ')}.` : 'Update the plan.';
}
