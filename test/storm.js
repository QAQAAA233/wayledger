import { SAMPLE_PLAN } from './helpers.js';

// One scenario used by the agent tests and the browser tests: a storm on the day of a prepaid boat tour. The scripted
// model reads the trip, the forecast and the pasted terms, quotes the sentence it relied on, finds a real museum,
// tries the swap and submits it. Every argument after the first step is read from what the previous tools returned.
export const TERMS = 'Sunset boat tour: free cancellation until 6 May 12:00, after that non-refundable.\nSintra day trip: non-refundable from the moment of booking.';
export const BOAT_QUOTE = 'Sunset boat tour: free cancellation until 6 May 12:00';
export const SINTRA_QUOTE = 'Sintra day trip: non-refundable from the moment of booking.';

// The boat tour must be paid in advance, so it is charged at booking and a swap means a real PayPal refund.
export const PLAN = structuredClone(SAMPLE_PLAN);
PLAN.items[1].prepaid = true;

export const PLACES = { museum: [{ placeId: 'wd:Q1262183', name: 'Electricity Museum' }, { placeId: 'wd:Q1954384', name: 'National Archaeology Museum' }] };
export const STORM = { '2026-05-05': { summary: 'thunderstorms', weatherCode: 95, rainChancePct: 90, windKph: 60, tempMaxC: 16, tempMinC: 11 } };

export const T = (name, args = {}) => ({ name, args });
export const allResults = (messages) => messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
export const facts = (messages) => allResults(messages).find((r) => r.items);
export const found = (messages) => allResults(messages).find((r) => r.places)?.places;
export const boatOf = (messages) => facts(messages).items.find((i) => /boat/i.test(i.title));

// get_trip -> get_forecast -> read_documents -> record_policy -> search_places -> simulate_edit -> submit_edit.
export function stormSteps({ sameOps = true, quote = BOAT_QUOTE, until = '2026-05-06T12:00' } = {}) {
  const edit = (messages) => { const boat = boatOf(messages); return { remove: [boat.id], add: [{ placeId: found(messages)[0].placeId, day: boat.day, category: 'activity', amountBasis: 'same_as_replaced', replaces: boat.id }] }; };
  const summary = { summary: 'I swapped the boat tour for a museum visit because of the storm.', reason: 'The boat tour is free to cancel until the cut-off and the museum is indoors.' };
  return [
    { calls: [T('get_trip')] },
    ({ messages }) => ({ calls: [T('get_forecast', { day: boatOf(messages).day })] }),
    { calls: [T('read_documents')] },
    ({ messages }) => ({ calls: [T('record_policy', { docId: allResults(messages).find((r) => Array.isArray(r.documents)).documents[0].docId, itemId: boatOf(messages).id, quote, freeCancelUntil: until })] }),
    { calls: [T('search_places', { kind: 'museum' })] },
    ({ messages }) => ({ calls: [T('simulate_edit', edit(messages))] }),
    ({ messages }) => {
      const simulated = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.function.name === 'simulate_edit'));
      return { calls: [T('submit_edit', { ...JSON.parse(simulated.tool_calls.find((c) => c.function.name === 'simulate_edit').function.arguments), ...summary })] };
    },
  ].slice(0, sameOps ? 7 : 6);
}

// get_trip -> simulate_edit -> submit_edit: drop one item. Used where only the way the answer reaches the screen matters.
export function dropSteps(re = /apartment/i) {
  const edit = (messages) => ({ remove: [facts(messages).items.find((i) => re.test(i.title)).id] });
  return [
    { calls: [T('get_trip')] },
    ({ messages }) => ({ calls: [T('simulate_edit', edit(messages))] }),
    ({ messages }) => ({ calls: [T('submit_edit', { ...edit(messages), summary: 'Dropped it.', reason: 'You found a free place.' })] }),
  ];
}
