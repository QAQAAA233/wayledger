import { itemState, reserves } from './ledger.js';
import { dayDate } from './plan.js';

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

// The money each priced item is still missing: its planned amount less what is held or paid for it. At the first
// checkout that is the whole price; later it is what a lost hold took with it.
export function shortfalls(plan, ledger) {
  return plan.items.filter((i) => i.amountCents > 0).flatMap((item) => {
    const st = itemState(ledger, item.id);
    const cents = item.amountCents - st.heldCents - st.paidCents;
    return cents > 0 ? [{ item, cents }] : [];
  });
}

// A trip hold covering every item that is short of money (and the buffer), with each item's money set aside.
export function checkoutActions(plan, ledger, bufferCents = 0) {
  const why = ledger.length ? 'a new hold for money PayPal no longer holds' : 'initial trip hold and money set aside for the item';
  const actions = shortfalls(plan, ledger)
    .map(({ item: i, cents }) => ({ type: 'hold', itemId: i.id, title: i.title, cents, captureAfter: i.prepaid, why }));
  if (actions.length > 0 && bufferCents > 0) actions.push({ type: 'hold', itemId: BUFFER_ID, title: 'Buffer for changes', cents: bufferCents, captureAfter: false, why: 'money the agent may use for changes without asking PayPal again' });
  return actions;
}

// Pay only for what happens. One PayPal authorization covers the whole trip; each item is charged on its day (a partial
// capture of just that item), the last charge on a hold is marked final so PayPal releases the rest by itself, and what
// never happened is never charged. (PayPal's own answers for this are in test/fixtures/sandbox_partial_captures.json.)

// The day an item happens: the date of its trip day, or null when the trip has no start date.
export const itemDueOn = (plan, item) => dayDate(plan.startDate, item.day);

// Has the item happened by `today` (an ISO date)? An item without a date, or a closing without a calendar, counts as having happened.
export const isDue = (plan, item, today) => {
  const d = itemDueOn(plan, item);
  return d == null || today == null || d <= today;
};

// Every item that has money set aside on a hold that is still open: [{ item, authId, cents }].
function heldAllocations(plan, ledger) {
  const open = new Set(reserves(ledger).filter((r) => r.open).map((r) => r.id));
  return plan.items.flatMap((item) => itemState(ledger, item.id).openAuths.filter((a) => open.has(a.id) && a.cents > 0).map((a) => ({ item, authId: a.id, cents: a.cents })));
}

// One capture per item that is due. The last one on a hold is final when nothing else stays on that hold (`closing`: everything
// else was released first, so it always is), and then it says how much PayPal releases with it.
function captureActions(plan, ledger, held, due, { settle }) {
  const byAuth = new Map();
  for (const h of due) { if (!byAuth.has(h.authId)) byAuth.set(h.authId, []); byAuth.get(h.authId).push(h); }
  const res = new Map(reserves(ledger).map((r) => [r.id, r]));
  const actions = [];
  for (const [authId, list] of byAuth) {
    const staysOnHold = held.filter((h) => h.authId === authId && !due.includes(h)).length;
    list.forEach((h, i) => {
      const a = { type: 'capture', itemId: h.item.id, title: h.item.title, cents: h.cents, authId, why: settle ? 'charged on its day' : 'settle an item that has happened' };
      if (settle) { a.settle = true; a.dueOn = itemDueOn(plan, h.item); }
      a.finalCapture = i === list.length - 1 && (settle ? staysOnHold === 0 : true);
      if (a.finalCapture) { const r = res.get(authId); a.releasesCents = Math.max(0, r.authorizedCents - r.capturedCents - list.reduce((n, x) => n + x.cents, 0)); }
      actions.push(a);
    });
  }
  return actions;
}

// What the calendar charges today: every dated item whose day has come and that still has money on hold. When nothing is left on
// a hold and every day of the trip has come, the rest of that hold is released.
export function settleActions(plan, ledger, today) {
  const held = heldAllocations(plan, ledger);
  const due = held.filter((h) => itemDueOn(plan, h.item) != null && isDue(plan, h.item, today));
  const actions = captureActions(plan, ledger, held, due, { settle: true });
  const dates = plan.items.map((i) => itemDueOn(plan, i));
  const lastDay = dates.every((x) => x != null) ? [...dates].sort().at(-1) : null;
  if (lastDay && lastDay <= today) {
    const capturing = new Set(actions.map((a) => a.authId));
    for (const r of reserves(ledger)) {
      if (!r.open || capturing.has(r.id) || held.some((h) => h.authId === r.id)) continue;
      const leftover = r.authorizedCents - r.capturedCents;
      if (leftover > 0) actions.push({ type: 'void', itemId: '_reserve', title: `Unused trip hold (${r.id})`, cents: leftover, authId: r.id, settle: true, dueOn: lastDay, why: 'the trip is over: release what was never charged' });
    }
  }
  return actions;
}

// Close trip: what has happened is charged, what has not is released, and the rest of the hold goes back to the buyer.
export function closeActions(plan, ledger, today = null) {
  const held = heldAllocations(plan, ledger);
  const due = held.filter((h) => isDue(plan, h.item, today));
  const actions = held.filter((h) => !due.includes(h)).map((h) => ({ type: 'release', itemId: h.item.id, title: h.item.title, cents: h.cents, authId: h.authId, why: 'not charged: it has not happened yet' }));
  const captures = captureActions(plan, ledger, held, due, { settle: false });
  actions.push(...captures);
  const capturing = new Set(captures.map((a) => a.authId));
  for (const r of reserves(ledger)) {
    if (!r.open || capturing.has(r.id)) continue;
    const leftover = r.authorizedCents - r.capturedCents;
    if (leftover > 0) actions.push({ type: 'void', itemId: '_reserve', title: `Unused trip hold (${r.id})`, cents: leftover, authId: r.id, why: 'release the remaining unused trip hold in PayPal' });
  }
  return actions;
}

// Net effect on committed trip budget: positive = more committed/charged, negative = money set aside freed or returned.
export function netCents(actions) {
  return actions.reduce((a, x) => a + (['hold', 'allocate', 'capture'].includes(x.type) ? x.cents : -x.cents), 0);
}
