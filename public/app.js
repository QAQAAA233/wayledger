const $app = document.getElementById('app');
const S = { trip: null, busy: null, error: null, errorAt: null, notice: null, tab: 'budget', recon: null, draft: '', changeDraft: '', config: null, skew: 0, expiredId: null, judge: null };
let grids = [];
let ppRenderedFor = null;
let timer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const clock = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const STATUS = { planned: 'Planned', held: 'Held', paid: 'Paid', released: 'Released', refunded: 'Refunded', 'part-refunded': 'Part refunded' };
const OPS = { authorize: 'Trip reserve', allocate: 'Allocate quota', release: 'Free quota', capture: 'Charge', void: 'Void reserve', refund: 'Refund' };
const PAYPAL_OPS = ['authorize', 'capture', 'void', 'refund'];

const SAMPLE_TRIPS = [
  'Three friends - Ana, Ben and Cy - 4 days in Lisbon in May. Budget $1,200 total. We want a flat, a sunset boat tour and a Sintra day trip.',
  'Family of four, long weekend in Kyoto. Budget $2,400. A ryokan night, a cooking class and the bullet train.',
  'Two of us, a weekend at Lake Tahoe, $900 all in. Cabin, kayak rental and one nice dinner.',
];
const SAMPLE_CHANGES = [
  'A storm is forecast for day 2. Swap any outdoor activity for an indoor one.',
  'We found a free place to stay, so drop the lodging.',
];

// The server's clock decides when a proposal expires; the browser only shows it.
const serverNow = () => Date.now() + S.skew;
const isExpired = (p) => p.status === 'expired' || S.expiredId === p.id || serverNow() >= p.expiresAt;

// A judge code (from the testing instructions) arrives as ?judge=... and is kept in this browser only.
function readJudgeCode() {
  const m = location.search.match(/[?&]judge=([^&#]+)/);
  try {
    if (m) { localStorage.setItem('wayledger:judge', decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname + location.hash); }
    return localStorage.getItem('wayledger:judge');
  } catch { return m ? decodeURIComponent(m[1]) : null; }
}

async function api(path, method = 'GET', body) {
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json', ...(S.judge ? { 'x-judge-code': S.judge } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw { message: 'Could not reach the server. Check your connection and try again. Nothing was changed.', retry: true };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data.error ?? { message: 'Unexpected error. Nothing was changed.', retry: true };
  return data;
}

// The cancelled-approval notice sits next to the PayPal button; clearing it must not redraw the button
// while PayPal is opening its window.
function clearNotice() {
  S.notice = null;
  document.getElementById('pp-notice')?.setAttribute('hidden', '');
}

// Anything that went wrong is shown where the person acted: next to the PayPal / confirm button
// (`proposal`) or in the agent panel (`agent`, `landing`).
function fail(e, at, retryFn) {
  S.busy = null;
  S.error = { message: e?.message ?? 'Something went wrong. Nothing was changed.', code: e?.code, debugId: e?.debugId, retry: e?.retry, retryFn: e?.retry ? retryFn : undefined };
  S.errorAt = at;
  if (e?.code === 'EXPIRED' && S.trip?.proposal) S.expiredId = S.trip.proposal.id;
  render();
}

// A step ends by clearing the busy state AND drawing again; drawing while still busy is how the PayPal
// button used to stay missing and Confirm stayed grey after a successful step.
function run(label, fn, retryFn, at = 'agent') {
  S.busy = label; S.error = null; S.notice = null; render();
  return fn().then(() => { S.busy = null; render(); }).catch((e) => fail(e, at, retryFn));
}

function setTrip(t) {
  S.trip = t; S.recon = null; S.notice = null;
  S.skew = (t.now ?? Date.now()) - Date.now();
  try { localStorage.setItem('wayledger:last', t.id); } catch {}
  if (location.hash !== `#/t/${t.id}`) history.replaceState(null, '', `#/t/${t.id}`);
  render();
}

function createTrip() {
  const prompt = S.draft.trim();
  const go = () => run('Planning your trip...', async () => setTrip(await api('/trips', 'POST', { prompt })), go, 'landing');
  return go();
}

function sendChange(text) {
  const t = text ?? S.changeDraft.trim();
  if (!t) return;
  const go = () => run('The agent is working out the money difference...', async () => { const next = await api(`/trips/${S.trip.id}/changes`, 'POST', { text: t }); S.changeDraft = ''; setTrip(next); }, go);
  return go();
}

function closeTrip() {
  const go = () => run('Preparing trip close & settlement proposal...', async () => setTrip(await api(`/trips/${S.trip.id}/close`, 'POST')), go);
  return go();
}

function confirmRelease() {
  const p = S.trip.proposal;
  const go = () => run('Confirming and updating the ledger...', async () => setTrip(await api(`/trips/${S.trip.id}/proposals/${p.id}/confirm`, 'POST', { digest: p.digest })), go, 'proposal');
  return go();
}

function refreshProposal() {
  const p = S.trip.proposal;
  const go = () => run('Working out the amounts again from the current trip...', async () => setTrip(await api(`/trips/${S.trip.id}/proposals/${p.id}/refresh`, 'POST')), go, 'proposal');
  return go();
}

function retryProposal() {
  const p = S.trip.lastProposal;
  const go = () => run('Retrying the remaining steps...', async () => setTrip(await api(`/trips/${S.trip.id}/proposals/${p.id}/retry`, 'POST')), go);
  return go();
}

async function verify() {
  S.busy = 'Asking PayPal for the current state of every authorization, capture and refund...'; render();
  try { S.recon = await api(`/trips/${S.trip.id}/reconcile`); S.error = null; }
  catch (e) { S.error = e; S.errorAt = 'agent'; }
  S.busy = null; render();
}

function loadPayPalSdk() {
  if (window.paypal) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(S.config.paypalClientId)}&intent=authorize&currency=USD&components=buttons&disable-funding=paylater,credit`;
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load PayPal'));
    document.head.appendChild(s);
  });
}

async function mountPayPal() {
  const p = S.trip?.proposal;
  const el = document.getElementById('pp');
  if (!el || S.busy || !p || !p.actions.some((a) => a.type === 'hold') || p.status === 'executed' || isExpired(p)) { ppRenderedFor = null; return; }
  if (ppRenderedFor === p.id + p.status && el.childElementCount > 0) return;
  ppRenderedFor = p.id + p.status;
  try {
    await loadPayPalSdk();
    window.paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'paypal', height: 44 },
      createOrder: async (data) => {
        try {
          clearNotice();
          if (S.trip.proposal.status === 'pending') S.trip = await api(`/trips/${S.trip.id}/proposals/${p.id}/confirm`, 'POST', { digest: p.digest });
          const { orderId } = await api(`/trips/${S.trip.id}/proposals/${p.id}/order`, 'POST', { fundingSource: data?.paymentSource });
          return orderId;
        } catch (e) { fail(e, 'proposal'); throw e; }
      },
      onApprove: async (data) => {
        clearNotice(); S.error = null; S.busy = 'PayPal approved. Placing the trip reserve, allocating quotas and applying the change...'; render();
        try { setTrip(await api(`/trips/${S.trip.id}/proposals/${p.id}/approve`, 'POST', { orderId: data.orderID })); S.busy = null; render(); }
        catch (e) { fail(e, 'proposal'); }
      },
      onCancel: () => { S.error = null; S.notice = 'PayPal approval was cancelled. No money moved. You can approve again whenever you are ready.'; render(); },
      onError: () => { if (!S.error) fail({ message: 'PayPal could not complete the approval. No money moved - you can try again.' }, 'proposal'); },
    }).render('#pp');
  } catch {
    el.innerHTML = '<div class="err">PayPal could not be loaded. Check your connection and reload.</div>';
  }
}

/* ---------- views ---------- */

function errorBox(...ats) {
  if (!S.error || !ats.includes(S.errorAt)) return '';
  const e = S.error;
  return `<div class="err" role="alert"><b>${esc(e.message)}</b>${e.debugId ? ` <small>(PayPal debug id ${esc(e.debugId)})</small>` : ''}${e.retryFn ? `<div class="row"><button class="btn small" data-act="retry-error">Try again</button></div>` : ''}</div>`;
}

function landing() {
  return `<section class="hero">
    <h1>Plan the trip. Let the money follow.</h1>
    <p class="lead">Tell the agent where you are going and what you can spend. It builds the itinerary and budget, places a PayPal trip reserve with a quota per item, and when the plan changes it reallocates reserve quota or proposes a refund. Nothing moves until you confirm.</p>
    <div class="card">
      <label for="prompt" class="sr" style="position:absolute;left:-9999px">Describe your trip</label>
      <textarea id="prompt" rows="4" maxlength="1200" placeholder="Three of us, Lisbon, 4 days in May, $1,200 total. A flat, a boat tour, a Sintra day trip.">${esc(S.draft)}</textarea>
      <div class="row" style="margin-top:12px"><button class="btn" data-act="plan" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="spin"></span>${esc(S.busy)}` : 'Plan my trip'}</button><span style="color:var(--muted);font-size:.85rem">Try one:</span></div>
      <div class="chips">${SAMPLE_TRIPS.map((t, i) => `<button class="chip" data-act="sample" data-i="${i}">${esc(t.length > 62 ? t.slice(0, 60) + '...' : t)}</button>`).join('')}</div>
      ${errorBox('landing')}
    </div>
    <div class="how">
      <div><b>1. Plan</b>One sentence in. Itinerary, budget and who owes what come out.</div>
      <div><b>2. Hold</b>You approve once in PayPal to place a trip reserve. Each item gets a quota under the reserve; prepaid lodging is charged up front.</div>
      <div><b>3. Change &amp; Close</b>When plans change, the agent reallocates reserve quota or proposes a refund. At trip close, held items are captured and unused reserve is voided.</div>
    </div>
  </section>`;
}

function itemRow(i) {
  const st = i.money.status;
  const detail = st === 'held' ? `${usd(i.money.heldCents)} on hold` : st === 'paid' ? `${usd(i.money.paidCents)} paid` : st === 'part-refunded' ? `${usd(i.money.paidCents)} paid, ${usd(i.money.refundedCents)} refunded` : '';
  return `<div class="item"><div class="t">${esc(i.title)}</div><div class="amt">${usd(i.amountCents)}</div>
    <div class="meta">${esc(i.category)} &middot; ${esc(i.participants.length === S.trip.plan.travelers.length ? 'everyone' : i.participants.join(', '))}${detail ? ` &middot; ${detail}` : ''}</div>
    <div class="st"><span class="pill ${st}">${STATUS[st]}</span></div></div>`;
}

function itinerary() {
  const t = S.trip;
  const days = [...new Set(t.plan.items.map((i) => i.day))].sort((a, b) => a - b);
  return days.map((d) => `<div class="day"><h3>Day ${d}</h3>${t.plan.items.filter((i) => i.day === d).map(itemRow).join('')}</div>`).join('');
}

function proposalCard() {
  const t = S.trip; const p = t.proposal;
  if (!p) return '';
  const hasHold = p.actions.some((a) => a.type === 'hold');
  const expired = isExpired(p);
  const label = (a) => {
    if (a.type === 'hold') return `<span class="k">Hold</span>${esc(a.title)}${a.captureAfter ? ' <small>(charged now)</small>' : ' <small>(in trip reserve)</small>'}`;
    if (a.type === 'allocate') return `<span class="k">Use reserve</span>${esc(a.title)} <small>(from existing trip reserve)</small>`;
    if (a.type === 'release') return `<span class="k">Free quota</span>${esc(a.title)} <small>(freed in trip reserve; voided at close)</small>`;
    if (a.type === 'capture') return `<span class="k">Charge</span>${esc(a.title)} <small>(settle held quota)</small>`;
    if (a.type === 'void') return `<span class="k">Void reserve</span>${esc(a.title)} <small>(release in PayPal)</small>`;
    return `<span class="k">Refund</span>${esc(a.title)}`;
  };
  const net = p.netCents;
  let netText;
  if (p.kind === 'close') {
    const capSum = p.actions.filter((a) => a.type === 'capture').reduce((s, a) => s + a.cents, 0);
    const voidSum = p.actions.filter((a) => a.type === 'void').reduce((s, a) => s + a.cents, 0);
    netText = `${usd(capSum)} charged · ${usd(voidSum)} unused reserve voided`;
  } else {
    netText = net === 0 ? 'No net change' : net > 0 ? `${usd(net)} more on hold or charged` : `${usd(-net)} released or returned`;
  }
  const title = p.kind === 'checkout' ? 'Ready to book' : p.kind === 'close' ? 'Close trip - settle holds & void unused reserve' : 'The plan changed - here is the money difference';
  const btnText = p.kind === 'close' ? `Confirm & close trip (${usd(p.capCents)})` : p.actions.every((a) => a.type === 'refund') ? `Confirm - refund ${usd(p.capCents)}` : `Confirm plan & quota change`;
  const unfunded = p.unfunded?.length ? `<div class="notice">Never booked, so nothing to settle for: ${p.unfunded.map((u) => `${esc(u.title)} (${usd(u.cents)})`).join(', ')}.</div>` : '';
  let action;
  if (expired) {
    action = `<div class="expired"><b>This proposal timed out.</b> Nothing was held or charged. Refreshing works out the same change again from the current trip, without asking the model.</div>
      <div class="row"><button class="btn" data-act="refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="spin"></span>${esc(S.busy)}` : 'Refresh amounts'}</button></div>`;
  } else if (hasHold) {
    action = '<div style="font-size:.85rem;color:var(--muted)">Pressing the PayPal button confirms the exact amounts above, then PayPal asks you to approve the trip reserve.</div><div id="pp"></div>';
  } else {
    action = `<div class="row"><button class="btn" data-act="confirm" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="spin"></span>${esc(S.busy)}` : btnText}</button></div>`;
  }
  return `<section class="card proposal" aria-label="Proposal awaiting confirmation">
    <h2>${title}</h2>
    <div style="font-size:.95rem">${esc(p.summary)}</div>
    <ul class="acts">${p.actions.map((a) => `<li class="${a.type}"><span>${label(a)}</span><b>${usd(a.cents)}</b></li>`).join('')}</ul>
    ${unfunded}
    <div class="sumline"><span>Net: <b>${netText}</b></span><span>Confirmed cap: <b>${usd(p.capCents)}</b></span><span>Expires in <b id="exp"></b></span></div>
    ${action}
    <div class="notice" id="pp-notice" ${S.notice ? '' : 'hidden'}>${esc(S.notice ?? '')}</div>${errorBox('proposal')}
  </section>`;
}

function failedCard() {
  const p = S.trip.lastProposal;
  if (!p || p.status !== 'failed') return '';
  return `<section class="card" style="border-color:var(--danger)"><h2>One step did not go through</h2><div class="err" style="margin-top:0">${esc(p.error)}</div>
    <p style="font-size:.9rem;color:var(--muted)">The steps that succeeded are already in the ledger. The rest has not run. Retrying only repeats what is missing.</p>
    <button class="btn" data-act="retry-proposal" ${S.busy ? 'disabled' : ''}>Retry the remaining steps</button></section>`;
}

function agentCard() {
  const t = S.trip;
  const kinds = { user: 'You', agent: 'Agent', system: 'Ledger', error: 'Problem' };
  const input = t.closed ? '' : `<div class="row" style="flex-wrap:nowrap"><input type="text" id="change" maxlength="800" placeholder="Tell the agent what changed..." value="${esc(S.changeDraft)}" aria-label="What changed"><button class="btn" data-act="change" ${S.busy ? 'disabled' : ''}>Send</button></div>
    <div class="chips">${SAMPLE_CHANGES.map((c, i) => `<button class="chip" data-act="sample-change" data-i="${i}">${esc(c.length > 54 ? c.slice(0, 52) + '...' : c)}</button>`).join('')}</div>`;
  return `<section class="card"><h2>Agent</h2>
    <div class="feed" id="feed">${t.events.map((e) => `<div class="msg ${e.kind}"><b>${kinds[e.kind]}</b>${esc(e.text)}</div>`).join('')}</div>
    ${input}
    ${S.busy && S.trip ? `<div class="notice"><span class="spin"></span>${esc(S.busy)}</div>` : ''}${t.proposal ? '' : (S.notice ? `<div class="notice">${esc(S.notice)}</div>` : '')}${errorBox('agent', ...(t.proposal ? [] : ['proposal']))}</section>`;
}

function ledgerCard() {
  const t = S.trip;
  const r = S.recon;
  const paypalCount = t.ledger.filter((f) => PAYPAL_OPS.includes(f.op)).length;
  const quotaCount = t.ledger.length - paypalCount;
  const verifyLine = r
    ? (r.allMatch
      ? `<span class="ok">Ledger matches PayPal: ${r.rows.length}/${r.rows.length} PayPal records &amp; ${r.heldItemsCheck?.length ?? 0} held item(s) verified</span>`
      : `<span class="bad">${r.rows.filter((x) => !x.match).length + (r.heldItemsCheck?.filter((h) => !h.valid).length ?? 0)} discrepancy(s) against PayPal</span>`)
    : '<span style="color:var(--muted)">PayPal facts are copied from PayPal responses; quotas track item allocations under each trip reserve.</span>';
  const rows = S.tab === 'budget' ? Math.max(3, t.plan.items.length + t.removedItems.length) : Math.max(3, S.tab === 'paypal' ? paypalCount : quotaCount);
  return `<section class="card"><h2>Budget &amp; ledger</h2>
    <div class="tabs" role="tablist"><button class="tab" role="tab" data-act="tab" data-tab="budget" aria-selected="${S.tab === 'budget'}">Budget by item</button><button class="tab" role="tab" data-act="tab" data-tab="paypal" aria-selected="${S.tab === 'paypal'}">PayPal activity (${paypalCount})</button><button class="tab" role="tab" data-act="tab" data-tab="quota" aria-selected="${S.tab === 'quota'}">Item quotas (${quotaCount})</button></div>
    <div class="grid-wrap"><div id="grid" class="ag-theme-quartz" style="height:${60 + 42 * rows}px;max-height:520px"></div></div>
    <div class="verify"><button class="btn ghost small" data-act="verify" ${S.busy ? 'disabled' : ''} ${t.ledger.length ? '' : 'disabled'}>Verify against PayPal</button>${verifyLine}</div>
  </section>`;
}

function tripView() {
  const t = S.trip; const tot = t.totals;
  const per = Object.entries(t.perPerson).map(([n, c]) => `<span>${esc(n)} <b>${usd(c)}</b></span>`).join('');
  const showClose = t.canClose && t.proposal?.kind !== 'close';
  const closedNote = t.closed ? `<div class="notice closed">This trip is closed (${esc(new Date(t.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}). Held items were charged and the unused reserve was released in PayPal, so the plan and the money can no longer change. Start a new trip to plan something else.</div>` : '';
  return `<div class="tripbar"><div><h1>${esc(t.plan.title)}</h1><div class="sub">${esc(t.plan.destination)} &middot; ${esc(t.plan.travelers.join(', '))}${t.plan.budgetCents ? ` &middot; budget ${usd(t.plan.budgetCents)}` : ''}</div></div><div class="row">${showClose ? `<button class="btn small" data-act="close" ${S.busy ? 'disabled' : ''}>Close trip</button>` : ''}<button class="btn ghost small" data-act="new">New trip</button></div></div>
  ${closedNote}
  <div class="stats"><div class="stat"><small>Planned</small><b>${usd(tot.plannedCents)}</b></div><div class="stat"><small>On hold${tot.unusedReserveCents > 0 ? ` (+${usd(tot.unusedReserveCents)} free reserve)` : ''}</small><b>${usd(tot.heldCents)}</b></div><div class="stat"><small>Paid</small><b>${usd(tot.paidCents)}</b></div><div class="stat"><small>Refunded</small><b>${usd(tot.refundedCents)}</b></div></div>
  <div class="layout">
    <div class="col">${window.innerWidth <= 900 ? proposalCard() : ''}<section class="card"><h2>Itinerary</h2>${itinerary()}<h2 style="margin-top:14px">Shares</h2><div class="per">${per}</div></section>${ledgerCard()}</div>
    <div class="col">${window.innerWidth > 900 ? proposalCard() : ''}${failedCard()}${agentCard()}</div>
  </div>`;
}

/* ---------- grids ---------- */

function mountGrid() {
  grids.forEach((g) => g.destroy()); grids = [];
  const el = document.getElementById('grid');
  if (!el || !S.trip) return;
  const t = S.trip;
  const pill = (p) => `<span class="pill ${p.value}">${STATUS[p.value] ?? p.value}</span>`;
  const money = (p) => (p.value == null ? '' : usd(p.value));
  const defaultColDef = { sortable: true, resizable: true };
  if (S.tab === 'budget') {
    const rows = [...t.plan.items.map((i) => ({ day: i.day, item: i.title, total: i.amountCents, status: i.money.status, held: i.money.heldCents, paid: i.money.paidCents, refunded: i.money.refundedCents })),
      ...t.removedItems.map((r) => ({ day: null, item: `${r.title} (removed)`, total: 0, status: r.money.status, held: r.money.heldCents, paid: r.money.paidCents, refunded: r.money.refundedCents }))];
    grids.push(agGrid.createGrid(el, { rowData: rows, domLayout: 'normal', columnDefs: [
      { field: 'day', headerName: 'Day', width: 58, minWidth: 52 },
      { field: 'item', headerName: 'Item', flex: 3, minWidth: 130, tooltipField: 'item' },
      { field: 'total', headerName: 'Planned', valueFormatter: money, flex: 1, minWidth: 82, type: 'rightAligned' },
      { field: 'status', cellRenderer: pill, flex: 1.3, minWidth: 108 },
      { field: 'held', headerName: 'Held', valueFormatter: money, flex: 1, minWidth: 76, type: 'rightAligned' },
      { field: 'paid', headerName: 'Paid', valueFormatter: money, flex: 1, minWidth: 76, type: 'rightAligned' },
      { field: 'refunded', headerName: 'Refunded', valueFormatter: money, flex: 1, minWidth: 88, type: 'rightAligned' },
    ], defaultColDef, suppressCellFocus: true }));
    return;
  }
  const title = (id) => (id === '_reserve' ? 'Whole trip' : t.plan.items.find((i) => i.id === id)?.title ?? t.removedItems.find((i) => i.id === id)?.title ?? id);
  const wanted = (f) => (S.tab === 'paypal') === PAYPAL_OPS.includes(f.op);
  const rows = [...t.ledger].filter(wanted).reverse().map((f) => ({ at: clock.format(new Date(f.at)), op: OPS[f.op] ?? f.op, item: title(f.itemId), id: f.id, cents: f.cents, status: f.status }));
  const columnDefs = S.tab === 'paypal'
    ? [
      { field: 'op', headerName: 'Action', flex: 1.2, minWidth: 104 },
      { field: 'item', headerName: 'Item', flex: 2, minWidth: 110, tooltipField: 'item' },
      { field: 'cents', headerName: 'Amount', valueFormatter: money, flex: 1, minWidth: 84, type: 'rightAligned' },
      { field: 'status', headerName: 'PayPal status', flex: 1.2, minWidth: 112 },
      { field: 'id', headerName: 'PayPal ID', width: 140, cellStyle: { fontFamily: 'ui-monospace, monospace', fontSize: '12px' } },
      { field: 'at', headerName: 'Time', width: 84 },
    ]
    : [
      { field: 'op', headerName: 'Action', flex: 1.2, minWidth: 110 },
      { field: 'item', headerName: 'Item', flex: 2, minWidth: 130, tooltipField: 'item' },
      { field: 'cents', headerName: 'Amount', valueFormatter: money, flex: 1, minWidth: 84, type: 'rightAligned' },
      { field: 'status', headerName: 'Quota status', flex: 1.2, minWidth: 110 },
      { field: 'at', headerName: 'Time', width: 84 },
    ];
  grids.push(agGrid.createGrid(el, { rowData: rows, columnDefs, defaultColDef, suppressCellFocus: true }));
}

/* ---------- render & events ---------- */

function render() {
  const active = document.activeElement?.id;
  $app.innerHTML = S.trip ? tripView() : landing();
  if (active === 'prompt' || active === 'change') { const el = document.getElementById(active); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }
  mountGrid(); mountPayPal(); tick();
  const feed = document.getElementById('feed'); if (feed) feed.scrollTop = feed.scrollHeight;
}

// Counts down to the server's expiry. When it hits zero the card switches to its expired state once.
function tick() {
  clearInterval(timer);
  const el = document.getElementById('exp');
  const p = S.trip?.proposal;
  if (!el || !p) return;
  if (isExpired(p)) { el.textContent = 'expired'; return; }
  const upd = () => {
    const left = Math.max(0, p.expiresAt - serverNow());
    if (left) { el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`; return; }
    clearInterval(timer);
    S.expiredId = p.id; ppRenderedFor = null; render();
  };
  upd(); timer = setInterval(upd, 1000);
}

$app.addEventListener('input', (e) => { if (e.target.id === 'prompt') S.draft = e.target.value; if (e.target.id === 'change') S.changeDraft = e.target.value; });
$app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'change') { e.preventDefault(); sendChange(); } });
$app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'plan') { if (S.draft.trim().length >= 8) createTrip(); else { S.error = { message: 'Describe the trip in a sentence or two first.' }; S.errorAt = 'landing'; render(); } }
  else if (a === 'sample') { S.draft = SAMPLE_TRIPS[b.dataset.i]; render(); }
  else if (a === 'sample-change') { S.changeDraft = SAMPLE_CHANGES[b.dataset.i]; render(); }
  else if (a === 'change') sendChange();
  else if (a === 'close') closeTrip();
  else if (a === 'confirm') confirmRelease();
  else if (a === 'refresh') refreshProposal();
  else if (a === 'retry-proposal') retryProposal();
  else if (a === 'retry-error') S.error?.retryFn?.();
  else if (a === 'verify') verify();
  else if (a === 'tab') { S.tab = b.dataset.tab; render(); }
  else if (a === 'new') { S.trip = null; S.error = null; S.notice = null; S.recon = null; history.replaceState(null, '', '#/'); render(); }
});
window.addEventListener('resize', (() => { let w = innerWidth <= 900; return () => { const n = innerWidth <= 900; if (n !== w) { w = n; ppRenderedFor = null; render(); } }; })());

(async function boot() {
  S.judge = readJudgeCode();
  if (S.judge) document.getElementById('judge')?.removeAttribute('hidden');
  S.config = await api('/config').catch(() => ({}));
  const m = location.hash.match(/^#\/t\/([0-9a-f]{24})$/);
  const id = m?.[1];
  if (id) { try { setTrip(await api(`/trips/${id}`)); return; } catch { history.replaceState(null, '', '#/'); } }
  render();
})();
