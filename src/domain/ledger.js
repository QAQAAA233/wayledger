// The ledger is append-only. PayPal facts ('authorize', 'capture', 'void', 'refund')
// store what PayPal returned; quota entries ('allocate', 'release') track how each
// PayPal authorization (a Trip Reserve) is allocated across plan items.
//
// Fact: { seq, at, op, itemId, id, parentId, orderId, proposalId, cents, status }
//   op: 'authorize' | 'allocate' | 'release' | 'capture' | 'void' | 'refund'
//   id: PayPal id of the authorization / capture / refund (for 'allocate'/'release', the authorization id)
//   parentId: the authorization a capture came from, or the capture a refund came from
//   cents/status: copied from the PayPal response for PayPal ops; quota amount for 'allocate'/'release'

const VALID_OPS = ['authorize', 'allocate', 'release', 'capture', 'void', 'refund'];
const VALID_OPEN_AUTH = ['CREATED', 'PENDING', 'PARTIALLY_CAPTURED'];

export function appendFact(ledger, fact) {
  if (!VALID_OPS.includes(fact.op)) throw new Error(`Unknown ledger op ${fact.op}`);
  if (!fact.id || !fact.status || !Number.isInteger(fact.cents)) throw new Error('A ledger fact must carry PayPal id, status and amount.');
  const stored = { ...fact, seq: ledger.length + 1 };
  ledger.push(stored);
  return stored;
}

// Fold the facts of one item into its current quota and payment state.
export function itemState(ledger, itemId) {
  const auths = new Map();
  const captures = new Map();
  for (const f of ledger) {
    if (f.itemId !== itemId) continue;
    if (f.op === 'allocate' || f.op === 'authorize') {
      const cur = auths.get(f.id) ?? { id: f.id, cents: 0, open: f.status !== 'VOIDED' };
      cur.cents += f.cents;
      if (f.status !== 'VOIDED') cur.open = true;
      auths.set(f.id, cur);
    }
    if (f.op === 'release' && auths.has(f.id)) {
      const a = auths.get(f.id);
      a.cents = Math.max(0, a.cents - f.cents);
      if (a.cents === 0) a.open = false;
    }
    if (f.op === 'void' && auths.has(f.id)) {
      const a = auths.get(f.id);
      a.cents = 0;
      a.open = false;
    }
    if (f.op === 'capture') {
      captures.set(f.id, { id: f.id, authId: f.parentId, cents: f.cents, refunded: 0 });
      const a = auths.get(f.parentId);
      if (a) {
        a.cents = Math.max(0, a.cents - f.cents);
        if (a.cents === 0) a.open = false;
      }
    }
    if (f.op === 'refund' && captures.has(f.parentId)) captures.get(f.parentId).refunded += f.cents;
  }
  const openAuths = [...auths.values()].filter((a) => a.open && a.cents > 0);
  const heldCents = openAuths.reduce((a, b) => a + b.cents, 0);
  const capturedCents = [...captures.values()].reduce((a, b) => a + b.cents, 0);
  const refundedCents = [...captures.values()].reduce((a, b) => a + b.refunded, 0);
  const paidCents = capturedCents - refundedCents;
  let status = 'planned';
  if (heldCents > 0) status = 'held';
  else if (paidCents > 0) status = refundedCents > 0 ? 'part-refunded' : 'paid';
  else if (capturedCents > 0) status = 'refunded';
  else if (auths.size > 0) status = 'released';
  return { itemId, status, heldCents, capturedCents, refundedCents, paidCents, openAuths, captures: [...captures.values()] };
}

// Fold every PayPal authorization (Trip Reserve) in the ledger into its object state.
export function reserves(ledger) {
  const authIds = [...new Set(ledger.filter((f) => f.op === 'authorize' || f.op === 'allocate').map((f) => f.id))];
  const itemIds = [...new Set(ledger.map((f) => f.itemId).filter((id) => id && id !== '_reserve'))];
  const states = new Map(itemIds.map((id) => [id, itemState(ledger, id)]));

  return authIds.map((authId) => {
    const authFacts = ledger.filter((f) => f.op === 'authorize' && f.id === authId);
    const reserveFact = authFacts.find((f) => f.itemId === '_reserve');
    const authorizedCents = reserveFact ? reserveFact.cents : authFacts.reduce((s, f) => s + f.cents, 0);
    const captures = ledger.filter((f) => f.op === 'capture' && f.parentId === authId);
    const capturedCents = captures.reduce((s, c) => s + c.cents, 0);
    const voidFacts = ledger.filter((f) => f.op === 'void' && f.id === authId);
    const voided = voidFacts.length > 0 || authFacts.some((f) => f.status === 'VOIDED');
    const voidedCents = voidFacts.reduce((s, f) => s + f.cents, 0);

    const heldItems = [];
    for (const [itemId, st] of states.entries()) {
      const oa = st.openAuths.find((a) => a.id === authId);
      if (oa && oa.cents > 0) heldItems.push({ itemId, cents: oa.cents });
    }
    const heldCents = heldItems.reduce((s, h) => s + h.cents, 0);
    const unusedCents = voided ? 0 : Math.max(0, authorizedCents - capturedCents - heldCents);
    const open = !voided && capturedCents < authorizedCents;

    return {
      id: authId,
      seq: authFacts[0]?.seq ?? 0,
      orderId: authFacts[0]?.orderId ?? null,
      authorizedCents,
      capturedCents,
      heldCents,
      unusedCents,
      voided,
      voidedCents,
      open,
      heldItems,
      captures,
    };
  });
}

export function ledgerTotals(ledger) {
  const ids = [...new Set(ledger.map((f) => f.itemId).filter((id) => id && id !== '_reserve'))];
  const states = ids.map((id) => itemState(ledger, id));
  const res = reserves(ledger);
  return {
    heldCents: states.reduce((a, s) => a + s.heldCents, 0),
    paidCents: states.reduce((a, s) => a + s.paidCents, 0),
    refundedCents: states.reduce((a, s) => a + s.refundedCents, 0),
    unusedReserveCents: res.reduce((a, r) => a + r.unusedCents, 0),
    authorizedCents: res.reduce((a, r) => a + r.authorizedCents, 0),
  };
}

// Reconcile at the object level:
// 1. Every Authorization (Trip Reserve): check status, authorized amount, captured total,
//    and verify that if any item is HELD on it, the authorization is still active in PayPal.
// 2. Every Capture: check status (COMPLETED / REFUNDED / PARTIALLY_REFUNDED) and amount.
// 3. Every Refund: check status (COMPLETED) and amount.
export function reconcile(ledger, remote) {
  const rows = [];
  const res = reserves(ledger);

  for (const r of res) {
    const rem = remote[r.id];
    const remoteStatus = rem?.status ?? 'MISSING';
    const remoteCents = rem?.cents ?? null;
    const amountOk = remoteCents === r.authorizedCents;
    const allCapturesPresent = r.captures.every((c) => remote[c.id] != null);
    const remoteCapturedCents = r.captures.reduce((s, c) => s + (remote[c.id]?.cents ?? 0), 0);
    const capturedOk = allCapturesPresent && remoteCapturedCents === r.capturedCents && r.capturedCents <= r.authorizedCents;

    // Any HELD item on this reserve requires the PayPal authorization to be open and have sufficient remaining balance
    const holdsValidOk = r.heldCents === 0
      ? true
      : (!r.voided && VALID_OPEN_AUTH.includes(remoteStatus) && remoteCents != null && (r.capturedCents + r.heldCents <= remoteCents));

    let expectStatus;
    let statusOk;
    if (r.heldCents > 0) {
      expectStatus = r.capturedCents > 0 ? 'PARTIALLY_CAPTURED' : 'CREATED';
      statusOk = (r.capturedCents > 0 ? ['PARTIALLY_CAPTURED', 'CREATED'] : ['CREATED', 'PENDING']).includes(remoteStatus);
    } else if (r.voided) {
      expectStatus = 'VOIDED';
      statusOk = remoteStatus === 'VOIDED';
    } else if (r.capturedCents >= r.authorizedCents) {
      expectStatus = 'CAPTURED';
      statusOk = ['CAPTURED', 'PARTIALLY_CAPTURED'].includes(remoteStatus);
    } else {
      expectStatus = r.capturedCents > 0 ? 'PARTIALLY_CAPTURED' : 'CREATED';
      statusOk = (r.capturedCents > 0 ? ['PARTIALLY_CAPTURED', 'CREATED'] : ['CREATED', 'PENDING']).includes(remoteStatus);
    }

    rows.push({
      seq: r.seq,
      op: 'authorize',
      itemId: '_reserve',
      id: r.id,
      ledgerCents: r.authorizedCents,
      paypalCents: remoteCents,
      capturedCents: r.capturedCents,
      paypalCapturedCents: remoteCapturedCents,
      heldCents: r.heldCents,
      heldItems: r.heldItems.map((h) => h.itemId),
      ledgerStatus: expectStatus,
      paypalStatus: remoteStatus,
      match: statusOk && amountOk && capturedOk && holdsValidOk,
    });
  }

  for (const f of ledger) {
    if (f.op !== 'capture' && f.op !== 'refund') continue;
    const rem = remote[f.id];
    const remoteStatus = rem?.status ?? 'MISSING';
    const remoteCents = rem?.cents ?? null;
    let expectStatus = f.status;
    let statusOk = remoteStatus === expectStatus;
    if (f.op === 'capture') {
      const refundedCents = ledger.filter((x) => x.op === 'refund' && x.parentId === f.id).reduce((a, x) => a + x.cents, 0);
      if (refundedCents > 0) {
        expectStatus = refundedCents >= f.cents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        statusOk = [expectStatus, 'COMPLETED'].includes(remoteStatus);
      }
    }
    const amountOk = remoteCents === f.cents;
    rows.push({
      seq: f.seq,
      op: f.op,
      itemId: f.itemId,
      id: f.id,
      ledgerCents: f.cents,
      paypalCents: remoteCents,
      ledgerStatus: expectStatus,
      paypalStatus: remoteStatus,
      match: statusOk && amountOk,
    });
  }

  const heldItemsCheck = res.flatMap((r) => {
    const rem = remote[r.id];
    const remoteStatus = rem?.status ?? 'MISSING';
    const valid = !r.voided && VALID_OPEN_AUTH.includes(remoteStatus) && rem?.cents === r.authorizedCents && (r.capturedCents + r.heldCents <= rem.cents);
    return r.heldItems.map((h) => ({ itemId: h.itemId, heldCents: h.cents, authId: r.id, paypalAuthStatus: remoteStatus, valid }));
  });

  return {
    rows,
    heldItemsCheck,
    allMatch: rows.every((r) => r.match) && heldItemsCheck.every((h) => h.valid),
  };
}
