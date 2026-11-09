import { itemState, reserves } from './ledger.js';

// Deterministic money delta between the current plan and a staged plan.
// One PayPal authorization is a trip hold; each item has money set aside for it under a hold.
//
// Action types:
// - 'hold': open a new PayPal authorization (requires buyer approval) and set money aside for the item
// - 'allocate': set money aside for the item from an existing open hold (no new PayPal approval needed)
// - 'release': free money set aside for an item back into its hold (no PayPal call; the unused hold is voided at trip close)
// - 'capture': charge held money for an item in PayPal (at trip close)
// - 'void': release the remaining unused hold in PayPal (at trip close)
// - 'refund': refund a charged amount in PayPal
export const PAYPAL_CHARGE_TYPES = ['hold', 'capture', 'refund'];

// Does this action take money out of the buyer's account right now? A capture does, and so does setting money aside
// for something paid in advance (the item is charged the moment it is set aside). One rule, used wherever the effect
// of an action is told, judged or gated.
export const chargesNow = (a) => a.type === 'capture' || ((a.type === 'hold' || a.type === 'allocate') && Boolean(a.captureAfter));

export function diffToActions(oldPlan, newPlan, ledger) {
  const actions = [];
  const oldById = new Map(oldPlan.items.map((i) => [i.id, i]));
  const newById = new Map(newPlan.items.map((i) => [i.id, i]));

  const availByAuth = new Map(
    reserves(ledger)
      .filter((r) => r.open)
      .map((r) => [r.id, r.unusedCents])
  );

  // A refund can never exceed the charge it comes from, so a larger amount is split over the item's charges.
  const refund = (item, st, cents, why) => {
    let left = cents;
    for (const c of st.captures) {
      const take = Math.min(c.cents - c.refunded, left);
      if (take > 0) actions.push({ type: 'refund', itemId: item.id, title: item.title, cents: take, captureId: c.id, why });
      left -= take;
      if (left <= 0) break;
    }
  };

  const releaseAll = (item, st, why) => {
    for (const a of st.openAuths) {
      actions.push({ type: 'release', itemId: item.id, title: item.title, cents: a.cents, authId: a.id, why });
      availByAuth.set(a.id, (availByAuth.get(a.id) ?? 0) + a.cents);
    }
    refund(item, st, st.paidCents, why);
  };

  const assignQuota = (item, cents, captureAfter, baseWhy) => {
    for (const [authId, free] of availByAuth.entries()) {
      if (free >= cents) {
        availByAuth.set(authId, free - cents);
        actions.push({
          type: 'allocate',
          itemId: item.id,
          title: item.title,
          cents,
          authId,
          captureAfter,
          why: `${baseWhy} (covered by existing trip hold)`,
        });
        return;
      }
    }
    actions.push({
      type: 'hold',
      itemId: item.id,
      title: item.title,
      cents,
      captureAfter,
      why: `${baseWhy} (requires new PayPal authorization)`,
    });
  };

  for (const old of oldPlan.items) {
    const st = itemState(ledger, old.id);
    const now = newById.get(old.id);
    if (!now) {
      releaseAll(old, st, 'removed from the plan');
    } else if (now.amountCents === 0 && st.status !== 'planned') {
      releaseAll(now, st, 'now free');
    } else if (now.amountCents !== old.amountCents) {
      if (st.heldCents > 0) {
        if (now.amountCents < st.heldCents) {
          let toRelease = st.heldCents - now.amountCents;
          for (const a of st.openAuths) {
            if (toRelease <= 0) break;
            const cut = Math.min(a.cents, toRelease);
            actions.push({ type: 'release', itemId: old.id, title: now.title, cents: cut, authId: a.id, why: 'price dropped' });
            availByAuth.set(a.id, (availByAuth.get(a.id) ?? 0) + cut);
            toRelease -= cut;
          }
        } else if (now.amountCents > st.heldCents) {
          assignQuota(now, now.amountCents - st.heldCents, now.prepaid, 'price rose');
        }
      } else if (st.paidCents > 0) {
        if (now.amountCents < st.paidCents) refund(now, st, st.paidCents - now.amountCents, 'price dropped: refund the difference');
        else if (now.amountCents > st.paidCents) assignQuota(now, now.amountCents - st.paidCents, true, 'price rose: charge the difference');
      } else if (now.amountCents > 0 && ledger.length > 0) {
        // nothing held or paid yet (it was free, or its money was freed): it gets money set aside like a new item
        assignQuota(now, now.amountCents, now.prepaid, 'now has a price');
      }
    }
  }
  for (const now of newPlan.items) {
    if (!oldById.has(now.id) && now.amountCents > 0) assignQuota(now, now.amountCents, now.prepaid, 'added to the plan');
  }
  return actions;
}

// The buffer is the part of the first hold that no item owns yet: money the person lets the agent use for changes
// without asking PayPal again. It is released at the end if unused.
export const BUFFER_ID = '_buffer';

// First checkout: open a trip hold covering every priced item (and the buffer) and set each item's money aside.
export function checkoutActions(plan, ledger, bufferCents = 0) {
  const actions = plan.items
    .filter((i) => i.amountCents > 0 && itemState(ledger, i.id).status === 'planned')
    .map((i) => ({ type: 'hold', itemId: i.id, title: i.title, cents: i.amountCents, captureAfter: i.prepaid, why: 'initial trip hold and money set aside for the item' }));
  if (actions.length > 0 && bufferCents > 0) actions.push({ type: 'hold', itemId: BUFFER_ID, title: 'Buffer for changes', cents: bufferCents, captureAfter: false, why: 'money the agent may use for changes without asking PayPal again' });
  return actions;
}

// Close trip: charge every remaining held item in the plan, then void any unused hold in PayPal.
export function closeActions(plan, ledger) {
  const actions = [];
  for (const item of plan.items) {
    const st = itemState(ledger, item.id);
    for (const oa of st.openAuths) {
      if (oa.cents > 0) {
        actions.push({
          type: 'capture',
          itemId: item.id,
          title: item.title,
          cents: oa.cents,
          authId: oa.id,
          why: 'settle held item on trip close',
        });
      }
    }
  }
  for (const r of reserves(ledger)) {
    if (!r.open) continue;
    const capturingNow = actions.filter((a) => a.type === 'capture' && a.authId === r.id).reduce((s, a) => s + a.cents, 0);
    const leftover = r.authorizedCents - r.capturedCents - capturingNow;
    if (leftover > 0) {
      actions.push({
        type: 'void',
        itemId: '_reserve',
        title: `Unused trip hold (${r.id})`,
        cents: leftover,
        authId: r.id,
        why: 'release the remaining unused trip hold in PayPal',
      });
    } else if (leftover === 0 && capturingNow > 0) {
      const lastCap = [...actions].reverse().find((a) => a.type === 'capture' && a.authId === r.id);
      if (lastCap) lastCap.finalCapture = true;
    }
  }
  return actions;
}

// Net effect on committed trip budget: positive = more committed/charged, negative = money set aside freed or returned.
export function netCents(actions) {
  return actions.reduce((a, x) => a + (['hold', 'allocate', 'capture'].includes(x.type) ? x.cents : -x.cents), 0);
}
