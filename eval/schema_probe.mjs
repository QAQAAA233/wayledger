// Why the agent's edits are written as one short list per kind of change. Which shape of "edit" arguments does Gemma (thinking off) produce reliably? Same tasks, three schemas, several tries each.
// Prints, per schema and task, how many tries produced arguments that parse and validate (and how many were the right edit).
import { makeRest, Spend } from './rest.mjs';
import { callModel } from '../src/agent/model.js';
import { parseArgs, validate } from '../src/agent/schema.js';
import path from 'node:path';
const spend = new Spend(new URL('./results/spend.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 2.5);
const run = makeRest({ spend, tag: 'schema_probe' });

const TRIP = { today: '2026-05-01', trip: { title: 'Lisbon long weekend', destination: 'Lisbon', startDate: '2026-05-04', travelers: ['Ana', 'Ben', 'Cy'] }, items: [
  { id: 'i1', day: 1, title: 'Alfama apartment (3 nights)', category: 'lodging', priceUsd: 540 }, { id: 'i2', day: 2, title: 'Sunset boat tour', category: 'activity', priceUsd: 180 },
  { id: 'i3', day: 3, title: 'Sintra day trip', category: 'transport', priceUsd: 120, sharedBy: ['Ana', 'Ben'] }, { id: 'i4', day: 3, title: 'Fado dinner', category: 'food', priceUsd: 90 }] };
const PLACES = { places: [{ placeId: 'wd:Q1262183', name: 'Electricity Museum', kind: 'museum' }, { placeId: 'wd:Q1954384', name: 'National Archaeology Museum', kind: 'museum' }], source: 'Wikidata' };

const CATS = ['lodging', 'transport', 'activity', 'food'];
const BASES = ['same_as_replaced', 'user_given', 'free'];
// A: today's schema (one list of operations, each with an `op` and any of its fields)
const A = { type: 'object', properties: { operations: { type: 'array', maxItems: 8, items: { type: 'object', required: ['op'], properties: { op: { type: 'string', enum: ['remove', 'reprice', 'update_item', 'add', 'set_travelers'] }, itemId: { type: 'string' }, amount: { type: 'number' }, day: { type: 'integer' }, title: { type: 'string' }, category: { type: 'string', enum: CATS }, participants: { type: 'array', items: { type: 'string' } }, prepaid: { type: 'boolean' }, item: { type: 'object', required: ['day', 'category', 'amount', 'amountBasis'], properties: { day: { type: 'integer' }, placeId: { type: 'string' }, title: { type: 'string' }, category: { type: 'string', enum: CATS }, amount: { type: 'number' }, amountBasis: { type: 'string', enum: BASES }, participants: { type: 'array', items: { type: 'string' } }, prepaid: { type: 'boolean' } } }, travelers: { type: 'array', items: { type: 'string' } } } } } }, required: ['operations'] };
// B: one list per kind of change; each entry has only the few fields that kind needs
const B = { type: 'object', properties: {
  remove: { type: 'array', items: { type: 'string' }, description: 'ids of items to remove' },
  reprice: { type: 'array', items: { type: 'object', required: ['itemId', 'amount'], properties: { itemId: { type: 'string' }, amount: { type: 'number', description: 'new total price in USD' } } } },
  update: { type: 'array', items: { type: 'object', required: ['itemId'], properties: { itemId: { type: 'string' }, day: { type: 'integer' }, title: { type: 'string' }, participants: { type: 'array', items: { type: 'string' } } } } },
  add: { type: 'array', items: { type: 'object', required: ['day', 'category', 'amount', 'amountBasis'], properties: { placeId: { type: 'string', description: 'from search_places' }, title: { type: 'string', description: 'only a name the traveler wrote' }, day: { type: 'integer' }, category: { type: 'string', enum: CATS }, amount: { type: 'number' }, amountBasis: { type: 'string', enum: BASES }, participants: { type: 'array', items: { type: 'string' } } } } },
  setTravelers: { type: 'array', items: { type: 'string' }, description: 'the full list of travelers after the change' },
}, required: [] };
// C: scalar-only draft tools (several tools, each with flat arguments)
const C = [
  { name: 'draft_remove', description: 'Add "remove this item" to the draft edit.', parameters: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] } },
  { name: 'draft_reprice', description: 'Add "set the total price of this item" to the draft edit.', parameters: { type: 'object', properties: { itemId: { type: 'string' }, amount: { type: 'number' } }, required: ['itemId', 'amount'] } },
  { name: 'draft_move', description: 'Add "move this item to another day" to the draft edit.', parameters: { type: 'object', properties: { itemId: { type: 'string' }, day: { type: 'integer' } }, required: ['itemId', 'day'] } },
  { name: 'draft_add_place', description: 'Add a real place from search_places to the draft edit.', parameters: { type: 'object', properties: { placeId: { type: 'string' }, day: { type: 'integer' }, category: { type: 'string', enum: CATS }, amount: { type: 'number' }, amountBasis: { type: 'string', enum: BASES } }, required: ['placeId', 'day', 'category', 'amount', 'amountBasis'] } },
  { name: 'draft_add_item', description: 'Add something the traveler named themselves to the draft edit.', parameters: { type: 'object', properties: { title: { type: 'string' }, day: { type: 'integer' }, category: { type: 'string', enum: CATS }, amount: { type: 'number' }, amountBasis: { type: 'string', enum: BASES }, participants: { type: 'array', items: { type: 'string' } } }, required: ['title', 'day', 'category', 'amount', 'amountBasis'] } },
  { name: 'draft_set_travelers', description: 'Set the full list of travelers in the draft edit.', parameters: { type: 'object', properties: { travelers: { type: 'array', items: { type: 'string' } } }, required: ['travelers'] } },
];

const SYSTEM = 'You are the trip agent of a group-trip planner. Facts come only from tools or the traveler. Put the change the traveler asked for into the edit tool(s) now. New places must use a placeId from search_places. Replacement prices: same_as_replaced when you replace an item, user_given when the traveler wrote a price.';
const TASKS = [
  { id: 'reprice', user: 'The Sintra day trip operator now wants $200 for it instead of $120.', ok: { reprice: [['i3', 200]] } },
  { id: 'swap', user: 'A storm is coming on day 2. Replace the boat tour with the Electricity Museum.', ok: { remove: ['i2'], addPlace: ['wd:Q1262183'] } },
  { id: 'travelers', user: "Cy can't come anymore.", ok: { travelers: ['Ana', 'Ben'] } },
  { id: 'move', user: 'Please move the sunset boat tour to day 4.', ok: { move: [['i2', 4]] } },
  { id: 'two', user: 'Drop the Sintra day trip and add a museum visit on day 3 instead.', ok: { remove: ['i3'], addPlace: ['wd:Q1262183', 'wd:Q1954384'] } },
];
const conv = (user, tools) => [
  { role: 'system', content: SYSTEM }, { role: 'user', content: `The traveler wrote: """${user}"""` },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_trip', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'search_places', arguments: '{"kind":"museum"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(TRIP) }, { role: 'tool', tool_call_id: 'c2', content: JSON.stringify(PLACES) },
];
const N = Number(process.argv[2] ?? 4);
const results = {};
for (const [label, tools] of [['A nested ops', [{ type: 'function', function: { name: 'simulate_edit', description: 'Try an edit.', parameters: A } }]], ['B per-kind', [{ type: 'function', function: { name: 'simulate_edit', description: 'Try an edit. Fill only the lists that apply.', parameters: B } }]], ['C scalar draft', C.map((t) => ({ type: 'function', function: t }))]]) {
  for (const task of TASKS) {
    let parsedOk = 0; let valid = 0; const samples = [];
    await Promise.all(Array.from({ length: N }, async () => {
      try {
        const res = await callModel({ run, model: 'gemma', messages: conv(task.user, tools), tools, maxTokens: 800, timeoutMs: 60_000 });
        if (!res.calls.length) { samples.push('NO CALL'); return; }
        const allValid = res.calls.every((c) => { const p = parseArgs(c.raw); if (!p.ok) return false; const t = tools.find((x) => x.function.name === c.name); return t && validate(t.function.parameters, p.value).length === 0; });
        const allParsed = res.calls.every((c) => parseArgs(c.raw).ok);
        if (allParsed) parsedOk++; if (allValid) valid++;
        samples.push(res.calls.map((c) => `${c.name}(${String(c.raw).slice(0, 140)})`).join(' + '));
      } catch (e) { samples.push(`ERR ${String(e.message).slice(0, 80)}`); }
    }));
    results[`${label} / ${task.id}`] = { parsed: `${parsedOk}/${N}`, valid: `${valid}/${N}`, sample: samples[0] };
    console.log(`${label.padEnd(16)} ${task.id.padEnd(10)} parsed ${parsedOk}/${N} valid ${valid}/${N}  e.g. ${samples[0]?.slice(0, 200)}`);
  }
}
spend.save();
console.log('spent so far $' + spend.usd.toFixed(3));
