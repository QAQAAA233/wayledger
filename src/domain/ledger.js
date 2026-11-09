// The ledger is append-only and holds facts exactly as PayPal returned them.
// Nothing else in the app writes money state: per-item status and balances are folded from it.
//
// Fact: { seq, at, op, itemId, id, parentId, orderId, proposalId, cents, status }
//   op: 'authorize' | 'capture' | 'void' | 'refund'
//   id: PayPal id of the authorization / capture / refund this fact is about
//   parentId: the authorization a capture came from, or the capture a refund came from
//   cents/status: copied from the PayPal response, never from our own intent

export function appendFact(ledger, fact) {
  if (!['authorize', 'capture', 'void', 'refund'].includes(fact.op)) throw new Error(`Unknown ledger op ${fact.op}`);
  if (!fact.id || !fact.status || !Number.isInteger(fact.cents)) throw new Error('A ledger fact must carry PayPal id, status and amount.');
  const stored = { ...fact, seq: ledger.length + 1 };
  ledger.push(stored);
  return stored;
}

// Fold the facts of one item into its current money state.
export function itemState(ledger, itemId) {
  const auths = new Map();
  const captures = new Map();
  for (const f of ledger) {
    if (f.itemId !== itemId) continue;
    if (f.op === 'authorize') auths.set(f.id, { id: f.id, cents: f.cents, open: f.status === 'CREATED' || f.status === 'PENDING' });
    if (f.op === 'void' && auths.has(f.id)) auths.get(f.id).open = false;
    if (f.op === 'capture') {
      captures.set(f.id, { id: f.id, authId: f.parentId, cents: f.cents, refunded: 0 });
      const a = auths.get(f.parentId);
      if (a) a.open = false;
    }
    if (f.op === 'refund' && captures.has(f.parentId)) captures.get(f.parentId).refunded += f.cents;
  }
  const openAuths = [...auths.values()].filter((a) => a.open);
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

export function ledgerTotals(ledger) {
  const ids = [...new Set(ledger.map((f) => f.itemId))];
  const states = ids.map((id) => itemState(ledger, id));
  return {
    heldCents: states.reduce((a, s) => a + s.heldCents, 0),
    paidCents: states.reduce((a, s) => a + s.paidCents, 0),
    refundedCents: states.reduce((a, s) => a + s.refundedCents, 0),
  };
}

// Compare what we recorded with what PayPal says now. `remote` maps PayPal id -> {status, cents}.
export function reconcile(ledger, remote) {
  const rows = [];
  for (const f of ledger) {
    if (f.op === 'void') continue; // the authorization row below carries the VOIDED status
    const r = remote[f.id];
    const remoteStatus = r?.status ?? 'MISSING';
    let expectStatus = f.status;
    let statusOk = remoteStatus === expectStatus;
    if (f.op === 'authorize') {
      if (ledger.some((x) => x.op === 'void' && x.id === f.id)) {
        expectStatus = 'VOIDED';
        statusOk = remoteStatus === 'VOIDED';
      } else if (ledger.some((x) => x.op === 'capture' && x.parentId === f.id)) {
        expectStatus = 'CAPTURED';
        statusOk = ['CAPTURED', 'PARTIALLY_CAPTURED'].includes(remoteStatus);
      }
    } else if (f.op === 'capture') {
      const refundedCents = ledger.filter((x) => x.op === 'refund' && x.parentId === f.id).reduce((a, x) => a + x.cents, 0);
      if (refundedCents > 0) {
        expectStatus = refundedCents >= f.cents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        statusOk = [expectStatus, 'COMPLETED'].includes(remoteStatus);
      }
    }
    const expectedRemoteCents = f.op === 'authorize'
      ? ledger.filter((x) => x.op === 'authorize' && x.id === f.id).reduce((a, x) => a + x.cents, 0)
      : f.cents;
    const amountOk = r?.cents === expectedRemoteCents;
    rows.push({ seq: f.seq, op: f.op, itemId: f.itemId, id: f.id, ledgerCents: f.cents, paypalCents: amountOk ? f.cents : (r?.cents ?? null), ledgerStatus: expectStatus, paypalStatus: remoteStatus, match: statusOk && amountOk });
  }
  return { rows, allMatch: rows.every((r) => r.match) };
}
