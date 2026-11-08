import { toCents, fromCents } from './domain/money.js';

// Thin PayPal REST client. Every method returns ledger facts built from what PayPal
// answered (re-read from PayPal after each write), never from what we asked for.
export class PayPalError extends Error {
  constructor(message, { status, name, debugId, details } = {}) {
    super(message);
    this.status = status; this.paypalName = name; this.debugId = debugId; this.details = details;
  }
}

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
      throw new PayPalError(`PayPal: ${json.message ?? res.statusText}${issue ? ` (${issue})` : ''}`, { status: res.status, name: json.name, debugId: res.headers.get('paypal-debug-id'), details: json.details });
    }
    return json;
  }

  const amount = (cents) => ({ currency_code: 'USD', value: fromCents(cents) });
  const fact = (op, itemId, o, extra = {}) => ({ op, itemId, id: o.id, status: o.status, cents: toCents(o.amount.value), at: Date.now(), ...extra });

  return {
    async createHoldOrder(holds, { tripId, requestId }) {
      const order = await call('POST', '/v2/checkout/orders', {
        intent: 'AUTHORIZE',
        purchase_units: holds.map((h) => ({ reference_id: h.itemId, description: h.title.slice(0, 120), custom_id: tripId, amount: amount(h.cents) })),
      }, requestId);
      return { orderId: order.id, status: order.status };
    },

    // The buyer has approved in the PayPal popup; this places the holds.
    async authorizeOrder(orderId, { requestId, proposalId }) {
      const order = await call('POST', `/v2/checkout/orders/${orderId}/authorize`, undefined, requestId);
      const facts = [];
      for (const pu of order.purchase_units ?? []) {
        for (const a of pu.payments?.authorizations ?? []) {
          const full = await call('GET', `/v2/payments/authorizations/${a.id}`);
          facts.push(fact('authorize', pu.reference_id, full, { orderId, proposalId }));
        }
      }
      if (facts.length === 0) throw new PayPalError('PayPal did not return any authorization. The buyer may not have approved the order.', { details: order });
      return facts;
    },

    async capture(authId, itemId, cents, { requestId, proposalId }) {
      const c = await call('POST', `/v2/payments/authorizations/${authId}/capture`, { amount: amount(cents), final_capture: true }, requestId);
      const full = await call('GET', `/v2/payments/captures/${c.id}`);
      return fact('capture', itemId, full, { parentId: authId, proposalId });
    },

    async voidAuthorization(authId, itemId, { requestId, proposalId }) {
      await call('POST', `/v2/payments/authorizations/${authId}/void`, undefined, requestId);
      const full = await call('GET', `/v2/payments/authorizations/${authId}`);
      return fact('void', itemId, full, { proposalId });
    },

    async refund(captureId, itemId, cents, { requestId, proposalId, note }) {
      const r = await call('POST', `/v2/payments/captures/${captureId}/refund`, { amount: amount(cents), note_to_payer: (note ?? 'Trip plan changed').slice(0, 255) }, requestId);
      const full = await call('GET', `/v2/payments/refunds/${r.id}`);
      return fact('refund', itemId, full, { parentId: captureId, proposalId });
    },

    // Used by reconcile: what does PayPal say right now about every id in the ledger?
    async remoteState(ledger) {
      const out = {};
      for (const f of ledger) {
        if (f.op === 'void' || out[f.id]) continue;
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
