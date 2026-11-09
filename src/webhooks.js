// PayPal tells us what happened to a payment (an authorization voided from outside, a refund, a charge) by posting an
// event to us. We believe an event only after PayPal itself confirms its signature, and only once, and only when it is
// recent. A verified event is data for the trip's record and for the agent; it never moves money.
const MAX_AGE_MS = 15 * 60_000;
const TRIP_ID = /^[0-9a-f]{24}$/;

export async function verifyWebhook({ paypal, webhookId, headers, rawBody, now = Date.now() }) {
  if (!webhookId) return false;
  const h = (n) => headers.get(n);
  const parts = { auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'), transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time') };
  if (Object.values(parts).some((v) => !v)) return false;
  const age = Math.abs(now - Date.parse(parts.transmission_time));
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return false;
  let event;
  try { event = JSON.parse(rawBody); } catch { return false; }
  try {
    return await paypal.verifyWebhook({ ...parts, webhook_id: webhookId, webhook_event: event });
  } catch {
    return false;
  }
}

// Which trip is this about? Charges and authorizations carry the trip id we put on the order; a refund points up to its
// charge, so we ask PayPal for that.
export async function tripIdOf(event, paypal) {
  const r = event?.resource ?? {};
  if (TRIP_ID.test(r.custom_id ?? '')) return r.custom_id;
  const up = r.links?.find((l) => l.rel === 'up');
  if (!up) return null;
  try {
    const parent = await paypal.getByLink(up.href);
    return TRIP_ID.test(parent.custom_id ?? '') ? parent.custom_id : null;
  } catch {
    return null;
  }
}
