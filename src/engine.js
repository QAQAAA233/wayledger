import { normalizePlan, applyChange, planTotalCents, perPersonCents, PlanError } from './domain/plan.js';
import { diffToActions, checkoutActions, closeActions } from './domain/delta.js';
import { appendFact, itemState, reserves, ledgerTotals, reconcile } from './domain/ledger.js';
import { createProposal, confirmProposal, assertMayMove, MoneyGuardError } from './domain/proposal.js';

// One trip = one object = one truth. `store` holds a single JSON state; `paypal` and `ai`
// are injected so the same rules run in the Durable Object and in the permanent tests.
export class UserFacingError extends Error {
  constructor(message, code = 'ERROR') { super(message); this.code = code; }
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export function createEngine({ store, paypal, ai, now = () => Date.now() }) {
  const log = (s, kind, text) => { s.events.push({ at: now(), kind, text }); if (s.events.length > 60) s.events.shift(); };

  const asUserError = (e) => {
    if (e instanceof PlanError || e instanceof MoneyGuardError || e instanceof UserFacingError) return new UserFacingError(e.message, e.code ?? 'PLAN');
    return e;
  };

  async function fresh(s, kind, summary, actions, newPlan) {
    for (const p of Object.values(s.proposals)) if (p.status === 'pending') p.status = 'superseded';
    const p = await createProposal({ id: uid(), tripId: s.id, kind, summary, actions, newPlan, now: now() });
    s.proposals[p.id] = p;
    s.activeProposal = p.id;
    return p;
  }

  async function refreshCheckout(s, summary) {
    const actions = checkoutActions(s.plan, s.ledger);
    if (actions.length === 0) { s.activeProposal = null; return null; }
    return fresh(s, 'checkout', summary, actions, null);
  }

  async function execute(s, p) {
    p.status = 'executing';
    let failed = null;
    const done = (i) => p.results.find((r) => r.index === i && r.ok);
    const moved = () => p.results.filter((r) => r.ok).reduce((a, r) => a + p.actions[r.index].cents, 0);
    const step = async (i, fn) => {
      if (done(i)) return;
      const action = p.actions[i];
      try {
        await assertMayMove(p, action, moved(), now());
        const facts = await fn(action);
        for (const f of [].concat(facts)) appendFact(s.ledger, f);
        p.results.push({ index: i, ok: true });
      } catch (e) {
        p.results = p.results.filter((r) => r.index !== i);
        p.results.push({ index: i, ok: false, error: e.message, debugId: e.debugId });
        failed = e;
        log(s, 'error', `${action.type} "${action.title}" failed: ${e.message}`);
      }
    };
    const rid = (i, op) => `${p.id}:${i}:${op}`;

    // Phase 1: Quota releases, quota allocations from existing reserve, and refunds
    for (let i = 0; i < p.actions.length && !failed; i++) {
      const a = p.actions[i];
      if (a.type === 'release') {
        await step(i, (x) => ({ op: 'release', id: x.authId, itemId: x.itemId, proposalId: p.id, cents: x.cents, status: 'RELEASED', at: now() }));
      }
      if (a.type === 'allocate') {
        await step(i, (x) => ({ op: 'allocate', id: x.authId, itemId: x.itemId, proposalId: p.id, cents: x.cents, status: 'ALLOCATED', at: now() }));
      }
      if (a.type === 'refund') {
        await step(i, (x) => paypal.refund(x.captureId, x.itemId, x.cents, { requestId: rid(i, 'refund'), proposalId: p.id, note: p.summary }));
      }
    }

    // Phase 2: Captures (both explicit close-trip captures and immediate captures on prepaid items)
    for (let i = 0; i < p.actions.length && !failed; i++) {
      const a = p.actions[i];
      if (a.type === 'capture') {
        await step(i, (x) => paypal.capture(x.authId, x.itemId, x.cents, { requestId: rid(i, 'capture'), proposalId: p.id, finalCapture: x.finalCapture }));
      } else if ((a.type === 'hold' || a.type === 'allocate') && a.captureAfter && !p.captured?.includes(i)) {
        const alloc = s.ledger.find((f) => f.op === 'allocate' && f.proposalId === p.id && f.itemId === a.itemId && itemState(s.ledger, a.itemId).openAuths.some((o) => o.id === f.id));
        if (!alloc) continue;
        try {
          await assertMayMove(p, a, moved() - a.cents, now());
          appendFact(s.ledger, await paypal.capture(alloc.id, a.itemId, alloc.cents, { requestId: rid(i, 'capture'), proposalId: p.id, finalCapture: false }));
          (p.captured ??= []).push(i);
        } catch (e) {
          failed = e;
          p.results.push({ index: i, ok: false, error: e.message, debugId: e.debugId });
          log(s, 'error', `capture "${a.title}" failed: ${e.message}`);
        }
      }
    }

    // Phase 3: Voids (at trip close, after all held items on the authorization have been captured)
    for (let i = 0; i < p.actions.length && !failed; i++) {
      const a = p.actions[i];
      if (a.type === 'void') {
        await step(i, (x) => paypal.voidAuthorization(x.authId, x.itemId, { requestId: rid(i, 'void'), proposalId: p.id, cents: x.cents }));
      }
    }

    if (failed) {
      p.status = 'failed';
      p.error = failed.message;
      return;
    }
    p.status = 'executed';
    p.executedAt = now();
    if (p.newPlan) s.plan = p.newPlan;
    s.activeProposal = null;
    log(s, 'system', `Done: ${p.summary}`);
  }

  async function load() { return store.get(); }

  return {
    async createTrip(id, prompt) {
      const s = { id, createdAt: now(), plan: null, ledger: [], proposals: {}, activeProposal: null, events: [] };
      log(s, 'user', prompt);
      try {
        s.plan = await ai.planTrip(prompt, (raw) => normalizePlan(raw));
      } catch (e) {
        throw asUserError(e);
      }
      log(s, 'agent', `Planned "${s.plan.title}": ${s.plan.items.length} paid items, $${(planTotalCents(s.plan) / 100).toFixed(2)} total.`);
      await refreshCheckout(s, 'Place a PayPal trip reserve for the plan, allocate each item\'s quota, and pay the prepaid lodging.');
      await store.put(s);
      return s;
    },

    async requestChange(text) {
      const s = await load();
      if (!s?.plan) throw new UserFacingError('Trip not found.', 'NOT_FOUND');
      log(s, 'user', text);
      let result;
      try {
        result = await ai.changeTrip(s.plan, text, (raw) => ({ summary: String(raw.summary ?? '').slice(0, 400), newPlan: applyChange(s.plan, raw) }));
      } catch (e) {
        log(s, 'error', e.message);
        await store.put(s);
        throw asUserError(e);
      }
      log(s, 'agent', result.summary);
      const untouched = s.ledger.length === 0;
      if (untouched) {
        s.plan = result.newPlan;
        await refreshCheckout(s, 'Place a PayPal trip reserve for the updated plan, allocate each item\'s quota, and pay the prepaid lodging.');
      } else {
        const actions = diffToActions(s.plan, result.newPlan, s.ledger);
        if (actions.length === 0) { s.plan = result.newPlan; s.activeProposal = null; log(s, 'system', 'Plan updated. No money moves.'); }
        else await fresh(s, 'change', result.summary, actions, result.newPlan);
      }
      await store.put(s);
      return s;
    },

    async closeTrip() {
      const s = await load();
      if (!s?.plan) throw new UserFacingError('Trip not found.', 'NOT_FOUND');
      const actions = closeActions(s.plan, s.ledger);
      if (actions.length === 0) throw new UserFacingError('Nothing left to settle or void — this trip is already closed.', 'NOTHING_TO_CLOSE');
      const summary = 'Close trip: capture all held items and void any unused trip reserve in PayPal.';
      log(s, 'user', 'Close trip and settle remaining holds.');
      log(s, 'agent', summary);
      await fresh(s, 'close', summary, actions, null);
      await store.put(s);
      return s;
    },

    // The person pressed the confirm button for exactly the digest they were shown.
    async confirm(proposalId, digest) {
      const s = await load();
      const p = s.proposals[proposalId];
      if (!p) throw new UserFacingError('Proposal not found.', 'NOT_FOUND');
      try {
        await confirmProposal(p, digest, now());
      } catch (e) { await store.put(s); throw asUserError(e); }
      log(s, 'system', `Confirmed by a person: ${p.actions.length} action(s), cap $${(p.capCents / 100).toFixed(2)}.`);
      if (!p.actions.some((a) => a.type === 'hold')) await execute(s, p);
      await store.put(s);
      return s;
    },

    async createOrder(proposalId) {
      const s = await load();
      const p = s.proposals[proposalId];
      if (!p || p.status !== 'confirmed') throw new UserFacingError('Confirm the proposal before PayPal approval.', 'NOT_CONFIRMED');
      const holds = p.actions.filter((a) => a.type === 'hold');
      for (const [i, h] of holds.entries()) await assertMayMove(p, h, holds.slice(0, i).reduce((a, x) => a + x.cents, 0), now()).catch((e) => { throw asUserError(e); });
      try {
        const o = await paypal.createHoldOrder(holds, { tripId: s.id, requestId: `${p.id}:order` });
        p.orderId = o.orderId;
      } catch (e) { log(s, 'error', e.message); await store.put(s); throw e; }
      await store.put(s);
      return { orderId: p.orderId };
    },

    async approveOrder(proposalId, orderId) {
      const s = await load();
      const p = s.proposals[proposalId];
      if (!p || !['confirmed', 'executing', 'failed'].includes(p.status)) throw new UserFacingError('This proposal is not waiting for PayPal approval.', 'NOT_CONFIRMED');
      if (p.orderId !== orderId) throw new UserFacingError('That PayPal order does not belong to this proposal.', 'WRONG_ORDER');
      if (!s.ledger.some((f) => f.op === 'authorize' && f.orderId === orderId)) {
        try {
          const { authFact, itemBreakdown } = await paypal.authorizeOrder(orderId, { requestId: `${p.id}:authorize`, proposalId: p.id });
          const holds = p.actions.filter((a) => a.type === 'hold');
          const expectedTotal = holds.reduce((sum, h) => sum + h.cents, 0);
          if (itemBreakdown) {
            for (const h of holds) {
              const b = itemBreakdown.find((x) => x.itemId === h.itemId);
              if (!b || b.cents !== h.cents) {
                throw new UserFacingError(`PayPal authorized $${((b?.cents ?? 0) / 100).toFixed(2)} for ${h.itemId}, which does not match the confirmed amount. Nothing else was moved.`, 'MISMATCH');
              }
            }
          }
          if (authFact.cents !== expectedTotal) {
            throw new UserFacingError(`PayPal authorized $${(authFact.cents / 100).toFixed(2)}, which does not match the confirmed $${(expectedTotal / 100).toFixed(2)}. Nothing else was moved.`, 'MISMATCH');
          }
          appendFact(s.ledger, authFact);
          for (const h of holds) {
            appendFact(s.ledger, { op: 'allocate', id: authFact.id, itemId: h.itemId, proposalId: p.id, cents: h.cents, status: 'ALLOCATED', at: now() });
            p.results.push({ index: p.actions.indexOf(h), ok: true });
          }
        } catch (e) { log(s, 'error', e.message); await store.put(s); throw e; }
      }
      await execute(s, p);
      await store.put(s);
      return s;
    },

    async retry(proposalId) {
      const s = await load();
      const p = s.proposals[proposalId];
      if (!p || p.status !== 'failed') throw new UserFacingError('Nothing to retry.', 'NOT_FAILED');
      p.status = 'executing';
      await execute(s, p);
      await store.put(s);
      return s;
    },

    async reconcile() {
      const s = await load();
      const remote = await paypal.remoteState(s.ledger);
      return reconcile(s.ledger, remote);
    },

    view(s) {
      const items = s.plan.items.map((i) => ({ ...i, money: itemState(s.ledger, i.id) }));
      const removed = [...new Set(s.ledger.map((f) => f.itemId).filter((id) => id && id !== '_reserve'))]
        .filter((id) => !s.plan.items.some((i) => i.id === id))
        .map((id) => ({ id, title: Object.values(s.proposals).flatMap((p) => p.actions).find((a) => a.itemId === id)?.title ?? id, money: itemState(s.ledger, id) }));
      const p = s.activeProposal ? s.proposals[s.activeProposal] : null;
      const last = Object.values(s.proposals).filter((x) => ['executed', 'failed'].includes(x.status)).at(-1) ?? null;
      return {
        id: s.id,
        plan: { ...s.plan, items },
        removedItems: removed,
        reserves: reserves(s.ledger),
        canClose: closeActions(s.plan, s.ledger).length > 0,
        totals: { plannedCents: planTotalCents(s.plan), ...ledgerTotals(s.ledger) },
        perPerson: perPersonCents(s.plan),
        ledger: s.ledger,
        proposal: p,
        lastProposal: last,
        events: s.events,
      };
    },
  };
}
