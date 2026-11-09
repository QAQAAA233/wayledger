const $app = document.getElementById('app');
const S = { trip: null, busy: null, error: null, errorAt: null, notice: null, tab: 'budget', recon: null, draft: '', startDate: '', changeDraft: '', termsDraft: '', budgetDraft: '', showTerms: false, config: null, skew: 0, expiredId: null, judge: null, run: null, polling: null };
let grids = [];
let ppRenderedFor = null;
let timer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const clock = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const dateText = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
const dayDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const STATUS = { planned: 'Planned', held: 'Held', paid: 'Paid', released: 'Released', refunded: 'Refunded', 'part-refunded': 'Part refunded' };
const OPS = { authorize: 'Trip hold', allocate: 'Set aside', release: 'Freed up', capture: 'Charge', void: 'Hold released', refund: 'Refund' };
const PAYPAL_OPS = ['authorize', 'capture', 'void', 'refund'];
const isoIn = (days) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

const SAMPLE_TRIPS = [
  'Three friends - Ana, Ben and Cy - 4 days in Lisbon. Budget $1,200 total. A flat, a sunset boat tour that must be paid in advance, and a Sintra day trip.',
  'Family of four, long weekend in Kyoto. Budget $2,400. A ryokan night, a cooking class and the bullet train.',
  'Two of us, a weekend at Lake Tahoe, $900 all in. Cabin, kayak rental and one nice dinner.',
];
const SAMPLE_CHANGES = [
  'A storm is forecast for day 2. Swap any outdoor activity for an indoor one.',
  'We found a free place to stay, so drop the lodging.',
];
// Terms an operator might send, written with real dates from this trip so that the agent can quote them.
function sampleTerms() {
  const items = S.trip.plan.items;
  const act = items.find((i) => i.category === 'activity') ?? items.find((i) => i.category !== 'lodging') ?? items[0];
  const other = items.find((i) => i !== act && i.category !== 'lodging');
  const cut = act.date ? new Date(Date.parse(`${act.date}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10) : isoIn(2);
  return `${act.title}: free cancellation until ${cut} 12:00, after that non-refundable.${other ? `\n${other.title}: non-refundable from the moment of booking.` : ''}`;
}
const TOOL_LABEL = { get_trip: 'Trip', get_forecast: 'Forecast', search_places: 'Places', get_payment_status: 'PayPal', read_documents: 'Terms', record_policy: 'Terms', simulate_edit: 'Option', no_change: 'Done', ask_traveler: 'Question' };

// The server's clock decides when a proposal expires; the browser only shows it.
const serverNow = () => Date.now() + S.skew;
const isExpired = (p) => p.status === 'expired' || S.expiredId === p.id || serverNow() >= p.expiresAt;
const narrow = () => window.innerWidth <= 900;
const phone = () => window.innerWidth <= 600;

// A judge code (from the testing instructions) arrives as ?judge=... and is kept in this browser only.
function readJudgeCode() {
  const m = location.search.match(/[?&]judge=([^&#]+)/);
  try {
    if (m) { localStorage.setItem('wayledger:judge', decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname + location.hash); }
    return localStorage.getItem('wayledger:judge');
  } catch { return m ? decodeURIComponent(m[1]) : null; }
}

// Whoever plans a trip gets a secret that stays in this browser. It is what lets this browser, and only this one,
// confirm, approve, close and start the agent. A shared link lets anyone look.
const ownerKey = (id) => `wayledger:owner:${id}`;
const ownerToken = (id) => { try { return localStorage.getItem(ownerKey(id)); } catch { return null; } };
const keepOwnerToken = (id, token) => { try { localStorage.setItem(ownerKey(id), token); } catch { /* the trip still works until the page closes */ } };

async function api(path, method = 'GET', body) {
  const id = path.match(/^\/trips\/([0-9a-f]{24})/)?.[1];
  const token = id ? ownerToken(id) : null;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json', ...(S.judge ? { 'x-judge-code': S.judge } : {}), ...(token ? { 'x-owner-token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
  S.error = { message: e?.message ?? 'Something went wrong. Nothing was changed.', code: e?.code, debugId: e?.debugId, retry: e?.retry, restart: e?.restart, retryFn: e?.retry ? retryFn : undefined };
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
  const latest = t.runs?.at(-1);
  if (t.owner !== undefined && latest && ['queued', 'running'].includes(latest.status) && S.run?.id !== latest.id) watchRun(latest.id);
}

function createTrip() {
  const prompt = S.draft.trim();
  const startDate = S.startDate || isoIn(4);
  const go = () => run('Planning your trip...', async () => {
    const t = await api('/trips', 'POST', { prompt, startDate });
    keepOwnerToken(t.id, t.ownerToken);
    S.run = null; S.budgetDraft = ''; S.mandateForm = null;
    setTrip(t);
  }, go, 'landing');
  return go();
}

// ---- the agent's run: start it, then follow its record while it works ---------------------------------------------------

function stopPolling() { clearTimeout(S.polling); S.polling = null; }

function watchRun(runId) {
  stopPolling();
  const tick = async () => {
    let r;
    try { r = await api(`/trips/${S.trip.id}/runs/${runId}`); } catch { S.polling = setTimeout(tick, 1500); return; }
    S.run = r;
    updateTrail();
    if (['done', 'error'].includes(r.status)) {
      S.polling = null; S.busy = null;
      try { setTrip(await api(`/trips/${S.trip.id}`)); } catch (e) { fail(e, 'agent'); }
      return;
    }
    S.polling = setTimeout(tick, 700);
  };
  S.polling = setTimeout(tick, 250);
}

function startRun(path, body, label) {
  const go = () => run(label, async () => {
    const out = await api(`/trips/${S.trip.id}/${path}`, 'POST', body);
    S.changeDraft = ''; S.run = { id: out.runId, status: 'queued', events: [], trigger: path === 'wake' ? 'demo' : 'message' };
    S.busy = null;
    if (!out.runId) { setTrip(await api(`/trips/${S.trip.id}`)); return; }
    render();
    watchRun(out.runId);
  }, go);
  return go();
}

const sendChange = (text) => { const t = text ?? S.changeDraft.trim(); if (t) startRun('changes', { text: t }, 'Sending to the agent...'); };
const demoWake = () => startRun('wake', { demo: true }, 'Waking the agent...');

function closeTrip() {
  const go = () => run('Preparing the closing proposal...', async () => setTrip(await api(`/trips/${S.trip.id}/close`, 'POST')), go);
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
  const p = S.trip.failed;
  const go = () => run('Retrying the remaining steps...', async () => setTrip(await api(`/trips/${S.trip.id}/proposals/${p.id}/retry`, 'POST')), go);
  return go();
}

function saveBudget() {
  const amount = Number(String(S.budgetDraft).replace(/[$,\s]/g, ''));
  const go = () => run('Saving your budget...', async () => { setTrip(await api(`/trips/${S.trip.id}/budget`, 'POST', { amount })); S.budgetDraft = ''; S.editBudget = false; }, go, 'budget');
  return go();
}

function saveTerms() {
  const text = S.termsDraft.trim();
  const go = () => run('Saving your booking terms...', async () => { setTrip(await api(`/trips/${S.trip.id}/documents`, 'POST', { text })); S.termsDraft = ''; }, go, 'terms');
  return go();
}

function saveMandate() {
  const f = document.getElementById('mandate-form');
  const enabled = f.elements.enabled.checked;
  const body = enabled ? { enabled, refundCap: Number(f.elements.refund.value), planIncreaseCap: Number(f.elements.raise.value), validUntil: f.elements.until.value } : { enabled: false };
  const go = () => run('Updating the limits...', async () => { setTrip(await api(`/trips/${S.trip.id}/mandate`, 'POST', body)); S.mandateForm = null; }, go, 'proposal');
  return go();
}

async function verify() {
  S.busy = 'Asking PayPal for the current state of every hold, charge and refund...'; render();
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
  if (!el || S.busy || !p || !S.trip.owner || !p.actions.some((a) => a.type === 'hold') || p.status === 'executed' || isExpired(p)) { ppRenderedFor = null; return; }
  if (ppRenderedFor === p.id + p.status && el.childElementCount > 0) return;
  ppRenderedFor = p.id + p.status;
  try {
    await loadPayPalSdk();
    window.paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'paypal', height: 44 },
      createOrder: async (data) => {
        try {
          clearNotice();
          if (S.mandateForm) throw { message: 'You changed the limits but have not applied them yet. Press "Update limits" first, so that what you sign is what you see.' };
          if (S.trip.proposal.status === 'pending') S.trip = await api(`/trips/${S.trip.id}/proposals/${p.id}/confirm`, 'POST', { digest: p.digest });
          const { orderId } = await api(`/trips/${S.trip.id}/proposals/${p.id}/order`, 'POST', { fundingSource: data?.paymentSource });
          return orderId;
        } catch (e) { fail(e, 'proposal'); throw e; }
      },
      onApprove: async (data, actions) => {
        clearNotice(); S.error = null; S.busy = 'PayPal approved. Placing your hold and applying the change...'; render();
        try { setTrip(await api(`/trips/${S.trip.id}/proposals/${p.id}/approve`, 'POST', { orderId: data.orderID })); S.busy = null; render(); }
        catch (e) {
          // PayPal could not use the payment method: let the buyer pick another one in the same window.
          fail(e, 'proposal');
          if (e?.issue === 'INSTRUMENT_DECLINED' && actions?.restart) return actions.restart();
        }
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
  const last = (() => { try { return localStorage.getItem('wayledger:last'); } catch { return null; } })();
  return `<section class="hero">
    <h1>Plan the trip. Let the money follow.</h1>
    <p class="lead">Tell the agent where you are going and what you can spend. It plans the trip and holds the money with PayPal. When plans change, an AI agent looks at the real forecast, real places and your booking terms, and keeps the plan and the money in step. You sign the limits it may act within; anything beyond them waits for your OK.</p>
    <div class="card">
      <label for="prompt" class="sr" style="position:absolute;left:-9999px">Describe your trip</label>
      <textarea id="prompt" rows="4" maxlength="1200" placeholder="Three of us, Lisbon, 4 days, $1,200 total. A flat, a boat tour, a Sintra day trip.">${esc(S.draft)}</textarea>
      <div class="row" style="margin-top:12px">
        <label class="date">First day <input type="date" id="start" min="${isoIn(0)}" max="${isoIn(365)}" value="${esc(S.startDate || isoIn(4))}"></label>
        <button class="btn" data-act="plan" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="spin"></span>${esc(S.busy)}` : 'Plan my trip'}</button>
      </div>
      <div class="row" style="margin-top:8px"><span style="color:var(--muted);font-size:.85rem">Try one:</span></div>
      <div class="chips">${SAMPLE_TRIPS.map((t, i) => `<button class="chip" data-act="sample" data-i="${i}">${esc(t.length > 62 ? t.slice(0, 60) + '...' : t)}</button>`).join('')}</div>
      ${errorBox('landing')}
      ${last ? `<p class="hint"><a href="#/t/${esc(last)}">Open your last trip</a></p>` : ''}
    </div>
    <div class="how">
      <div><b>1. Plan</b>One sentence in. Itinerary, budget and who owes what come out.</div>
      <div><b>2. Sign your limits</b>You approve one PayPal hold, and the most the agent may refund or add on its own. Prepaid items are charged now.</div>
      <div><b>3. Let it watch</b>The agent checks the forecast and your terms, tries options, and acts inside your limits. Anything bigger waits for you.</div>
    </div>
  </section>`;
}

function itemRow(i) {
  const st = i.money.status;
  const detail = st === 'held' ? `${usd(i.money.heldCents)} on hold` : st === 'paid' ? `${usd(i.money.paidCents)} paid` : st === 'part-refunded' ? `${usd(i.money.paidCents)} paid, ${usd(i.money.refundedCents)} refunded` : '';
  const wd = i.placeId?.startsWith('wd:') ? ` &middot; <a href="https://www.wikidata.org/wiki/${esc(i.placeId.slice(3))}" target="_blank" rel="noopener">real place</a>` : '';
  const basis = i.amountBasis === 'same_as_replaced' ? '<div class="basis">Budget set aside at the price of what it replaces. The ticket price was not looked up.</div>' : '';
  const when = i.amountCents === 0 ? 'free' : i.prepaid ? 'paid in advance' : 'paid when the trip closes';
  return `<div class="item"><div class="t">${esc(i.title)}</div><div class="amt">${i.amountCents === 0 ? 'Free' : usd(i.amountCents)}</div>
    <div class="meta">${esc(i.category)} &middot; ${esc(i.participants.length === S.trip.plan.travelers.length ? 'everyone' : i.participants.join(', '))} &middot; ${when}${detail ? ` &middot; ${detail}` : ''}${wd}</div>${basis}
    <div class="st"><span class="pill ${st}">${i.amountCents === 0 ? 'Free' : STATUS[st]}</span></div></div>`;
}

function itinerary() {
  const t = S.trip;
  const days = [...new Set(t.plan.items.map((i) => i.day))].sort((a, b) => a - b);
  return days.map((d) => { const date = t.plan.items.find((i) => i.day === d)?.date; return `<div class="day"><h3>Day ${d}${date ? ` &middot; ${esc(dateText(date))}` : ''}</h3>${t.plan.items.filter((i) => i.day === d).map(itemRow).join('')}</div>`; }).join('');
}

function budgetBar() {
  const t = S.trip;
  const p = t.plan;
  if (t.closed) return '';
  if (p.budgetSource) return `<div class="budget ok">Budget <b>${usd(p.budgetCents)}</b> &middot; ${p.budgetSource === 'user' ? 'confirmed by you' : 'from your own words'}${t.owner && !t.ledger.length ? ` <button class="linkbtn" data-act="budget-edit">change</button>` : ''}${S.editBudget ? budgetForm(p) + errorBox('budget') : ''}</div>`;
  if (!t.owner) return '<div class="budget warn">The traveler has not confirmed a budget yet, so nothing can be held.</div>';
  return `<div class="budget warn"><div><b>Confirm your budget first.</b> Nothing is held until you do. ${p.budgetCents ? `The planner suggested ${usd(p.budgetCents)}, but a budget only counts when it comes from you.` : 'Your message did not state one.'}</div>${budgetForm(p)}${errorBox('budget')}</div>`;
}
function budgetForm(p) {
  return `<form class="row" id="budget-form" style="margin-top:8px"><label class="date">Budget $ <input type="text" inputmode="decimal" id="budget" value="${esc(S.budgetDraft || (p.budgetCents ? (p.budgetCents / 100).toFixed(0) : ''))}" placeholder="1200" size="8"></label><button class="btn small" data-act="budget-save" type="button" ${S.busy ? 'disabled' : ''}>Confirm budget</button></form>`;
}

function mandateEditor(p) {
  const t = p.mandateTerms ?? { enabled: false, refundCapCents: 0, planIncreaseCapCents: 0, validUntil: Date.now() };
  // numbers typed but not applied yet stay on the screen until the person applies them
  const d = S.mandateForm ?? { enabled: t.enabled, refund: Math.round(t.refundCapCents / 100), raise: Math.round(t.planIncreaseCapCents / 100), until: new Date(t.validUntil || Date.now()).toISOString().slice(0, 10) };
  const buffer = p.actions.find((a) => a.itemId === '_buffer');
  return `<form class="mandate" id="mandate-form">
    <label class="check"><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}> <b>Let the agent make changes on its own, inside these limits</b></label>
    <div class="row">
      <label class="date">Refund up to $ <input type="number" name="refund" min="0" step="1" value="${esc(d.refund)}"></label>
      <label class="date">Raise the plan by up to $ <input type="number" name="raise" min="0" step="1" value="${esc(d.raise)}"></label>
      <label class="date">Until <input type="date" name="until" value="${esc(d.until)}"></label>
      <button class="btn small ghost" type="button" data-act="mandate-save" ${S.busy ? 'disabled' : ''}>Update limits</button>
    </div>
    <div class="notice" id="mandate-dirty" ${S.mandateForm ? '' : 'hidden'}>These numbers are not applied yet. Press <b>Update limits</b>, then approve in PayPal.</div>
    <div class="hint">You sign these once, together with your PayPal approval. Anything beyond them waits for you.${buffer ? ` Your hold includes ${usd(buffer.cents)} as a buffer for changes. Whatever is not used is released when the trip closes.` : ''}</div>
  </form>`;
}

function proposalCard() {
  const t = S.trip; const p = t.proposal;
  if (!p) return '';
  const hasHold = p.actions.some((a) => a.type === 'hold');
  const expired = isExpired(p);
  const owner = t.owner;
  const title = p.kind === 'checkout' ? 'Ready to book' : p.kind === 'close' ? 'Close the trip' : p.outside ? 'A change is waiting for your OK' : 'Review this change';
  const btnText = p.kind === 'close' ? 'Confirm and close the trip' : p.actions.every((a) => a.type === 'refund') ? `Confirm and refund ${usd(p.mostCanMoveCents)}` : 'Confirm this change';
  const unfunded = p.unfunded?.length ? `<div class="notice">Never booked, so there is nothing to settle for: ${p.unfunded.map((u) => `${esc(u.title)} (${usd(u.cents)})`).join(', ')}.</div>` : '';
  const why = p.outside?.length ? `<div class="notice waits"><b>Why the agent did not just do it</b><ul>${p.outside.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul></div>` : '';
  const note = p.agentNote ? `<div class="agentnote"><b>Agent's note</b> ${esc(p.agentNote)}</div>` : '';
  let action;
  if (!owner) action = '<div class="hint">Only the person who planned this trip can confirm it.</div>';
  else if (expired) {
    action = `<div class="expired"><b>This proposal timed out.</b> Nothing was held or charged. Refreshing works out the same change again from the current trip, without asking the model.</div>
      <div class="row"><button class="btn" data-act="refresh" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="spin"></span>${esc(S.busy)}` : 'Refresh amounts'}</button></div>`;
  } else if (!t.plan.budgetSource) action = '<div class="hint">Confirm your budget above to continue.</div>';
  else if (hasHold) action = '<div style="font-size:.85rem;color:var(--muted)">Pressing the PayPal button confirms the amounts above, then PayPal asks you to approve the hold.</div><div id="pp"></div>';
  else action = `<div class="row"><button class="btn" data-act="confirm" ${S.busy ? 'disabled' : ''}>${S.busy ? `<span class="spin"></span>${esc(S.busy)}` : btnText}</button></div>`;
  return `<section class="card proposal" aria-label="Proposal awaiting confirmation">
    <h2>${title}</h2>
    <div class="summary">${esc(p.summary)}</div>
    ${note}
    <ul class="acts">${p.lines.map((l) => `<li class="${l.type}"><span>${esc(l.text)}</span></li>`).join('')}</ul>
    <div class="effect">${esc(p.effectText)}</div>
    ${unfunded}${why}
    <div class="sumline"><span>Most that can move in PayPal: <b>${usd(p.mostCanMoveCents)}</b></span><span>Expires in <b id="exp"></b></span></div>
    ${p.kind === 'checkout' && owner && !t.ledger.length ? mandateEditor(p) : ''}
    ${action}
    <div class="notice" id="pp-notice" ${S.notice ? '' : 'hidden'}>${esc(S.notice ?? '')}</div>${errorBox('proposal')}
  </section>`;
}

function failedCard() {
  const p = S.trip.failed;
  if (!p) return '';
  return `<section class="card" style="border-color:var(--danger)"><h2>One step did not go through</h2><div class="err" style="margin-top:0">${esc(p.error ?? 'PayPal did not finish.')}</div>
    <p style="font-size:.9rem;color:var(--muted)">The steps that succeeded are already in the ledger. The rest has not run. Retrying only repeats what is missing, and nothing else can change until it is done.</p>
    ${S.trip.owner ? `<button class="btn" data-act="retry-proposal" ${S.busy ? 'disabled' : ''}>Retry the remaining steps</button>` : ''}</section>`;
}

/* ----- the agent's work trail ----- */

function eventHtml(e) {
  if (e.kind === 'model') return '';
  const label = e.kind === 'tool' ? (TOOL_LABEL[e.tool] ?? 'Tool') : { wake: 'Start', decision: 'Decision', result: 'Result', paypal_check: 'PayPal', guard: 'Check', note: 'Note', model_error: 'Model' }[e.kind] ?? e.kind;
  const cls = ['ev', e.kind, e.rejected ? 'rej' : '', e.simulated ? 'sim' : '', e.waiting ? 'wait' : '', e.failed ? 'bad' : '', e.ok === true ? 'good' : ''].filter(Boolean).join(' ');
  return `<li class="${cls}"><span class="evtag">${esc(label)}</span><div class="evb">
    <div class="evt">${esc(e.title)}${e.simulated ? ' <span class="simbadge">SIMULATED</span>' : ''}</div>
    ${e.detail ? `<div class="evd">${e.agentReason ? '<i>Agent\'s reason:</i> ' : ''}${esc(e.detail)}</div>` : ''}
    ${e.note ? `<div class="evd"><i>Agent's note to you:</i> ${esc(e.note)}</div>` : ''}
    ${e.quote ? `<blockquote>&ldquo;${esc(e.quote)}&rdquo; <small>from your terms</small></blockquote>` : ''}
    ${e.source ? `<div class="evs">Source: ${esc(e.source)}</div>` : ''}
  </div></li>`;
}

function trailHtml() {
  const r = S.run;
  if (!r) return '<div class="hint">When you send a change, or the agent wakes up, every step it takes shows up here: what it looked up, what it saw, which options it tried, and why it chose.</div>';
  const working = ['queued', 'running'].includes(r.status);
  const calls = r.events.filter((e) => e.kind === 'model').length;
  return `<div class="runhead">${working ? '<span class="spin"></span> The agent is working' : 'Last run'}${r.simulated ? ' <span class="simbadge">demo, simulated forecast</span>' : ''}</div>
    <ol class="trail">${r.events.map(eventHtml).join('')}${working ? '<li class="ev working"><span class="evtag">...</span><div class="evb"><div class="evt">Working</div></div></li>' : ''}</ol>
    ${!working && calls ? `<div class="evs">${calls} step${calls === 1 ? '' : 's'} of thinking, ${r.stats?.neurons != null ? `${r.stats.neurons} units of AI compute` : 'AI compute not recorded'}${r.stats?.model ? `, model ${esc(r.stats.model)}` : ''}.</div>` : ''}`;
}

function updateTrail() {
  const el = document.getElementById('trail');
  if (el) el.innerHTML = trailHtml();
  const send = document.querySelector('[data-act="change"]');
  if (send) send.disabled = Boolean(S.run && ['queued', 'running'].includes(S.run.status)) || Boolean(S.busy);
}

function authorityLine() {
  const t = S.trip;
  const m = t.mandate;
  if (m) return `<div class="authority ok"><b>Acting within your limits.</b> ${m.terms.enabled ? `Refunds: ${usd(m.refundLeftCents)} left of ${usd(m.terms.refundCapCents)}. Plan raise: up to ${usd(m.terms.planIncreaseCapCents)}. Until ${esc(dayDate(m.terms.validUntil))}.` : 'None given.'}</div>`;
  if (t.ledger.length) return '<div class="authority">You signed no limits, so every change waits for your OK.</div>';
  return '<div class="authority">The agent starts acting on its own after you sign limits with your first PayPal approval. Until then it only proposes.</div>';
}

function termsPanel() {
  const t = S.trip;
  if (!t.owner || t.closed) return t.documents.length ? termsList() : '';
  return `<details class="terms" ${S.showTerms || t.documents.length ? 'open' : ''}><summary>Booking terms (optional): paste what the operators sent you</summary>
    <textarea id="terms" rows="3" maxlength="4000" placeholder="Paste a cancellation policy or booking confirmation...">${esc(S.termsDraft)}</textarea>
    <div class="row"><button class="btn small ghost" data-act="terms-save" ${S.busy ? 'disabled' : ''}>Save terms</button><button class="linkbtn" data-act="terms-sample">Use a sample</button></div>${errorBox('terms')}
    ${termsList()}
  </details>`;
}
function termsList() {
  const t = S.trip;
  const docs = t.documents.map((d) => `<div class="doc">${esc(d.text.length > 160 ? d.text.slice(0, 158) + '...' : d.text)}</div>`).join('');
  const rules = t.policies.map((p) => `<blockquote>&ldquo;${esc(p.quote)}&rdquo; <small>${esc(p.itemTitle)}: ${p.nonRefundable ? 'non-refundable' : [p.freeCancelUntil && `free to cancel until ${esc(p.freeCancelUntil)}`, p.penaltyPercent != null && `${p.penaltyPercent}% charged otherwise`].filter(Boolean).join(', ')}</small></blockquote>`).join('');
  return `${docs}${rules ? `<div class="rules"><b>Rules the agent found in your terms</b>${rules}</div>` : ''}`;
}

function agentCard() {
  const t = S.trip;
  const working = Boolean(S.run && ['queued', 'running'].includes(S.run.status)) || Boolean(S.busy);
  const input = t.closed || !t.owner ? '' : `<div class="row" style="flex-wrap:nowrap"><input type="text" id="change" maxlength="800" placeholder="Tell the agent what changed..." value="${esc(S.changeDraft)}" aria-label="What changed"><button class="btn" data-act="change" ${working ? 'disabled' : ''}>Send</button></div>
    <div class="chips">${SAMPLE_CHANGES.map((c, i) => `<button class="chip" data-act="sample-change" data-i="${i}">${esc(c.length > 54 ? c.slice(0, 52) + '...' : c)}</button>`).join('')}</div>`;
  const demo = t.owner && !t.closed && t.ledger.length ? `<div class="demo"><b>Demo</b> The agent checks the real forecast on a schedule${t.nextWakeAt ? ` (next check about ${esc(new Date(t.nextWakeAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))})` : ''}. This button runs that check now with a <b>simulated</b> storm forecast, so you can watch it work.
    <div class="row"><button class="btn small ghost" data-act="demo" ${working ? 'disabled' : ''}>Fast-forward to the next check (simulated storm)</button></div></div>` : '';
  return `<section class="card agent" id="agent-card"><h2>Agent</h2>
    ${authorityLine()}
    <div id="trail" class="trailbox">${trailHtml()}</div>
    ${input}
    ${termsPanel()}
    ${demo}
    ${S.busy && S.trip ? `<div class="notice"><span class="spin"></span>${esc(S.busy)}</div>` : ''}${t.proposal ? '' : (S.notice ? `<div class="notice">${esc(S.notice)}</div>` : '')}${errorBox('agent', ...(t.proposal ? [] : ['proposal']))}
    <details class="feed-wrap"><summary>Ledger notes</summary><div class="feed" id="feed">${t.events.map((e) => `<div class="msg ${e.kind}"><b>${{ user: 'You', agent: 'Agent', system: 'Ledger', error: 'Problem' }[e.kind]}</b>${esc(e.text)}</div>`).join('')}</div></details>
  </section>`;
}

function ledgerCard() {
  const t = S.trip;
  const r = S.recon;
  const paypalCount = t.ledger.filter((f) => PAYPAL_OPS.includes(f.op)).length;
  const quotaCount = t.ledger.length - paypalCount;
  const ok = r && r.allMatch;
  const verifyLine = r
    ? (ok
      ? `<span class="ok">Ledger matches PayPal: ${r.rows.length}/${r.rows.length} PayPal records verified${r.planCheck?.applicable ? '. Every item has the money the plan says.' : '.'}</span>`
      : `<span class="bad">${r.rows.filter((x) => !x.match).length + (r.heldItemsCheck?.filter((h) => !h.valid).length ?? 0)} difference(s) from PayPal${r.planCheck?.ok === false ? `; the plan and the money disagree on ${esc(r.planCheck.mismatches.map((m) => m.title).join(', '))}` : ''}</span>`)
    : '<span style="color:var(--muted)">Every PayPal record here was copied from PayPal\'s own answer. Verify asks PayPal again.</span>';
  const rows = S.tab === 'budget' ? Math.max(3, t.plan.items.length + t.removedItems.length) : Math.max(3, S.tab === 'paypal' ? paypalCount : quotaCount);
  const holds = t.reserves.filter((x) => x.open && x.expiresAt).map((x) => `valid until ${esc(dayDate(Date.parse(x.expiresAt)))}`)[0];
  return `<section class="card"><h2>Budget &amp; ledger</h2>
    <div class="tabs" role="tablist"><button class="tab" role="tab" data-act="tab" data-tab="budget" aria-selected="${S.tab === 'budget'}">Budget by item</button><button class="tab" role="tab" data-act="tab" data-tab="paypal" aria-selected="${S.tab === 'paypal'}">PayPal activity (${paypalCount})</button><button class="tab" role="tab" data-act="tab" data-tab="quota" aria-selected="${S.tab === 'quota'}">Money set aside (${quotaCount})</button></div>
    ${phone() ? summaryList() : `<div class="grid-wrap"><div id="grid" class="ag-theme-quartz" style="height:${60 + 42 * rows}px;max-height:520px"></div></div>`}
    <div class="verify"><button class="btn ghost small" data-act="verify" ${S.busy ? 'disabled' : ''} ${t.ledger.length ? '' : 'disabled'}>Verify against PayPal</button>${verifyLine}</div>
    ${holds ? `<div class="hint">Your PayPal hold is ${holds}.</div>` : ''}
  </section>`;
}

// On a phone a table is the wrong shape: the same facts as a short list.
function summaryList() {
  const t = S.trip;
  const title = (id) => (id === '_reserve' ? 'Whole trip' : t.plan.items.find((i) => i.id === id)?.title ?? t.removedItems.find((i) => i.id === id)?.title ?? id);
  if (S.tab === 'budget') {
    return `<ul class="sumlist">${[...t.plan.items.map((i) => ({ item: i.title, total: i.amountCents, status: i.money.status, held: i.money.heldCents, paid: i.money.paidCents })), ...t.removedItems.map((r) => ({ item: `${r.title} (removed)`, total: 0, status: r.money.status, held: r.money.heldCents, paid: r.money.paidCents }))]
      .map((r) => `<li><span>${esc(r.item)}</span><b>${usd(r.total)}</b><small>${STATUS[r.status] ?? r.status}${r.held ? ` &middot; ${usd(r.held)} held` : ''}${r.paid ? ` &middot; ${usd(r.paid)} paid` : ''}</small></li>`).join('')}</ul>`;
  }
  const wanted = (f) => (S.tab === 'paypal') === PAYPAL_OPS.includes(f.op);
  return `<ul class="sumlist">${[...t.ledger].filter(wanted).reverse().map((f) => `<li><span>${esc(OPS[f.op] ?? f.op)}: ${esc(title(f.itemId))}</span><b>${usd(f.cents)}</b><small>${esc(f.status)} &middot; ${esc(clock.format(new Date(f.at)))}</small></li>`).join('') || '<li><span>Nothing yet</span></li>'}</ul>`;
}

function tripView() {
  const t = S.trip; const tot = t.totals;
  const per = Object.entries(t.perPerson).map(([n, c]) => `<span>${esc(n)} <b>${usd(c)}</b></span>`).join('');
  const showClose = t.owner && t.canClose && t.proposal?.kind !== 'close' && !t.failed;
  const closedNote = t.closed ? `<div class="notice closed">This trip is closed (${esc(dayDate(t.closedAt))}). Held items were charged and the unused hold was released in PayPal, so the plan and the money can no longer change. Start a new trip to plan something else.</div>` : '';
  const viewOnly = !t.owner ? '<div class="notice viewonly">You are looking at a shared link. Anyone can look; only the person who planned this trip can change it.</div>' : '';
  const deferred = t.holdFrom ? `<div class="notice">This trip is too far away to hold money for yet: PayPal keeps a hold for 29 days. The hold opens on ${esc(dateText(t.holdFrom))}.</div>` : '';
  const unusedHold = tot.unusedReserveCents > 0 ? ` (+${usd(tot.unusedReserveCents)} spare)` : '';
  const dates = t.plan.startDate ? ` &middot; ${esc(dateText(t.plan.startDate))}` : '';
  const agent = agentCard();
  const proposal = proposalCard();
  const itin = `<section class="card" id="itinerary-card"><h2>Itinerary</h2>${itinerary()}<h2 style="margin-top:14px">Shares</h2><div class="per">${per}</div></section>`;
  const failed = failedCard();
  return `<div class="tripbar"><div><h1>${esc(t.plan.title)}</h1><div class="sub">${esc(t.plan.destination)}${dates} &middot; ${esc(t.plan.travelers.join(', '))}</div></div><div class="row">${showClose ? `<button class="btn small" data-act="close" ${S.busy ? 'disabled' : ''}>Close trip</button>` : ''}<button class="btn ghost small" data-act="new">New trip</button></div></div>
  ${viewOnly}${closedNote}${deferred}${budgetBar()}
  <div class="stats"><div class="stat"><small>Planned</small><b>${usd(tot.plannedCents)}</b></div><div class="stat"><small>On hold${unusedHold}</small><b>${usd(tot.heldCents)}</b></div><div class="stat"><small>Paid</small><b>${usd(tot.paidCents)}</b></div><div class="stat"><small>Refunded</small><b>${usd(tot.refundedCents)}</b></div></div>
  <div class="layout">
    ${narrow() ? `<div class="col">${agent}${proposal}${failed}${itin}${ledgerCard()}</div>` : `<div class="col">${itin}${ledgerCard()}</div><div class="col">${proposal}${failed}${agent}</div>`}
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
      { field: 'status', headerName: 'Status', flex: 1.2, minWidth: 110 },
      { field: 'at', headerName: 'Time', width: 84 },
    ];
  grids.push(agGrid.createGrid(el, { rowData: rows, columnDefs, defaultColDef, suppressCellFocus: true }));
}

/* ---------- render & events ---------- */

function render() {
  const active = document.activeElement?.id;
  $app.innerHTML = S.trip ? tripView() : landing();
  if (['prompt', 'change', 'terms', 'budget'].includes(active)) { const el = document.getElementById(active); el?.focus(); el?.setSelectionRange?.(el.value.length, el.value.length); }
  if (S.trip) { mountGrid?.(); }
  if (S.trip) mountPayPal();
  tick();
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

$app.addEventListener('input', (e) => {
  if (e.target.id === 'prompt') S.draft = e.target.value;
  if (e.target.id === 'start') S.startDate = e.target.value;
  if (e.target.id === 'change') S.changeDraft = e.target.value;
  if (e.target.id === 'terms') S.termsDraft = e.target.value;
  if (e.target.id === 'budget') S.budgetDraft = e.target.value;
  if (e.target.closest?.('#mandate-form')) {
    const f = document.getElementById('mandate-form');
    S.mandateForm = { enabled: f.elements.enabled.checked, refund: f.elements.refund.value, raise: f.elements.raise.value, until: f.elements.until.value };
    document.getElementById('mandate-dirty')?.removeAttribute('hidden');
  }
});
$app.addEventListener('toggle', (e) => { if (e.target.matches?.('details.terms')) S.showTerms = e.target.open; }, true);
$app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'change') { e.preventDefault(); sendChange(); } if (e.key === 'Enter' && e.target.id === 'budget') { e.preventDefault(); saveBudget(); } });
$app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'plan') { if (S.draft.trim().length >= 8) createTrip(); else { S.error = { message: 'Describe the trip in a sentence or two first.' }; S.errorAt = 'landing'; render(); } }
  else if (a === 'sample') { S.draft = SAMPLE_TRIPS[b.dataset.i]; render(); }
  else if (a === 'sample-change') { S.changeDraft = SAMPLE_CHANGES[b.dataset.i]; render(); }
  else if (a === 'change') sendChange();
  else if (a === 'demo') demoWake();
  else if (a === 'close') closeTrip();
  else if (a === 'confirm') confirmRelease();
  else if (a === 'refresh') refreshProposal();
  else if (a === 'retry-proposal') retryProposal();
  else if (a === 'retry-error') S.error?.retryFn?.();
  else if (a === 'verify') verify();
  else if (a === 'budget-save') saveBudget();
  else if (a === 'budget-edit') { S.editBudget = true; S.budgetDraft = String(Math.round(S.trip.plan.budgetCents / 100)); render(); }
  else if (a === 'terms-save') saveTerms();
  else if (a === 'terms-sample') { S.termsDraft = sampleTerms(); S.showTerms = true; render(); }
  else if (a === 'mandate-save') saveMandate();
  else if (a === 'tab') { S.tab = b.dataset.tab; render(); }
  else if (a === 'new') { stopPolling(); S.trip = null; S.run = null; S.error = null; S.notice = null; S.recon = null; history.replaceState(null, '', '#/'); render(); }
});
window.addEventListener('resize', (() => { let w = [narrow(), phone()]; return () => { const n = [narrow(), phone()]; if (n[0] !== w[0] || n[1] !== w[1]) { w = n; ppRenderedFor = null; render(); } }; })());

// The shop name and the address bar both change the page without reloading it.
async function route() {
  const m = location.hash.match(/^#\/t\/([0-9a-f]{24})$/);
  const id = m?.[1];
  if (id && S.trip?.id === id) return;
  stopPolling();
  if (id) { try { S.run = null; setTrip(await api(`/trips/${id}`)); await resumeRun(); return; } catch { history.replaceState(null, '', '#/'); } }
  S.trip = null; S.run = null; render();
}
async function resumeRun() {
  const latest = S.trip?.runs?.at(-1);
  if (!latest) return;
  try { S.run = await api(`/trips/${S.trip.id}/runs/${latest.id}`); updateTrail(); if (['queued', 'running'].includes(S.run.status)) watchRun(latest.id); } catch { /* the trail just stays empty */ }
}
window.addEventListener('hashchange', route);

(async function boot() {
  S.judge = readJudgeCode();
  if (S.judge) document.getElementById('judge')?.removeAttribute('hidden');
  S.config = await api('/config').catch(() => ({}));
  await route();
  if (!S.trip) render();
})();
