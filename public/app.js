const $app = document.getElementById('app');
const S = { trip: null, busy: null, error: null, tab: 'budget', recon: null, draft: '', changeDraft: '', config: null };
let grids = [];
let ppRenderedFor = null;
let timer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const STATUS = { planned: 'Planned', held: 'Held', paid: 'Paid', released: 'Released', refunded: 'Refunded', 'part-refunded': 'Part refunded' };
const OPS = { authorize: 'Hold', capture: 'Charge', void: 'Release hold', refund: 'Refund' };

const SAMPLE_TRIPS = [
  'Three friends - Ana, Ben and Cy - 4 days in Lisbon in May. Budget $1,200 total. We want a flat, a sunset boat tour and a Sintra day trip.',
  'Family of four, long weekend in Kyoto. Budget $2,400. A ryokan night, a cooking class and the bullet train.',
  'Two of us, a weekend at Lake Tahoe, $900 all in. Cabin, kayak rental and one nice dinner.',
];
const SAMPLE_CHANGES = [
  'A storm is forecast for day 2. Swap any outdoor activity for an indoor one.',
  'We found a free place to stay, so drop the lodging.',
  'The last traveler cannot come anymore. Lower the shared costs accordingly.',
];

async function api(path, method = 'GET', body) {
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw { message: 'Could not reach the server. Check your connection and try again. Nothing was changed.', retry: true };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data.error ?? { message: 'Unexpected error. Nothing was changed.', retry: true };
  return data;
}

function run(label, fn, retryFn) {
  S.busy = label; S.error = null; render();
  return fn().then((v) => { S.busy = null; return v; }).catch((e) => { S.busy = null; S.error = { ...e, retryFn }; render(); });
}

function setTrip(t) {
  S.trip = t; S.recon = null;
  try { localStorage.setItem('wayledger:last', t.id); } catch {}
  if (location.hash !== `#/t/${t.id}`) history.replaceState(null, '', `#/t/${t.id}`);
  render();
}

function createTrip() {
  const prompt = S.draft.trim();
  const go = () => run('Planning your trip...', async () => setTrip(await api('/trips', 'POST', { prompt })), go);
  return go();
}

function sendChange(text) {
  const t = text ?? S.changeDraft.trim();
  if (!t) return;
  const go = () => run('The agent is working out the money difference...', async () => { S.changeDraft = ''; setTrip(await api(`/trips/${S.trip.id}/changes`, 'POST', { text: t })); }, go);
  return go();
}

function confirmRelease() {
  const p = S.trip.proposal;
  const go = () => run('Confirming and talking to PayPal...', async () => setTrip(await api(`/trips/${S.trip.id}/proposals/${p.id}/confirm`, 'POST', { digest: p.digest })), go);
  return go();
}

function retryProposal() {
  const p = S.trip.lastProposal;
  const go = () => run('Retrying the remaining steps...', async () => setTrip(await api(`/trips/${S.trip.id}/proposals/${p.id}/retry`, 'POST')), go);
  return go();
}

async function verify() {
  S.busy = 'Asking PayPal for the current state of every record...'; render();
  try { S.recon = await api(`/trips/${S.trip.id}/reconcile`); S.error = null; }
  catch (e) { S.error = e; }
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
  if (!el || !p || !p.actions.some((a) => a.type === 'hold') || p.status === 'executed') { ppRenderedFor = null; return; }
  if (ppRenderedFor === p.id + p.status) return;
  ppRenderedFor = p.id + p.status;
  try {
    await loadPayPalSdk();
    window.paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'pay', height: 44 },
      createOrder: async () => {
        try {
          if (S.trip.proposal.status === 'pending') S.trip = await api(`/trips/${S.trip.id}/proposals/${p.id}/confirm`, 'POST', { digest: p.digest });
          const { orderId } = await api(`/trips/${S.trip.id}/proposals/${p.id}/order`, 'POST');
          return orderId;
        } catch (e) { S.error = e; render(); throw e; }
      },
      onApprove: async (data) => {
        S.busy = 'PayPal approved. Placing the holds and applying the change...'; render();
        try { setTrip(await api(`/trips/${S.trip.id}/proposals/${p.id}/approve`, 'POST', { orderId: data.orderID })); S.busy = null; render(); }
        catch (e) { S.busy = null; S.error = e; render(); }
      },
      onCancel: () => { S.error = null; S.notice = 'PayPal approval was cancelled. No money moved. You can approve again whenever you are ready.'; render(); },
      onError: () => { S.error = { message: 'PayPal could not complete the approval. No money moved - you can try again.', retry: true }; render(); },
    }).render('#pp');
  } catch {
    el.innerHTML = '<div class="err">PayPal could not be loaded. Check your connection and reload.</div>';
  }
}

/* ---------- views ---------- */

function errorBox() {
  if (!S.error) return '';
  const e = S.error;
  return `<div class="err" role="alert"><b>${esc(e.message)}</b>${e.debugId ? ` <small>(PayPal debug id ${esc(e.debugId)})</small>` : ''}${e.retryFn ? `<div class="row"><button class="btn small" data-act="retry-error">Try again</button></div>` : ''}</div>`;
}

function landing() {
  return `<section class="hero">
    <h1>Plan the trip. Let the money follow.</h1>
    <p class="lead">Tell the agent where you are going and what you can spend. It builds the itinerary and budget, places PayPal holds, and when the plan changes it works out exactly what to release or refund. Nothing moves until you confirm.</p>
    <div class="card">
      <label for="prompt" class="sr" style="position:absolute;left:-9999px">Describe your trip</label>
      <textarea id="prompt" rows="4" maxlength="1200" placeholder="Three of us, Lisbon, 4 days in May, $1,200 total. A flat, a boat tour, a Sintra day trip.">${esc(S.draft)}</textarea>
      <div class="row" style="margin-top:12px"><button class="btn" data-act="plan" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="spin"></span>${esc(S.busy)}` : 'Plan my trip'}</button><span style="color:var(--muted);font-size:.85rem">Try one:</span></div>
      <div class="chips">${SAMPLE_TRIPS.map((t, i) => `<button class="chip" data-act="sample" data-i="${i}">${esc(t.length > 62 ? t.slice(0, 60) + '...' : t)}</button>`).join('')}</div>
      ${errorBox()}
    </div>
    <div class="how">
      <div><b>1. Plan</b>One sentence in. Itinerary, budget and who owes what come out.</div>
      <div><b>2. Hold</b>You approve once in PayPal. Each item gets its own authorization; lodging is paid up front.</div>
      <div><b>3. Change</b>Rain, a cancellation, someone drops out. The agent proposes the void, refund or new hold. You confirm.</div>
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
  const label = (a) => a.type === 'hold' ? `<span class="k">Hold</span>${esc(a.title)}${a.captureAfter ? ' <small>(charged now)</small>' : ''}` : a.type === 'void' ? `<span class="k">Release</span>${esc(a.title)}` : `<span class="k">Refund</span>${esc(a.title)}`;
  const net = p.netCents;
  const netText = net === 0 ? 'No net change' : net > 0 ? `${usd(net)} more on hold or charged` : `${usd(-net)} released or returned`;
  const title = p.kind === 'checkout' ? 'Ready to book' : 'The plan changed - here is the money difference';
  return `<section class="card proposal" aria-label="Proposal awaiting confirmation">
    <h2>${title}</h2>
    <div style="font-size:.95rem">${esc(p.summary)}</div>
    <ul class="acts">${p.actions.map((a) => `<li class="${a.type}"><span>${label(a)}</span><b>${usd(a.cents)}</b></li>`).join('')}</ul>
    <div class="sumline"><span>Net: <b>${netText}</b></span><span>Confirmed cap: <b>${usd(p.capCents)}</b></span><span>Expires in <b id="exp"></b></span></div>
    ${hasHold ? '<div style="font-size:.85rem;color:var(--muted)">Pressing the PayPal button confirms exactly the amounts above, then PayPal asks you to approve. Sandbox buyer logins are in the README.</div><div id="pp"></div>'
      : `<div class="row"><button class="btn" data-act="confirm" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="spin"></span>${esc(S.busy)}` : `Confirm - release ${usd(p.capCents)}`}</button></div>`}
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
  return `<section class="card"><h2>Agent</h2>
    <div class="feed" id="feed">${t.events.map((e) => `<div class="msg ${e.kind}"><b>${kinds[e.kind]}</b>${esc(e.text)}</div>`).join('')}</div>
    <div class="row" style="flex-wrap:nowrap"><input type="text" id="change" maxlength="800" placeholder="Tell the agent what changed..." value="${esc(S.changeDraft)}" aria-label="What changed"><button class="btn" data-act="change" ${S.busy ? 'disabled' : ''}>Send</button></div>
    <div class="chips">${SAMPLE_CHANGES.map((c, i) => `<button class="chip" data-act="sample-change" data-i="${i}">${esc(c.length > 54 ? c.slice(0, 52) + '...' : c)}</button>`).join('')}</div>
    ${S.busy && S.trip ? `<div class="notice"><span class="spin"></span>${esc(S.busy)}</div>` : ''}${S.notice ? `<div class="notice">${esc(S.notice)}</div>` : ''}${errorBox()}</section>`;
}

function ledgerCard() {
  const t = S.trip;
  const r = S.recon;
  const verifyLine = r ? (r.allMatch ? `<span class="ok">Ledger matches PayPal: ${r.rows.length}/${r.rows.length} records checked</span>` : `<span class="bad">${r.rows.filter((x) => !x.match).length} record(s) differ from PayPal</span>`) : '<span style="color:var(--muted)">Every row below is copied from a PayPal response.</span>';
  return `<section class="card"><h2>Budget &amp; ledger</h2>
    <div class="tabs" role="tablist"><button class="tab" role="tab" data-act="tab" data-tab="budget" aria-selected="${S.tab === 'budget'}">Budget by item</button><button class="tab" role="tab" data-act="tab" data-tab="ledger" aria-selected="${S.tab === 'ledger'}">PayPal ledger (${t.ledger.length})</button></div>
    <div class="grid-wrap"><div id="grid" class="ag-theme-quartz" style="height:${S.tab === 'budget' ? 60 + 42 * Math.max(3, t.plan.items.length + t.removedItems.length) : 60 + 42 * Math.max(3, t.ledger.length)}px;max-height:520px"></div></div>
    <div class="verify"><button class="btn ghost small" data-act="verify" ${S.busy ? 'disabled' : ''} ${t.ledger.length ? '' : 'disabled'}>Verify against PayPal</button>${verifyLine}</div>
  </section>`;
}

function tripView() {
  const t = S.trip; const tot = t.totals;
  const per = Object.entries(t.perPerson).map(([n, c]) => `<span>${esc(n)} <b>${usd(c)}</b></span>`).join('');
  return `<div class="tripbar"><div><h1>${esc(t.plan.title)}</h1><div class="sub">${esc(t.plan.destination)} &middot; ${esc(t.plan.travelers.join(', '))}${t.plan.budgetCents ? ` &middot; budget ${usd(t.plan.budgetCents)}` : ''}</div></div><button class="btn ghost small" data-act="new">New trip</button></div>
  <div class="stats"><div class="stat"><small>Planned</small><b>${usd(tot.plannedCents)}</b></div><div class="stat"><small>On hold</small><b>${usd(tot.heldCents)}</b></div><div class="stat"><small>Paid</small><b>${usd(tot.paidCents)}</b></div><div class="stat"><small>Refunded</small><b>${usd(tot.refundedCents)}</b></div></div>
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
  if (S.tab === 'budget') {
    const rows = [...t.plan.items.map((i) => ({ day: i.day, item: i.title, category: i.category, total: i.amountCents, status: i.money.status, held: i.money.heldCents, paid: i.money.paidCents, refunded: i.money.refundedCents })),
      ...t.removedItems.map((r) => ({ day: null, item: `${r.title} (removed)`, category: 'removed', total: 0, status: r.money.status, held: r.money.heldCents, paid: r.money.paidCents, refunded: r.money.refundedCents }))];
    grids.push(agGrid.createGrid(el, { rowData: rows, domLayout: 'normal', columnDefs: [
      { field: 'day', width: 70, headerName: 'Day' }, { field: 'item', headerName: 'Item', flex: 2, minWidth: 190 }, { field: 'category', width: 110 },
      { field: 'total', headerName: 'Planned', valueFormatter: money, width: 110, type: 'rightAligned' },
      { field: 'status', cellRenderer: pill, width: 140 },
      { field: 'held', headerName: 'Held', valueFormatter: money, width: 100, type: 'rightAligned' },
      { field: 'paid', headerName: 'Paid', valueFormatter: money, width: 100, type: 'rightAligned' },
      { field: 'refunded', headerName: 'Refunded', valueFormatter: money, width: 110, type: 'rightAligned' },
    ], defaultColDef: { sortable: true, resizable: true }, suppressCellFocus: true }));
  } else {
    const title = (id) => t.plan.items.find((i) => i.id === id)?.title ?? id;
    const rows = [...t.ledger].reverse().map((f) => ({ seq: f.seq, at: new Date(f.at).toLocaleTimeString(), op: OPS[f.op], item: title(f.itemId), id: f.id, cents: f.cents, status: f.status }));
    grids.push(agGrid.createGrid(el, { rowData: rows, columnDefs: [
      { field: 'seq', headerName: '#', width: 64 }, { field: 'at', headerName: 'Time', width: 100 }, { field: 'op', headerName: 'Action', width: 130 },
      { field: 'item', flex: 2, minWidth: 180 }, { field: 'id', headerName: 'PayPal ID', width: 190, cellStyle: { fontFamily: 'ui-monospace, monospace', fontSize: '12px' } },
      { field: 'cents', headerName: 'Amount', valueFormatter: money, width: 110, type: 'rightAligned' }, { field: 'status', headerName: 'PayPal status', width: 130 },
    ], defaultColDef: { sortable: true, resizable: true }, suppressCellFocus: true }));
  }
}

/* ---------- render & events ---------- */

function render() {
  const active = document.activeElement?.id;
  $app.innerHTML = S.trip ? tripView() : landing();
  if (active === 'prompt' || active === 'change') { const el = document.getElementById(active); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }
  mountGrid(); mountPayPal(); tick();
  const feed = document.getElementById('feed'); if (feed) feed.scrollTop = feed.scrollHeight;
}

function tick() {
  clearInterval(timer);
  const el = document.getElementById('exp');
  if (!el || !S.trip?.proposal) return;
  const upd = () => {
    const left = Math.max(0, S.trip.proposal.expiresAt - Date.now());
    el.textContent = left ? `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}` : 'expired - ask again';
  };
  upd(); timer = setInterval(upd, 1000);
}

$app.addEventListener('input', (e) => { if (e.target.id === 'prompt') S.draft = e.target.value; if (e.target.id === 'change') S.changeDraft = e.target.value; });
$app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'change') { e.preventDefault(); sendChange(); } });
$app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'plan') { if (S.draft.trim().length >= 8) createTrip(); else { S.error = { message: 'Describe the trip in a sentence or two first.' }; render(); } }
  else if (a === 'sample') { S.draft = SAMPLE_TRIPS[b.dataset.i]; render(); }
  else if (a === 'sample-change') { S.changeDraft = SAMPLE_CHANGES[b.dataset.i]; render(); }
  else if (a === 'change') sendChange();
  else if (a === 'confirm') confirmRelease();
  else if (a === 'retry-proposal') retryProposal();
  else if (a === 'retry-error') S.error?.retryFn?.();
  else if (a === 'verify') verify();
  else if (a === 'tab') { S.tab = b.dataset.tab; render(); }
  else if (a === 'new') { S.trip = null; S.error = null; S.recon = null; history.replaceState(null, '', '#/'); render(); }
});
window.addEventListener('resize', (() => { let w = innerWidth <= 900; return () => { const n = innerWidth <= 900; if (n !== w) { w = n; ppRenderedFor = null; render(); } }; })());

(async function boot() {
  S.config = await api('/config').catch(() => ({}));
  const m = location.hash.match(/^#\/t\/([0-9a-f]{24})$/);
  const id = m?.[1];
  if (id) { try { setTrip(await api(`/trips/${id}`)); return; } catch { history.replaceState(null, '', '#/'); } }
  render();
})();
