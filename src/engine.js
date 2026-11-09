import { normalizePlan, applyChange, planTotalCents, perPersonCents, PlanError, HUMAN_ONLY_OPS, isIsoDate, addDays, tripEndDate, dayDate } from './domain/plan.js';
import { diffToActions, checkoutActions, closeActions, BUFFER_ID } from './domain/delta.js';
import { appendFact, itemState, reserves, ledgerTotals, reconcile } from './domain/ledger.js';
import { createProposal, confirmProposal, confirmByMandate, assertMayMove, MoneyGuardError, PROPOSAL_TTL_MS } from './domain/proposal.js';
import { createMandate, evaluateMandate, defaultTerms, normalizeTerms, describeTerms } from './domain/mandate.js';
import { describeAction, describeEffect, paypalEffect, proposalSummary } from './domain/describe.js';
import { validatePolicyFact, operatorLoss, MAX_DOC_CHARS, PolicyError } from './domain/policy.js';
import { budgetFromText, sharesLongRun } from './domain/facts.js';

// One trip = one object = one truth. `store` holds a single JSON state; `paypal` and `ai` are injected so the same
// rules run in the Durable Object and in the permanent tests. Nothing a model writes is ever an approval: a change
// moves money only if a person confirmed exactly that proposal, or code finds it inside the limits the person signed.
export class UserFacingError extends Error {
  constructor(message, code = 'ERROR') { super(message); this.code = code; }
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

// A trip saved by an earlier version of the app has no documents, rules, runs or limits yet: it opens as it was, read-only,
// with those fields empty instead of failing.
export function upgradeState(s) {
  if (!s) return s;
  s.documents ??= []; s.policies ??= []; s.webhooks ??= []; s.runs ??= []; s.mandate ??= null; s.mandateDraft ??= null; s.holdFrom ??= null; s.ownerTokenHash ??= null;
  return s;
}
const DAY_MS = 86_400_000;
// PayPal keeps a hold for 29 days. A hold is placed no earlier than this many days before the trip's last day, so it
// is still alive when the trip closes.
export const HOLD_LEAD_DAYS = 26;
export const MAX_DOCS = 5;

export function createEngine({ store, paypal, ai, now = () => Date.now(), ttlMs = PROPOSAL_TTL_MS }) {
  const log = (s, kind, text) => { s.events.push({ at: now(), kind, text: String(text).slice(0, 600) }); if (s.events.length > 80) s.events.shift(); };
  const today = () => new Date(now()).toISOString().slice(0, 10);

  const asUserError = (e) => {
    if (e instanceof PlanError || e instanceof MoneyGuardError || e instanceof UserFacingError || e instanceof PolicyError) return new UserFacingError(e.message, e.code ?? 'PLAN');
    return e;
  };

  const getProposal = (s, id) => (Object.hasOwn(s.proposals, String(id)) ? s.proposals[String(id)] : undefined);

  // A new proposal replaces every unfinished older one, confirmed or not, so an old PayPal window can never apply
  // an out-of-date plan to the money. A proposal that already ran (failed halfway) must be finished first.
  const assertNoFailed = (s) => {
    const a = s.activeProposal ? s.proposals[s.activeProposal] : null;
    if (a?.status === 'failed') throw new UserFacingError('The previous change stopped halfway. Retry it first so the money and the plan agree.', 'PREVIOUS_FAILED');
  };

  async function fresh(s, kind, summary, actions, newPlan, extra = {}) {
    assertNoFailed(s);
    for (const p of Object.values(s.proposals)) if (['pending', 'confirmed'].includes(p.status) && p.results.length === 0) p.status = 'superseded';
    const p = await createProposal({ id: uid(), tripId: s.id, kind, summary, actions, newPlan, now: now(), ttlMs, ...extra });
    s.proposals[p.id] = p;
    s.activeProposal = p.id;
    return p;
  }

  // The limits offered with the first checkout, unless the person changed them.
  const lastMoment = (s) => {
    const end = tripEndDate(s.plan);
    return end ? Date.parse(`${end}T23:59:59Z`) + DAY_MS : now() + 14 * DAY_MS;
  };
  const termsFor = (s) => s.mandateDraft ?? defaultTerms({ planTotalCents: planTotalCents(s.plan), validUntil: lastMoment(s) });

  async function refreshCheckout(s, summary = proposalSummary('checkout')) {
    const terms = termsFor(s);
    const actions = checkoutActions(s.plan, s.ledger, terms.enabled ? terms.planIncreaseCapCents : 0);
    if (actions.length === 0) { s.activeProposal = null; return null; }
    return fresh(s, 'checkout', summary, actions, null, { mandateTerms: terms });
  }

  const unfundedItems = (s) => s.plan.items
    .filter((i) => i.amountCents > 0 && itemState(s.ledger, i.id).status === 'planned')
    .map((i) => ({ itemId: i.id, title: i.title, cents: i.amountCents }));

  async function proposeClose(s) {
    const actions = closeActions(s.plan, s.ledger);
    const unfunded = unfundedItems(s);
    if (actions.length === 0) {
      s.closedAt = now();
      s.activeProposal = null;
      log(s, 'system', unfunded.length ? `Trip closed. Nothing was left to settle. Never booked: ${unfunded.map((u) => u.title).join(', ')}.` : 'Trip closed. Nothing was left to settle.');
      return null;
    }
    return fresh(s, 'close', proposalSummary('close'), actions, null, unfunded.length ? { unfunded } : {});
  }

  async function execute(s, p) {
    p.status = 'executing';
    let failed = null;
    const byMandate = p.confirmation?.by === 'mandate';
    const done = (i) => p.results.find((r) => r.index === i && r.ok);
    const moved = () => p.results.filter((r) => r.ok).reduce((a, r) => a + p.actions[r.index].cents, 0);
    const refundedSoFar = () => p.results.filter((r) => r.ok && p.actions[r.index].type === 'refund').reduce((a, r) => a + p.actions[r.index].cents, 0);
    // A proposal that already started may finish after it expired (a retry); one that never started may not begin.
    const started = () => p.results.some((r) => r.ok) || Boolean(p.captured?.length);
    const ctx = () => ({ mandate: s.mandate, refundedSoFarCents: refundedSoFar(), allowExpired: started() });
    const step = async (i, fn) => {
      if (done(i)) return;
      const action = p.actions[i];
      try {
        await assertMayMove(p, action, moved(), now(), ctx());
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
    // What PayPal tells the buyer on a refund: fixed words, never text a model wrote.
    const REFUND_NOTE = 'Wayledger: your trip plan changed';

    // Phase 1: money set aside is freed or set aside again, and refunds go out
    for (let i = 0; i < p.actions.length && !failed; i++) {
      const a = p.actions[i];
      if (a.type === 'release') {
        await step(i, (x) => ({ op: 'release', id: x.authId, itemId: x.itemId, proposalId: p.id, cents: x.cents, status: 'RELEASED', at: now() }));
      }
      if (a.type === 'allocate') {
        await step(i, (x) => ({ op: 'allocate', id: x.authId, itemId: x.itemId, proposalId: p.id, cents: x.cents, status: 'ALLOCATED', at: now() }));
      }
      if (a.type === 'refund') {
        await step(i, (x) => paypal.refund(x.captureId, x.itemId, x.cents, { requestId: rid(i, 'refund'), proposalId: p.id, note: REFUND_NOTE }));
      }
    }

    // Phase 2: charges (explicit close-trip charges and immediate charges on items paid in advance)
    for (let i = 0; i < p.actions.length && !failed; i++) {
      const a = p.actions[i];
      if (a.type === 'capture') {
        await step(i, (x) => paypal.capture(x.authId, x.itemId, x.cents, { requestId: rid(i, 'capture'), proposalId: p.id, finalCapture: x.finalCapture }));
      } else if ((a.type === 'hold' || a.type === 'allocate') && a.captureAfter && !p.captured?.includes(i)) {
        const alloc = s.ledger.find((f) => f.op === 'allocate' && f.proposalId === p.id && f.itemId === a.itemId && itemState(s.ledger, a.itemId).openAuths.some((o) => o.id === f.id));
        if (!alloc) continue;
        try {
          await assertMayMove(p, a, moved() - a.cents, now(), ctx());
          appendFact(s.ledger, await paypal.capture(alloc.id, a.itemId, alloc.cents, { requestId: rid(i, 'capture'), proposalId: p.id, finalCapture: false }));
          (p.captured ??= []).push(i);
        } catch (e) {
          failed = e;
          p.results.push({ index: i, ok: false, error: e.message, debugId: e.debugId });
          log(s, 'error', `capture "${a.title}" failed: ${e.message}`);
        }
      }
    }

    // Phase 3: voids (at trip close, after all held items on the authorization have been charged)
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
    if (p.kind === 'close') s.closedAt = now();
    if (byMandate) {
      const refunded = refundedSoFar();
      s.mandate.used.refundCents += refunded;
      s.mandate.uses.push({ proposalId: p.id, refundCents: refunded, at: now() });
    }
    if (p.kind === 'checkout' && p.mandateTerms?.enabled && !s.mandate) {
      s.mandate = await createMandate({ tripId: s.id, terms: p.mandateTerms, baselineTotalCents: planTotalCents(s.plan), proposalId: p.id, now: now() });
      log(s, 'system', `You signed limits for the agent: ${describeTerms(s.mandate.terms)}`);
    }
    s.activeProposal = null;
    log(s, 'system', `Done: ${p.summary}`);
  }

  // The gate in front of every PayPal authorization: placing a hold moves money, so it needs the same proof as a
  // charge or a refund. A confirmed proposal that ran out of time before the buyer approved is marked expired.
  async function assertHoldsMayMove(s, p) {
    const holds = p.actions.filter((a) => a.type === 'hold');
    try {
      for (const [i, h] of holds.entries()) await assertMayMove(p, h, holds.slice(0, i).reduce((a, x) => a + x.cents, 0), now(), { mandate: s.mandate });
    } catch (e) {
      if (e.code === 'EXPIRED' && p.status === 'confirmed') {
        p.status = 'expired';
        log(s, 'error', 'The confirmation expired before PayPal approval. Nothing was authorized.');
        await store.put(s);
      }
      throw asUserError(e);
    }
    return holds;
  }

  async function load() { return store.get(); }

  const mustBeOpen = (s) => {
    if (!s?.plan) throw new UserFacingError('Trip not found.', 'NOT_FOUND');
    if (s.closedAt) throw new UserFacingError('This trip is closed. Start a new trip to plan something else.', 'TRIP_CLOSED');
  };
  const activeOnly = (s, p) => {
    if (s.activeProposal !== p.id) throw new UserFacingError('A newer proposal replaced this one. Reload to see the current one.', 'NOT_ACTIVE');
  };
  const needBudget = (s) => {
    if (!s.plan.budgetSource) throw new UserFacingError('Confirm your budget first. Nothing is held until you do.', 'BUDGET_REQUIRED');
  };

  // Words from the system prompts must never show up as a trip title: a model can be talked into repeating them.
  // (found live: the real model repeated its chat header and the first words of its prompt, which are shorter than a long run)
  const LEAK_MARKERS = /cutting knowledge date|today date:|system prompt|you are the (?:planning|trip) agent|reply with json|<\|[a-z_]+\|>/i;
  const isLeak = (s) => typeof s === 'string' && (LEAK_MARKERS.test(s) || (ai?.secrets && sharesLongRun(s, ai.secrets, 16)));
  const scrub = (plan) => {
    if ([plan.destination, ...plan.travelers, ...plan.items.map((i) => i.title)].some(isLeak)) throw new PlanError('The plan repeated the planner\'s own instructions.');
    return { ...plan, title: isLeak(plan.title) ? `Trip to ${plan.destination || 'your destination'}` : plan.title };
  };

  // What a plan edit would do, worked out without changing anything. Used by the agent to compare options and by
  // submitEdit, so what the agent was shown is what the engine does.
  function simulate(s, ops) {
    let newPlan;
    try { newPlan = applyChange(s.plan, { operations: ops }); } catch (e) { return { ok: false, error: e.message }; }
    const humanOnly = ops.some((o) => HUMAN_ONLY_OPS.includes(o.op));
    const booked = s.ledger.length > 0;
    const actions = booked ? diffToActions(s.plan, newPlan, s.ledger) : [];
    const losses = [];
    const lose = (item, newAmountCents) => {
      const fact = s.policies.find((f) => f.itemId === item.id);
      const l = operatorLoss(item, fact, now());
      const dropCents = newAmountCents == null ? item.amountCents : item.amountCents - newAmountCents;
      // what the operator keeps is the part of the drop the terms do not return
      const lossCents = l.lossCents == null ? null : Math.min(dropCents, newAmountCents == null ? l.lossCents : Math.round((l.lossCents * dropCents) / item.amountCents));
      losses.push({ itemId: item.id, title: item.title, ...l, lossCents, quote: fact?.quote ?? null, appliesTo: newAmountCents == null ? 'cancelling it' : 'lowering it', unchecked: !fact && s.documents.length > 0 });
    };
    const newById = new Map(newPlan.items.map((i) => [i.id, i]));
    for (const it of s.plan.items) {
      const n = newById.get(it.id);
      if (!n) lose(it, null);
      else if (n.amountCents < it.amountCents) lose(it, n.amountCents);
    }
    const operatorLossCents = losses.reduce((n, l) => n + (l.lossCents ?? 0), 0);
    const evaluation = evaluateMandate(s.mandate, { actions, humanOnly, planAfterTotalCents: planTotalCents(newPlan), now: now(), operatorLossCents });
    const effect = paypalEffect(actions);
    const holds = reserves(s.ledger).filter((r) => r.open);
    const expiring = holds.filter((r) => r.expiresAt).map((r) => r.expiresAt).sort()[0] ?? null;
    const endsOn = tripEndDate(newPlan);
    return {
      ok: true,
      newPlan,
      actions,
      booked,
      newTotalCents: planTotalCents(newPlan),
      budgetCents: newPlan.budgetCents,
      effect,
      needsPayPalApproval: actions.some((a) => a.type === 'hold'),
      mandate: evaluation,
      losses,
      holdValidUntil: expiring,
      holdOutlastsTrip: expiring && endsOn ? Date.parse(expiring) >= Date.parse(`${endsOn}T23:59:59Z`) : null,
    };
  }

  const publicProposal = (s, p, owner) => {
    if (!p) return null;
    return {
      ...p,
      digest: owner ? p.digest : null,
      confirmation: p.confirmation ? { by: p.confirmation.by, at: p.confirmation.at } : null,
      lines: p.actions.map((a) => ({ type: a.type, text: describeAction(a), cents: a.cents })),
      effectText: describeEffect(p.actions),
      mostCanMoveCents: paypalEffect(p.actions).mostCanMoveCents,
      failed: p.status === 'failed',
    };
  };

  return {
    simulate: (s, ops) => simulate(s, ops),
    now,

    async createTrip(id, { prompt, startDate = null, ownerTokenHash = null }) {
      if (startDate != null) {
        if (!isIsoDate(startDate)) throw new UserFacingError('Pick the day the trip starts.', 'BAD_INPUT');
        if (startDate < addDays(today(), -1) || startDate > addDays(today(), 365)) throw new UserFacingError('The start date must be within the next year.', 'BAD_INPUT');
      }
      const s = { id, createdAt: now(), closedAt: null, ownerTokenHash, plan: null, ledger: [], proposals: {}, activeProposal: null, events: [], mandate: null, mandateDraft: null, documents: [], policies: [], webhooks: [], runs: [], holdFrom: null };
      log(s, 'user', prompt);
      try {
        s.plan = await ai.planTrip(prompt, (raw) => {
          const budgetSource = budgetFromText(prompt, raw.budget, raw.budgetQuote) ? 'text' : null;
          return scrub(normalizePlan(raw, null, { budgetSource, startDate }));
        }, { startDate });
      } catch (e) {
        throw asUserError(e);
      }
      log(s, 'agent', `Planned "${s.plan.title}": ${s.plan.items.length} items, $${(planTotalCents(s.plan) / 100).toFixed(2)} total.`);
      const end = tripEndDate(s.plan);
      if (end && addDays(end, -HOLD_LEAD_DAYS) > today()) {
        s.holdFrom = addDays(end, -HOLD_LEAD_DAYS);
        log(s, 'system', `This trip is too far away to hold money for yet: PayPal keeps a hold for 29 days. Come back on ${s.holdFrom} to place it.`);
      } else {
        await refreshCheckout(s);
      }
      await store.put(s);
      return s;
    },

    // A deferred checkout opens once the day comes (called by the daily check and when the trip is opened).
    async openDueCheckout() {
      const s = await load();
      if (!s?.holdFrom || s.closedAt || s.ledger.length > 0 || s.holdFrom > today()) return s;
      s.holdFrom = null;
      await refreshCheckout(s);
      log(s, 'system', 'The trip is close enough to place its PayPal hold now.');
      await store.put(s);
      return s;
    },

    async setBudget(dollars) {
      const s = await load();
      mustBeOpen(s);
      const cents = Math.round(Number(dollars) * 100);
      if (!Number.isFinite(cents) || cents <= 0) throw new UserFacingError('The budget must be a positive amount.', 'BAD_INPUT');
      if (planTotalCents(s.plan) > cents) throw new UserFacingError(`The plan already costs $${(planTotalCents(s.plan) / 100).toFixed(2)}, which is over that budget. Change the plan first or pick a larger budget.`, 'OVER_BUDGET');
      s.plan = { ...s.plan, budgetCents: cents, budgetSource: 'user' };
      log(s, 'user', `Confirmed a budget of $${(cents / 100).toFixed(2)}.`);
      await store.put(s);
      return s;
    },

    async addDocument(text) {
      const s = await load();
      mustBeOpen(s);
      const t = String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
      if (t.length < 20 || t.length > MAX_DOC_CHARS) throw new UserFacingError(`Paste the booking terms or confirmation (20-${MAX_DOC_CHARS} characters).`, 'BAD_INPUT');
      if (s.documents.length >= MAX_DOCS) throw new UserFacingError(`You can keep up to ${MAX_DOCS} documents on a trip.`, 'BAD_INPUT');
      const doc = { id: `d${s.documents.length + 1}`, text: t, addedAt: now() };
      s.documents.push(doc);
      log(s, 'user', `Added booking terms (${t.length} characters).`);
      await store.put(s);
      return s;
    },

    // The agent reports what a sentence of the person's documents means; code keeps it only if the quote is real.
    async recordPolicy(raw) {
      const s = await load();
      mustBeOpen(s);
      const fact = validatePolicyFact(raw, { docs: s.documents, plan: s.plan });
      const stored = { id: `f${s.policies.length + 1}`, ...fact, at: now() };
      s.policies = [...s.policies.filter((f) => f.itemId !== fact.itemId), stored];
      await store.put(s);
      return stored;
    },

    // The person edits the limits offered with checkout; that is a new checkout proposal with a new digest.
    async setMandateTerms(raw) {
      const s = await load();
      mustBeOpen(s);
      if (s.ledger.length > 0) throw new UserFacingError('The limits were signed with your first PayPal approval and cannot be changed here.', 'MANDATE_SIGNED');
      let terms;
      try { terms = normalizeTerms(raw, { maxValidUntil: lastMoment(s) + 30 * DAY_MS }); } catch (e) { throw new UserFacingError(e.message, 'BAD_INPUT'); }
      s.mandateDraft = terms;
      await refreshCheckout(s);
      await store.put(s);
      return s;
    },

    // What the agent decided, handed to code. Inside the signed limits it runs at once; otherwise it becomes a
    // proposal that waits for the person. Either way the proposal's words are written here, not by the model.
    async submitEdit({ ops, agentNote = null, runId = null }) {
      const s = await load();
      mustBeOpen(s);
      assertNoFailed(s);
      if (ops.some((o) => HUMAN_ONLY_OPS.includes(o.op))) throw new UserFacingError('Only you can change your budget. Ask the traveler instead.', 'BUDGET_IS_YOURS');
      const sim = simulate(s, ops);
      if (!sim.ok) throw new UserFacingError(sim.error, 'PLAN');
      // The traveler's own pasted terms must have been read before anything is cancelled or lowered.
      const unread = sim.losses.filter((l) => l.unchecked).map((l) => l.title);
      if (unread.length) throw new UserFacingError(`The traveler pasted booking terms, but nothing is recorded about ${unread.join(', ')}. Read them with read_documents and record what they say with record_policy (none: true if no sentence mentions the item), then submit again.`, 'TERMS_UNREAD');
      const source = { type: 'agent', runId };
      const lossLines = sim.losses.filter((l) => l.lossCents > 0).map((l) => ({ title: l.title, lossCents: l.lossCents, why: l.why, quote: l.quote }));
      if (agentNote) log(s, 'agent', String(agentNote).slice(0, 400));
      const summary = proposalSummary('change', s.plan, sim.newPlan);
      if (!sim.booked) {
        s.plan = sim.newPlan;
        await refreshCheckout(s);
        await store.put(s);
        return { outcome: 'updated', money: false, summary };
      }
      if (sim.actions.length === 0) {
        s.plan = sim.newPlan;
        s.activeProposal = null;
        log(s, 'system', `Plan updated. ${summary} No money moves.`);
        await store.put(s);
        return { outcome: 'updated', money: false, summary };
      }
      const p = await fresh(s, 'change', summary, sim.actions, sim.newPlan, { agentNote: agentNote ? String(agentNote).slice(0, 400) : undefined, source, ...(lossLines.length ? { operatorLoss: lossLines } : {}) });
      if (sim.mandate.within) {
        await confirmByMandate(p, s.mandate, sim.mandate, now());
        log(s, 'system', `Inside the limits you signed, so the agent went ahead: ${summary}`);
        await execute(s, p);
        await store.put(s);
        return { outcome: p.status === 'executed' ? 'executed' : 'failed', proposalId: p.id, money: true, summary, effect: sim.effect, error: p.error, mandate: sim.mandate };
      }
      log(s, 'system', `This needs your OK: ${sim.mandate.reasons.map((r) => r.text).join(' ')}`);
      p.outside = sim.mandate.reasons;
      await store.put(s);
      return { outcome: 'proposed', proposalId: p.id, money: true, summary, effect: sim.effect, mandate: sim.mandate };
    },

    async closeTrip() {
      const s = await load();
      mustBeOpen(s);
      if (s.ledger.length === 0) throw new UserFacingError('Nothing to close yet: this trip has not been booked.', 'NOTHING_TO_CLOSE');
      assertNoFailed(s);
      log(s, 'user', 'Close trip and settle remaining holds.');
      await proposeClose(s);
      await store.put(s);
      return s;
    },

    // The same money difference, worked out again from the plan and the ledger as they are now. No model call:
    // this is the way out of an expired proposal. It only applies to a proposal nothing has run for.
    async refreshProposal(proposalId) {
      const s = await load();
      mustBeOpen(s);
      const p = getProposal(s, proposalId);
      if (!p) throw new UserFacingError('Proposal not found.', 'NOT_FOUND');
      if (s.activeProposal !== p.id || !['pending', 'confirmed', 'expired'].includes(p.status) || p.results.length > 0) {
        throw new UserFacingError('This proposal cannot be refreshed.', 'NOT_REFRESHABLE');
      }
      p.status = 'superseded';
      if (p.kind === 'checkout') await refreshCheckout(s);
      else if (p.kind === 'close') await proposeClose(s);
      else {
        const actions = diffToActions(s.plan, p.newPlan, s.ledger);
        if (actions.length === 0) { s.plan = p.newPlan; s.activeProposal = null; log(s, 'system', 'Plan updated. No money moves.'); }
        else await fresh(s, 'change', proposalSummary('change', s.plan, p.newPlan), actions, p.newPlan, { agentNote: p.agentNote, source: p.source });
      }
      log(s, 'system', 'Amounts were worked out again from the current trip. Nothing was sent to the model.');
      await store.put(s);
      return s;
    },

    // The person pressed the confirm button for exactly the digest they were shown.
    async confirm(proposalId, digest) {
      const s = await load();
      const p = getProposal(s, proposalId);
      if (!p) throw new UserFacingError('Proposal not found.', 'NOT_FOUND');
      activeOnly(s, p);
      needBudget(s);
      try {
        await confirmProposal(p, digest, now());
      } catch (e) { await store.put(s); throw asUserError(e); }
      log(s, 'system', `Confirmed by a person: ${p.actions.length} action(s), most that can move $${(paypalEffect(p.actions).mostCanMoveCents / 100).toFixed(2)}.`);
      if (!p.actions.some((a) => a.type === 'hold')) await execute(s, p);
      await store.put(s);
      return s;
    },

    async createOrder(proposalId, fundingSource = 'paypal') {
      const s = await load();
      const p = getProposal(s, proposalId);
      if (!p || p.status !== 'confirmed') throw new UserFacingError('Confirm the proposal before PayPal approval.', 'NOT_CONFIRMED');
      activeOnly(s, p);
      needBudget(s);
      const holds = await assertHoldsMayMove(s, p);
      try {
        const o = await paypal.createHoldOrder(holds, { tripId: s.id, requestId: `${p.id}:order:${fundingSource}`, fundingSource });
        p.orderId = o.orderId;
      } catch (e) { log(s, 'error', e.message); await store.put(s); throw e; }
      await store.put(s);
      return { orderId: p.orderId };
    },

    async approveOrder(proposalId, orderId) {
      const s = await load();
      const p = getProposal(s, proposalId);
      if (!p || !['confirmed', 'executing', 'failed'].includes(p.status)) throw new UserFacingError(p?.status === 'superseded' ? 'The plan changed after you opened PayPal, so this approval was not used and nothing was held. Review the new proposal and approve again.' : 'This proposal is not waiting for PayPal approval.', 'NOT_CONFIRMED');
      activeOnly(s, p);
      needBudget(s);
      if (p.orderId !== orderId) throw new UserFacingError('That PayPal order does not belong to this proposal.', 'WRONG_ORDER');
      if (!s.ledger.some((f) => f.op === 'authorize' && f.orderId === orderId)) {
        const holds = await assertHoldsMayMove(s, p);
        let authorized = null;
        try {
          const { authFact, itemBreakdown } = await paypal.authorizeOrder(orderId, { requestId: `${p.id}:authorize`, proposalId: p.id });
          authorized = authFact;
          const expectedTotal = holds.reduce((sum, h) => sum + h.cents, 0);
          if (itemBreakdown) {
            for (const h of holds) {
              const b = itemBreakdown.find((x) => x.itemId === h.itemId);
              if (!b || b.cents !== h.cents) {
                throw new UserFacingError(`PayPal authorized $${((b?.cents ?? 0) / 100).toFixed(2)} for ${h.itemId}, which does not match the confirmed amount.`, 'MISMATCH');
              }
            }
          }
          if (authFact.cents !== expectedTotal) {
            throw new UserFacingError(`PayPal authorized $${(authFact.cents / 100).toFixed(2)}, which does not match the confirmed $${(expectedTotal / 100).toFixed(2)}.`, 'MISMATCH');
          }
          appendFact(s.ledger, authFact);
          for (const h of holds) {
            if (h.itemId !== BUFFER_ID) appendFact(s.ledger, { op: 'allocate', id: authFact.id, itemId: h.itemId, proposalId: p.id, cents: h.cents, status: 'ALLOCATED', at: now() });
            p.results.push({ index: p.actions.indexOf(h), ok: true });
          }
        } catch (e) {
          // PayPal placed a hold we did not ask for: give it back at once so nothing is left holding the buyer's money.
          if (authorized && e instanceof UserFacingError && e.code === 'MISMATCH') {
            try {
              await paypal.voidAuthorization(authorized.id, '_reserve', { requestId: `${p.id}:void-mismatch`, proposalId: p.id, cents: authorized.cents });
              e.message += ' The hold was released. Nothing was charged.';
            } catch { e.message += ' The hold could not be released automatically and will lapse by itself. Nothing was charged.'; }
          }
          log(s, 'error', e.message); await store.put(s); throw e;
        }
      }
      await execute(s, p);
      await store.put(s);
      return s;
    },

    async retry(proposalId) {
      const s = await load();
      const p = getProposal(s, proposalId);
      if (!p || p.status !== 'failed') throw new UserFacingError('Nothing to retry.', 'NOT_FAILED');
      activeOnly(s, p);
      p.status = 'executing';
      await execute(s, p);
      await store.put(s);
      return s;
    },

    // PayPal told us about something (verified by the caller). Kept in the trip's own record so the agent can see it.
    async recordWebhook(event) {
      const s = await load();
      if (!s) return { stored: false };
      if (s.webhooks.some((w) => w.id === event.id)) return { stored: false, duplicate: true };
      const r = event.resource ?? {};
      const ours = s.ledger.some((f) => f.id === r.id || f.parentId === r.id);
      const entry = { id: event.id, type: event.event_type, at: now(), resourceId: r.id ?? null, status: r.status ?? null, cents: r.amount?.value ? Math.round(Number(r.amount.value) * 100) : null, known: ours };
      s.webhooks = [...s.webhooks, entry].slice(-30);
      log(s, 'system', `PayPal reported: ${event.event_type.replace('PAYMENT.', '').replace(/\./g, ' ').toLowerCase()}${r.status ? ` (${r.status})` : ''}.`);
      const attention = ['PAYMENT.AUTHORIZATION.VOIDED'].includes(event.event_type) && s.ledger.some((f) => f.op === 'authorize' && f.id === r.id) && !s.ledger.some((f) => f.op === 'void' && f.id === r.id);
      if (attention) s.attention = { type: event.event_type, resourceId: r.id, at: now() };
      await store.put(s);
      return { stored: true, attention };
    },

    async noteRun(summary) {
      const s = await load();
      if (!s) return;
      s.runs = [...s.runs.filter((r) => r.id !== summary.id), summary].slice(-12);
      if (summary.status !== 'running' && s.attention && summary.trigger === 'webhook') s.attention = null;
      await store.put(s);
    },

    async reconcile() {
      const s = await load();
      const remote = await paypal.remoteState(s.ledger);
      return reconcile(s.ledger, remote, s.plan);
    },

    isOwner(s, tokenHash) { return Boolean(s?.ownerTokenHash) && s.ownerTokenHash === tokenHash; },

    view(s, { owner = false } = {}) {
      const items = s.plan.items.map((i) => ({ ...i, date: dayDate(s.plan.startDate, i.day), money: itemState(s.ledger, i.id) }));
      const removed = [...new Set(s.ledger.map((f) => f.itemId).filter((id) => id && id !== '_reserve'))]
        .filter((id) => !s.plan.items.some((i) => i.id === id))
        .map((id) => ({ id, title: Object.values(s.proposals).flatMap((p) => p.actions).find((a) => a.itemId === id)?.title ?? id, money: itemState(s.ledger, id) }));
      const active = s.activeProposal ? s.proposals[s.activeProposal] : null;
      const m = s.mandate;
      return {
        id: s.id,
        now: now(),
        owner,
        closed: Boolean(s.closedAt),
        closedAt: s.closedAt ?? null,
        holdFrom: s.holdFrom ?? null,
        plan: { ...s.plan, items },
        removedItems: removed,
        reserves: reserves(s.ledger),
        canClose: !s.closedAt && s.ledger.length > 0,
        totals: { plannedCents: planTotalCents(s.plan), ...ledgerTotals(s.ledger) },
        perPerson: perPersonCents(s.plan),
        ledger: s.ledger,
        proposal: active && active.status !== 'failed' ? publicProposal(s, active, owner) : null,
        failed: active?.status === 'failed' ? publicProposal(s, active, owner) : null,
        mandate: m ? { terms: m.terms, used: m.used, uses: m.uses, digest: m.digest, text: describeTerms(m.terms), refundLeftCents: Math.max(0, m.terms.refundCapCents - m.used.refundCents), baselineTotalCents: m.baselineTotalCents } : null,
        mandateDraft: s.mandateDraft ?? (active?.mandateTerms ?? null),
        documents: s.documents,
        policies: s.policies,
        webhooks: s.webhooks.slice(-8),
        runs: s.runs,
        events: s.events,
        attention: s.attention ?? null,
      };
    },
  };
}
