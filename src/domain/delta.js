import { CAPTURE_AT_BOOKING } from './plan.js';
import { itemState } from './ledger.js';

// Deterministic money delta between the current plan and a staged plan.
// The model decides WHAT changes in the trip; this decides what that does to the money.
//
// Action: { type: 'hold' | 'void' | 'refund', itemId, cents, title, authId?, captureId?, captureAfter?, why }
export function diffToActions(oldPlan, newPlan, ledger) {
  const actions = [];
  const oldById = new Map(oldPlan.items.map((i) => [i.id, i]));
  const newById = new Map(newPlan.items.map((i) => [i.id, i]));

  const release = (item, st, why) => {
    for (const a of st.openAuths) actions.push({ type: 'void', itemId: item.id, title: item.title, cents: a.cents, authId: a.id, why });
    for (const c of st.captures) {
      const left = c.cents - c.refunded;
      if (left > 0) actions.push({ type: 'refund', itemId: item.id, title: item.title, cents: left, captureId: c.id, why });
    }
  };

  for (const old of oldPlan.items) {
    const st = itemState(ledger, old.id);
    const now = newById.get(old.id);
    if (!now) {
      release(old, st, 'removed from the plan');
    } else if (now.amountCents !== old.amountCents && st.status !== 'planned') {
      if (st.heldCents > 0) {
        release(old, st, 'price changed: release the old hold');
        actions.push({ type: 'hold', itemId: old.id, title: now.title, cents: now.amountCents, captureAfter: CAPTURE_AT_BOOKING.has(now.category), why: 'price changed: new hold' });
      } else if (now.amountCents < st.paidCents) {
        const cap = st.captures.find((c) => c.cents - c.refunded > 0);
        actions.push({ type: 'refund', itemId: old.id, title: now.title, cents: st.paidCents - now.amountCents, captureId: cap.id, why: 'price dropped: refund the difference' });
      } else if (now.amountCents > st.paidCents) {
        actions.push({ type: 'hold', itemId: old.id, title: now.title, cents: now.amountCents - st.paidCents, captureAfter: true, why: 'price rose: charge the difference' });
      }
    }
  }
  for (const now of newPlan.items) {
    if (!oldById.has(now.id)) {
      actions.push({ type: 'hold', itemId: now.id, title: now.title, cents: now.amountCents, captureAfter: CAPTURE_AT_BOOKING.has(now.category), why: 'added to the plan' });
    }
  }
  return actions;
}

// First checkout: every costed item that has no money state yet gets a hold.
export function checkoutActions(plan, ledger) {
  return plan.items
    .filter((i) => itemState(ledger, i.id).status === 'planned')
    .map((i) => ({ type: 'hold', itemId: i.id, title: i.title, cents: i.amountCents, captureAfter: CAPTURE_AT_BOOKING.has(i.category), why: 'first checkout' }));
}

// Net effect on the traveler: positive = more money held/charged, negative = money released/returned.
export function netCents(actions) {
  return actions.reduce((a, x) => a + (x.type === 'hold' ? x.cents : -x.cents), 0);
}
