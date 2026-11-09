// Where facts come from. Each source says what it is, and when it cannot answer it says so plainly instead of
// guessing: a missing forecast or place list is reported as missing, never filled in.
const UA = 'Wayledger/0.2 (PayPal AI Hackathon demo; open source)';
const WMO = {
  0: 'clear sky', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'heavy rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with heavy hail',
};
export const weatherText = (code) => WMO[code] ?? `weather code ${code}`;

// Wikidata classes for the kinds the agent can search for, and whether a visit takes place indoors.
const KINDS = {
  museum: ['Q33506', true], aquarium: ['Q2281788', true], zoo: ['Q43501', false], art_gallery: ['Q1007870', true], theatre: ['Q24354', true],
  cinema: ['Q41253', true], castle: ['Q23413', null], park: ['Q22698', false], botanical_garden: ['Q167346', false], shopping_centre: ['Q31855', true],
};

const HOUR = 3_600_000;
const jsonFetch = async (fetchImpl, url, init = {}, timeoutMs = 9000) => {
  const res = await fetchImpl(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
};

export function createSources({ fetchImpl = fetch, cache = null, toolkit = null, now = () => Date.now() } = {}) {
  const cached = async (key, ttlMs, fn) => {
    const hit = await cache?.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await fn();
    await cache?.put(key, { at: now(), value });
    return value;
  };

  const geocode = (destination) => cached(`geo:${destination.toLowerCase()}`, 30 * 24 * HOUR, async () => {
    const j = await jsonFetch(fetchImpl, `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=1&language=en&format=json`);
    const r = j.results?.[0];
    if (!r) throw new Error(`no place called "${destination}" was found`);
    return { name: r.name, country: r.country, lat: r.latitude, lon: r.longitude, tz: r.timezone };
  });

  return {
    geocode,

    async forecast({ destination, date }) {
      try {
        const g = await geocode(destination);
        const day = await cached(`fc:${g.lat},${g.lon}:${date}`, 3 * HOUR, async () => {
          const j = await jsonFetch(fetchImpl, `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&daily=weather_code,precipitation_probability_max,wind_speed_10m_max,temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${date}&end_date=${date}`);
          if (!j.daily?.time?.length) throw new Error(j.reason ?? 'the service has no forecast for that day yet (it covers about 16 days ahead)');
          return { code: j.daily.weather_code[0], rain: j.daily.precipitation_probability_max[0], wind: j.daily.wind_speed_10m_max[0], max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0] };
        });
        return { available: true, date, summary: weatherText(day.code), weatherCode: day.code, rainChancePct: day.rain ?? 0, windKph: Math.round(day.wind ?? 0), tempMaxC: day.max, tempMinC: day.min, source: 'Open-Meteo' };
      } catch (e) {
        return { available: false, date, reason: `No forecast is available: ${String(e.message).slice(0, 120)}.`, source: 'Open-Meteo' };
      }
    },

    async places({ destination, kind }) {
      const cls = KINDS[kind];
      if (!cls) return { available: false, reason: `Unknown kind ${kind}.` };
      try {
        const g = await geocode(destination);
        const rows = await cached(`pl:${g.lat},${g.lon}:${kind}`, 24 * HOUR, async () => {
          const q = `SELECT ?item ?itemLabel ?itemDescription WHERE { SERVICE wikibase:around { ?item wdt:P625 ?coord . bd:serviceParam wikibase:center "Point(${g.lon} ${g.lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "8" . } ?item wdt:P31/wdt:P279* wd:${cls[0]} . SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 25`;
          const j = await jsonFetch(fetchImpl, `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { accept: 'application/sparql-results+json' } }, 12000);
          return j.results.bindings.map((b) => ({ id: b.item.value.split('/').pop(), name: b.itemLabel.value, description: b.itemDescription?.value ?? null }));
        });
        const seen = new Set();
        const places = rows.filter((r) => !/^Q\d+$/.test(r.name) && !seen.has(r.name) && seen.add(r.name)).slice(0, 12)
          .map((r) => ({ placeId: `wd:${r.id}`, name: r.name, kind, indoor: cls[1], description: r.description }));
        if (!places.length) return { available: true, places: [], note: `No ${kind.replace('_', ' ')} places were found near ${g.name}.`, source: 'Wikidata' };
        return { available: true, places, source: 'Wikidata', note: 'Real places. Ticket prices and opening hours are not included.' };
      } catch (e) {
        return { available: false, reason: `The places lookup did not answer (${String(e.message).slice(0, 80)}). No places can be added right now.`, source: 'Wikidata' };
      }
    },

    // Asks PayPal through its Agent Toolkit. Only whitelisted facts leave this function: no buyer name, email or address.
    async paypalStatus(s) {
      if (!toolkit) return { available: false, reason: 'PayPal status is not available here.' };
      const orderIds = [...new Set(s.ledger.filter((f) => f.op === 'authorize' && f.orderId).map((f) => f.orderId))];
      const refundIds = [...new Set(s.ledger.filter((f) => f.op === 'refund').map((f) => f.id))].slice(0, 6);
      if (!orderIds.length) return { available: true, holds: [], chargedUsd: 0, refundedUsd: 0, openDisputes: 0, note: 'Nothing has been placed with PayPal yet.', source: 'PayPal Agent Toolkit' };
      try {
        const [orders, refunds, disputes] = await Promise.all([
          Promise.all(orderIds.map((id) => toolkit.get_order({ id }))),
          Promise.all(refundIds.map((id) => toolkit.get_refund({ refund_id: id }))),
          toolkit.list_disputes({}),
        ]);
        return summarizePayPal(s, orders, refunds, disputes);
      } catch (e) {
        return { available: false, reason: `PayPal did not answer (${String(e.message).slice(0, 100)}).`, source: 'PayPal Agent Toolkit' };
      }
    },
  };
}

const usd = (v) => Number(v?.value ?? 0);
const scrubText = (t) => String(t ?? '').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email removed]');

export function summarizePayPal(s, orders, refunds, disputes) {
  const holds = []; let charged = 0; let refunded = 0;
  for (const o of orders) {
    const pay = o.purchase_units?.[0]?.payments ?? {};
    for (const a of pay.authorizations ?? []) holds.push({ status: a.status, amountUsd: usd(a.amount), validUntil: a.expiration_time ? String(a.expiration_time).slice(0, 10) : null });
    for (const c of pay.captures ?? []) if (c.status === 'COMPLETED' || c.status === 'PARTIALLY_REFUNDED') charged += usd(c.amount);
    for (const r of pay.refunds ?? []) refunded += usd(r.amount);
  }
  const refundFacts = refunds.map((r) => ({ status: r.status, amountUsd: usd(r.amount) }));
  const ledgerCharged = s.ledger.filter((f) => f.op === 'capture').reduce((n, f) => n + f.cents, 0) / 100;
  const ledgerRefunded = s.ledger.filter((f) => f.op === 'refund').reduce((n, f) => n + f.cents, 0) / 100;
  return {
    available: true,
    holds,
    chargedUsd: Math.round(charged * 100) / 100,
    refundedUsd: Math.round(Math.max(refunded, refundFacts.reduce((n, r) => n + r.amountUsd, 0)) * 100) / 100,
    refunds: refundFacts,
    openDisputes: (disputes?.items ?? []).filter((d) => d.status !== 'RESOLVED').length,
    ledgerChargedUsd: ledgerCharged,
    ledgerRefundedUsd: ledgerRefunded,
    source: 'PayPal sandbox, read through the PayPal Agent Toolkit (get_order, get_refund, list_disputes)',
    note: scrubText('Buyer details are never passed on.'),
  };
}
