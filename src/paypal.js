import { toCents, fromCents } from './domain/money.js';

// Thin PayPal REST client. Every method returns ledger facts built from what PayPal
// answered (re-read from PayPal after each write), never from what we asked for.
export class PayPalError extends Error {
  constructor(message, { status, name, debugId, details, issue } = {}) {
    super(message);
    this.status = status; this.paypalName = name; this.debugId = debugId; this.details = details; this.issue = issue;
  }
}

// PayPal's own wording for the failures a traveler can fix, in words a traveler can use. Anything else keeps PayPal's text.
const ISSUE_WORDS = {
  INSTRUMENT_DECLINED: 'PayPal could not use that payment method. Choose another one and try again.',
  PAYER_ACTION_REQUIRED: 'PayPal needs you to finish approving before the hold can be placed.',
  ORDER_NOT_APPROVED: 'The order was not approved in PayPal yet.',
};

export function createPayPal({ clientId, secret, base = 'https://api-m.sandbox.paypal.com', fetchImpl = fetch }) {
  let token = null;

  async function accessToken() {
    if (token && token.exp > Date.now() + 60_000) return token.value;
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError('PayPal rejected the sandbox credentials.', { status: res.status, name: body.error });
    token = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
    return token.value;
  }

  async function call(method, path, body, requestId) {
    const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const issue = json.details?.[0]?.issue;
      throw new PayPalError(ISSUE_WORDS[issue] ?? `PayPal: ${json.message ?? res.statusText}${issue ? ` (${issue})` : ''}`, { status: res.status, name: json.name, debugId: res.headers.get('paypal-debug-id'), details: json.details, issue });
    }
    return json;
  }

  const amount = (cents) => ({ currency_code: 'USD', value: fromCents(cents) });
  const fact = (op, itemId, o, extra = {}) => ({ op, itemId, id: o.id, status: o.status, cents: toCents(o.amount.value), at: Date.now(), ...extra });

  // What the buyer sees in PayPal: our name, no shipping address (a trip is not a parcel), one clear button.
  // PayPal-wallet orders use the current `payment_source` field; the card button is a different funding
  // source and keeps the same settings through `application_context`.
  const experience = { brand_name: 'Wayledger', shipping_preference: 'NO_SHIPPING' };

  return {
    async createHoldOrder(holds, { tripId, requestId, fundingSource = 'paypal' }) {
      const totalCents = holds.reduce((a, h) => a + h.cents, 0);
      const order = await call('POST', '/v2/checkout/orders', {
        intent: 'AUTHORIZE',
        ...(fundingSource === 'card'
          ? { application_context: experience }
          : { payment_source: { paypal: { experience_context: { ...experience, user_action: 'PAY_NOW' } } } }),
        purchase_units: [{
          reference_id: holds.length === 1 ? holds[0].itemId : String(tripId ?? 'trip').slice(0, 64),
          description: holds.map((h) => h.title).join(', ').slice(0, 120),
          custom_id: String(tripId ?? '').slice(0, 120),
          amount: { ...amount(totalCents), breakdown: { item_total: amount(totalCents) } },
          items: holds.map((h) => ({
            name: h.title.slice(0, 120),
            sku: h.itemId,
            quantity: '1',
            unit_amount: amount(h.cents),
          })),
        }],
      }, requestId);
      return { orderId: order.id, status: order.status };
    },

    // The buyer has approved in the PayPal popup; this places the Trip Reserve authorization.
    async authorizeOrder(orderId, { requestId, proposalId }) {
      const order = await call('POST', `/v2/checkout/orders/${orderId}/authorize`, undefined, requestId);
      let fullOrder = null;
      const pu = order.purchase_units?.[0];
      const auth = pu?.payments?.authorizations?.[0];
      if (!auth) throw new PayPalError('PayPal did not return any authorization. The buyer may not have approved the order.', { details: order });

      let items = pu.items;
      if (!items) {
        fullOrder = await call('GET', `/v2/checkout/orders/${orderId}`);
        items = fullOrder.purchase_units?.[0]?.items;
      }
      const full = await call('GET', `/v2/payments/authorizations/${auth.id}`);
      const authFact = fact('authorize', '_reserve', full, { orderId, proposalId, expiresAt: full.expiration_time ?? null });
      const itemBreakdown = items?.map((it) => ({ itemId: it.sku, cents: toCents(it.unit_amount.value) })) ?? null;
      return { authFact, itemBreakdown };
    },

    async capture(authId, itemId, cents, { requestId, proposalId, finalCapture = false }) {
      const c = await call('POST', `/v2/payments/authorizations/${authId}/capture`, { amount: amount(cents), final_capture: Boolean(finalCapture) }, requestId);
      const full = await call('GET', `/v2/payments/captures/${c.id}`);
      return fact('capture', itemId, full, { parentId: authId, proposalId, final: Boolean(full.final_capture) });
    },

    async voidAuthorization(authId, itemId, { requestId, proposalId, cents }) {
      // already voided (by someone in PayPal, or because it ran out) is the state we wanted: PayPal's own answer follows
      try { await call('POST', `/v2/payments/authorizations/${authId}/void`, undefined, requestId); } catch (e) { if (e.issue !== 'PREVIOUSLY_VOIDED') throw e; }
      const full = await call('GET', `/v2/payments/authorizations/${authId}`);
      return { ...fact('void', itemId, full, { proposalId }), cents: cents ?? toCents(full.amount.value) };
    },

    async refund(captureId, itemId, cents, { requestId, proposalId, note }) {
      const r = await call('POST', `/v2/payments/captures/${captureId}/refund`, { amount: amount(cents), note_to_payer: (note ?? 'Trip plan changed').slice(0, 255) }, requestId);
      const full = await call('GET', `/v2/payments/refunds/${r.id}`);
      return fact('refund', itemId, full, { parentId: captureId, proposalId });
    },

    // Webhooks: PayPal checks its own signature for us. Anything but SUCCESS is a forgery or a replay.
    async verifyWebhook(body) {
      const r = await call('POST', '/v1/notifications/verify-webhook-signature', body);
      return r.verification_status === 'SUCCESS';
    },

    // Follows a link PayPal put in an event (for example a refund's link up to its charge). Only PayPal's own payments API.
    async getByLink(href) {
      const url = new URL(href);
      // Validate the parsed path: URL normalization can move a raw /v2/payments/../ link outside payments.
      const origins = [new URL(base).origin, new URL(base.replace('api-m.', 'api.')).origin];
      if (!origins.includes(url.origin) || url.username || url.password || !url.pathname.startsWith('/v2/payments/')) throw new PayPalError('That link is not a PayPal payments link.');
      return call('GET', url.pathname);
    },

    // Used by reconcile: what does PayPal say right now about every PayPal id in the ledger?
    async remoteState(ledger) {
      const out = {};
      for (const f of ledger) {
        if (!['authorize', 'capture', 'refund'].includes(f.op) || out[f.id]) continue;
        const path = f.op === 'authorize' ? `/v2/payments/authorizations/${f.id}` : f.op === 'capture' ? `/v2/payments/captures/${f.id}` : `/v2/payments/refunds/${f.id}`;
        try {
          const o = await call('GET', path);
          out[f.id] = { status: o.status, cents: toCents(o.amount.value) };
        } catch { out[f.id] = null; }
      }
      return out;
    },
  };
}
