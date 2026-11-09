import { SAMPLE_PLAN } from './helpers.js';

// One scenario used by the agent tests and the browser tests: a storm on the day of a prepaid boat tour. The scripted
// model reads the trip, the forecast and the pasted terms, quotes the sentence it relied on, finds a real museum,
// tries the swap and the plain cancellation, and submits the swap with its basis. Every argument after the first step is
// read from what the previous tools returned.
export const TERMS = 'Sunset boat tour: free cancellation until 6 May 12:00, after that non-refundable.\nSintra day trip: non-refundable from the moment of booking.';
export const BOAT_QUOTE = 'Sunset boat tour: free cancellation until 6 May 12:00';
export const SINTRA_QUOTE = 'Sintra day trip: non-refundable from the moment of booking.';

// The boat tour must be paid in advance, so it is charged at booking and a swap means a real PayPal refund.
export const PLAN = structuredClone(SAMPLE_PLAN);
PLAN.items[1].prepaid = true;

export const PLACES = { museum: [{ placeId: 'wd:Q1262183', name: 'Electricity Museum' }, { placeId: 'wd:Q1954384', name: 'National Archaeology Museum' }] };
export const STORM = { '2026-05-05': { summary: 'thunderstorms', weatherCode: 95, rainChancePct: 90, windKph: 60, tempMaxC: 16, tempMinC: 11 } };

// The two ways an edit can be backed: the traveler's own words, or a limit they signed that the forecast crossed.
export const REQUEST_QUOTE = 'Swap it for something indoors';
export const BY_TRAVELER = { source: 'traveler', quote: REQUEST_QUOTE };
export const BY_THRESHOLD = { source: 'threshold', metric: 'rainPct', day: 2 };

export const T = (name, args = {}) => ({ name, args });
export const allResults = (messages) => messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
export const facts = (messages) => allResults(messages).find((r) => r.items);
export const found = (messages) => allResults(messages).find((r) => r.places)?.places;
export const boatOf = (messages) => facts(messages).items.find((i) => /boat/i.test(i.title));

// The swap, and the plain cancellation it is weighed against.
export const swapEdit = (messages) => { const boat = boatOf(messages); return { remove: [boat.id], add: [{ placeId: found(messages)[0].placeId, day: boat.day, category: 'activity', amountBasis: 'same_as_replaced', replaces: boat.id }] }; };
export const cancelEdit = (messages) => ({ remove: [boatOf(messages).id] });

// get_trip -> get_forecast -> read_documents -> record_policy -> search_places -> simulate_edit (swap) -> simulate_edit (cancel) -> submit_edit (swap).
export function stormSteps({ quote = BOAT_QUOTE, until = '2026-05-06T12:00', authority = BY_TRAVELER } = {}) {
  const summary = { summary: 'I swapped the boat tour for a museum visit because of the storm.', reason: 'The boat tour is free to cancel until the cut-off and the museum is indoors.' };
  return [
    { calls: [T('get_trip')] },
    ({ messages }) => ({ calls: [T('get_forecast', { day: boatOf(messages).day })] }),
    { calls: [T('read_documents')] },
    ({ messages }) => ({ calls: [T('record_policy', { docId: allResults(messages).find((r) => Array.isArray(r.documents)).documents[0].docId, itemId: boatOf(messages).id, quote, freeCancelUntil: until })] }),
    { calls: [T('search_places', { kind: 'museum' })] },
    ({ messages }) => ({ calls: [T('simulate_edit', swapEdit(messages))] }),
    ({ messages }) => ({ calls: [T('simulate_edit', cancelEdit(messages))] }),
    ({ messages }) => ({ calls: [T('submit_edit', { ...swapEdit(messages), ...summary, authority })] }),
  ];
}

// get_trip -> simulate_edit -> simulate_edit -> submit_edit: drop one item, weighed against dropping another. Used where only the way the answer reaches the screen matters.
export function dropSteps(re = /apartment/i, other = /Sintra/i, authority = { source: 'traveler', quote: 'drop the apartment' }) {
  const edit = (messages, pattern = re) => ({ remove: [facts(messages).items.find((i) => pattern.test(i.title)).id] });
  return [
    { calls: [T('get_trip')] },
    ({ messages }) => ({ calls: [T('simulate_edit', edit(messages))] }),
    ({ messages }) => ({ calls: [T('simulate_edit', edit(messages, other))] }),
    ({ messages }) => ({ calls: [T('submit_edit', { ...edit(messages), summary: 'Dropped it.', reason: 'You found a free place.', authority })] }),
  ];
}
