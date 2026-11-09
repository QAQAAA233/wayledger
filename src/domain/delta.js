import { CAPTURE_AT_BOOKING } from './plan.js';
import { itemState, reserves } from './ledger.js';

// Deterministic money delta between the current plan and a staged plan.
// One PayPal authorization is a Trip Reserve; each item holds a quota under a reserve.
//
// Action types:
// - 'hold': open a new PayPal authorization reserve (requires buyer approval) and allocate item quota
// - 'allocate': allocate item quota from an existing open Trip Reserve (no new PayPal approval needed)
// - 'release': release uncaptured item quota back to its Trip Reserve (no PayPal call; unused reserve is voided at trip close)
// - 'capture': capture held item quota from its Trip Reserve in PayPal (at trip close)
// - 'void': void remaining unused Trip Reserve in PayPal (at trip close)
// - 'refund': refund a captured charge in PayPal
export function diffToActions(oldPlan, newPlan, ledger) {
  const actions = [];
  const oldById = new Map(oldPlan.items.map((i) => [i.id, i]));
  const newById = new Map(newPlan.items.map((i) => [i.id, i]));

  const availByAuth = new Map(
    reserves(ledger)
      .filter((r) => r.open)
      .map((r) => [r.id, r.unusedCents])
  );

  const releaseQuota = (item, st, why) => {
    for (const a of st.openAuths) {
      actions.push({ type: 'release', itemId: item.id, title: item.title, cents: a.cents, authId: a.id, why });
      availByAuth.set(a.id, (availByAuth.get(a.id) ?? 0) + a.cents);
    }
    for (const c of st.captures) {
      const left = c.cents - c.refunded;
      if (left > 0) actions.push({ type: 'refund', itemId: item.id, title: item.title, cents: left, captureId: c.id, why });
    }
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
          why: `${baseWhy} (covered by existing trip reserve)`,
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
      releaseQuota(old, st, 'removed from the plan — quota freed in trip reserve (unused reserve is voided at trip close)');
    } else if (now.amountCents !== old.amountCents && st.status !== 'planned') {
      if (st.heldCents > 0) {
        if (now.amountCents < st.heldCents) {
          let toRelease = st.heldCents - now.amountCents;
          for (const a of st.openAuths) {
            if (toRelease <= 0) break;
            const cut = Math.min(a.cents, toRelease);
            actions.push({ type: 'release', itemId: old.id, title: now.title, cents: cut, authId: a.id, why: 'price dropped: quota freed in trip reserve' });
            availByAuth.set(a.id, (availByAuth.get(a.id) ?? 0) + cut);
            toRelease -= cut;
          }
        } else if (now.amountCents > st.heldCents) {
          assignQuota(now, now.amountCents - st.heldCents, CAPTURE_AT_BOOKING.has(now.category), 'price rose: additional quota');
        }
      } else if (now.amountCents < st.paidCents) {
        const cap = st.captures.find((c) => c.cents - c.refunded > 0);
        actions.push({ type: 'refund', itemId: old.id, title: now.title, cents: st.paidCents - now.amountCents, captureId: cap.id, why: 'price dropped: refund the difference' });
      } else if (now.amountCents > st.paidCents) {
        assignQuota(now, now.amountCents - st.paidCents, true, 'price rose: charge the difference');
      }
    }
  }
  for (const now of newPlan.items) {
    if (!oldById.has(now.id)) {
      assignQuota(now, now.amountCents, CAPTURE_AT_BOOKING.has(now.category), 'added to the plan');
    }
  }
  return actions;
}

// First checkout: open a Trip Reserve covering every planned item and allocate each item's quota.
export function checkoutActions(plan, ledger) {
  return plan.items
    .filter((i) => itemState(ledger, i.id).status === 'planned')
    .map((i) => ({ type: 'hold', itemId: i.id, title: i.title, cents: i.amountCents, captureAfter: CAPTURE_AT_BOOKING.has(i.category), why: 'initial trip reserve & item quota' }));
}

// Close trip: capture every remaining held item in the plan, then void any unused reserve in PayPal.
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
        title: `Unused trip reserve (${r.id})`,
        cents: leftover,
        authId: r.id,
        why: 'void remaining unused trip reserve in PayPal',
      });
    } else if (leftover === 0 && capturingNow > 0) {
      const lastCap = [...actions].reverse().find((a) => a.type === 'capture' && a.authId === r.id);
      if (lastCap) lastCap.finalCapture = true;
    }
  }
  return actions;
}

// Net effect on committed trip budget: positive = more committed/charged, negative = quota released or money returned.
export function netCents(actions) {
  return actions.reduce((a, x) => a + (['hold', 'allocate', 'capture'].includes(x.type) ? x.cents : -x.cents), 0);
}
