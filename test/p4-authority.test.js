import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptedModel, fakeSources, untilRunDone } from './helpers.js';
import { world, startRun, wakeRun, moneyCalls, titles, TERMS_OK } from './agent-world.js';
import { T, allResults, facts, boatOf, swapEdit, cancelEdit, stormSteps, BOAT_QUOTE, BY_THRESHOLD, REQUEST_QUOTE } from './storm.js';
import { normalizeTerms, describeTerms, DEFAULT_WEATHER } from '../src/domain/mandate.js';

// Item 4: every move of money has a basis. Either the traveler's own words (quoted letter for letter from the message of
// this run), or a weather limit the traveler signed that a forecast fetched in this run crossed. Without one the agent
// can only answer: nothing is proposed and no money moves.
const LIGHT_RAIN = { '2026-05-05': { summary: 'light rain', weatherCode: 61, rainChancePct: 35, windKph: 20, tempMaxC: 18, tempMinC: 12 } };
const lightRain = () => fakeSources({ forecasts: LIGHT_RAIN, places: { museum: [{ placeId: 'wd:Q1262183', name: 'Electricity Museum' }] } });

// the steps up to and including the second option, then whatever the test submits
const upToCompare = (extra = []) => [
  { calls: [T('get_trip')] },
  ({ messages }) => ({ calls: [T('get_forecast', { day: boatOf(messages).day })] }),
  { calls: [T('read_documents')] },
  ({ messages }) => ({ calls: [T('record_policy', { docId: 'd1', itemId: boatOf(messages).id, quote: BOAT_QUOTE, freeCancelUntil: '2026-05-06T12:00' })] }),
  { calls: [T('search_places', { kind: 'museum' })] },
  ({ messages }) => ({ calls: [T('simulate_edit', swapEdit(messages))] }),
  ({ messages }) => ({ calls: [T('simulate_edit', cancelEdit(messages))] }),
  ...extra,
];
const submitWith = (authority) => ({ messages }) => ({ calls: [T('submit_edit', { ...swapEdit(messages), summary: 'Swapped it.', reason: 'Indoors.', ...(authority ? { authority } : {}) })] });
const plan = (wd) => wd.state().plan;
const hasBoat = (wd) => plan(wd).items.some((i) => /boat/i.test(i.title));

test('submit_edit without an authority is refused by its arguments, nothing is proposed and no money moves', async () => {
  const m = scriptedModel(upToCompare([submitWith(null)]));
  const wd = await world({ run: m, terms: TERMS_OK });
  const before = moneyCalls(wd).length;
  const run = await startRun(wd);
  assert.equal(run.final.kind, 'stopped');
  assert.match(allResults(m.log.at(-1).messages).at(-1).error, /authority is required/);
  assert.equal(moneyCalls(wd).length, before);
  assert.equal(hasBoat(wd), true);
  assert.equal(Object.keys(wd.state().proposals).filter((id) => wd.state().proposals[id].kind === 'change').length, 0, 'not even a proposal');
});

test('a traveler quote must be in the traveler\'s own message of this run: not made up, not from the pasted terms', async () => {
  const bad = async (quote) => {
    const m = scriptedModel(upToCompare([submitWith({ source: 'traveler', quote }), { calls: [T('no_change', { note: 'stopped' })] }]));
    const wd = await world({ run: m, terms: TERMS_OK });
    const before = moneyCalls(wd).length;
    await startRun(wd);
    const refused = allResults(m.log.at(-1).messages).find((r) => r.accepted === false);
    assert.match(refused.error, /traveler's own words/);
    assert.equal(moneyCalls(wd).length, before);
    assert.equal(hasBoat(wd), true);
  };
  await bad('The traveler wants the boat tour swapped for a museum.');
  await bad(BOAT_QUOTE); // a sentence of the operator's terms is not the traveler's word

  const m = scriptedModel(upToCompare([submitWith({ source: 'traveler', quote: REQUEST_QUOTE })]));
  const wd = await world({ run: m, terms: TERMS_OK });
  const run = await startRun(wd);
  assert.deepEqual([run.final.kind, run.final.outcome], ['submitted', 'executed']);
  const p = wd.state().proposals[run.final.proposalId];
  assert.deepEqual(p.authority, { source: 'traveler', quote: REQUEST_QUOTE });
  const decision = run.events.find((e) => e.kind === 'decision');
  assert.deepEqual(decision.authority, p.authority, 'the basis is on the screen next to the choice');
});

test('a wake-up has no traveler words: a quote cannot back it, a signed weather limit that the forecast crossed can', async () => {
  const quoted = scriptedModel(upToCompare([submitWith({ source: 'traveler', quote: REQUEST_QUOTE }), { calls: [T('no_change', { note: 'stopped' })] }]));
  const wd1 = await world({ run: quoted, terms: TERMS_OK });
  const before = moneyCalls(wd1).length;
  await wakeRun(wd1);
  assert.match(allResults(quoted.log.at(-1).messages).find((r) => r.accepted === false).error, /traveler's own words/);
  assert.equal(moneyCalls(wd1).length, before);

  const m = scriptedModel(upToCompare([submitWith(BY_THRESHOLD)]));
  const wd = await world({ run: m, terms: TERMS_OK });
  const run = await wakeRun(wd);
  assert.deepEqual([run.final.kind, run.final.outcome], ['submitted', 'executed']);
  const p = wd.state().proposals[run.final.proposalId];
  assert.deepEqual(p.authority, { source: 'threshold', metric: 'rainPct', day: 2, date: '2026-05-05', limit: 70, observed: 90, simulated: false });
  assert.match(run.events.find((e) => e.kind === 'decision').basis, /90% chance of rain.*70% limit/);
  assert.equal(facts(m.log.at(-1).messages).limits.weather.rainPct, 70, 'the model is told the limits it acts on');
});

test('a little rain is under the signed limit, so the agent cannot act on it and can only leave things as they are (S13)', async () => {
  const m = scriptedModel(upToCompare([submitWith(BY_THRESHOLD), { calls: [T('no_change', { note: '35% rain is under the limit.' })] }]));
  const wd = await world({ run: m, sources: lightRain(), terms: TERMS_OK });
  const before = moneyCalls(wd).length;
  const run = await wakeRun(wd, 'Forecast now: 2026-05-05: light rain, 35% chance of rain, wind up to 20 km/h.');
  const refused = allResults(m.log.at(-1).messages).find((r) => r.accepted === false);
  assert.match(refused.error, /35%.*below the 70% limit/);
  assert.equal(run.final.kind, 'no_change');
  assert.equal(moneyCalls(wd).length, before);
  assert.equal(hasBoat(wd), true);
});

test('a threshold counts only for a forecast the agent fetched in this run, for the day it names', async () => {
  // it never looked at a forecast
  const m = scriptedModel([
    { calls: [T('get_trip')] },
    { calls: [T('search_places', { kind: 'museum' })] },
    ({ messages }) => ({ calls: [T('simulate_edit', swapEdit(messages))] }),
    ({ messages }) => ({ calls: [T('simulate_edit', cancelEdit(messages))] }),
    submitWith(BY_THRESHOLD),
    { calls: [T('no_change', { note: 'x' })] },
  ]);
  const wd = await world({ run: m, terms: TERMS_OK });
  await wakeRun(wd);
  assert.match(allResults(m.log.at(-1).messages).find((r) => r.accepted === false).error, /has not looked at the forecast for day 2 in this run/);
  assert.equal(hasBoat(wd), true);

  // it looked at day 3, not day 2
  const m2 = scriptedModel([
    { calls: [T('get_trip')] },
    { calls: [T('get_forecast', { day: 3 })] },
    { calls: [T('search_places', { kind: 'museum' })] },
    ({ messages }) => ({ calls: [T('simulate_edit', swapEdit(messages))] }),
    ({ messages }) => ({ calls: [T('simulate_edit', cancelEdit(messages))] }),
    submitWith(BY_THRESHOLD),
    { calls: [T('no_change', { note: 'x' })] },
  ]);
  const wd2 = await world({ run: m2, terms: TERMS_OK });
  await wakeRun(wd2);
  assert.match(allResults(m2.log.at(-1).messages).find((r) => r.accepted === false).error, /has not looked at the forecast for day 2/);
  assert.equal(hasBoat(wd2), true);
});

test('a traveler who only asks about the weather on a stormy day gets an answer, not an action: a threshold is for wake-ups (S31)', async () => {
  const m = scriptedModel(upToCompare([submitWith(BY_THRESHOLD), { calls: [T('no_change', { note: 'Thunderstorms are forecast; tell me if you want a swap.' })] }]));
  const wd = await world({ run: m, terms: TERMS_OK });
  const before = moneyCalls(wd).length;
  const run = await startRun(wd, 'How is the weather looking on boat tour day?');
  assert.match(allResults(m.log.at(-1).messages).find((r) => r.accepted === false).error, /message from the traveler needs the traveler's own words/);
  assert.equal(run.final.kind, 'no_change');
  assert.equal(moneyCalls(wd).length, before);
  assert.equal(hasBoat(wd), true);
});

test('the demo button\'s made-up storm can back a change, and says so on the record', async () => {
  const m = scriptedModel(stormSteps({ authority: BY_THRESHOLD }));
  const wd = await world({ run: m, terms: TERMS_OK });
  const r = await wd.call('wake', [{ demo: true }]);
  assert.ok(r.ok, JSON.stringify(r));
  const run = await untilRunDone(wd.w.env, wd.id, r.v.runId, { token: wd.token });
  assert.equal(run.final.outcome, 'executed');
  assert.equal(wd.state().proposals[run.final.proposalId].authority.simulated, true);
  assert.match(run.events.find((e) => e.kind === 'decision').basis, /SIMULATED/);
  assert.equal(titles(run).includes('Compared 2 options'), true);
});

test('the weather limits are signed with the other limits: defaults, bounds, and the words the traveler reads', () => {
  const base = { enabled: true, refundCapCents: 1000, planIncreaseCapCents: 1000, validUntil: 5 };
  assert.deepEqual(normalizeTerms(base).weather, DEFAULT_WEATHER);
  assert.deepEqual(DEFAULT_WEATHER, { rainPct: 70, windKph: 50 });
  assert.deepEqual(normalizeTerms({ ...base, weather: { rainPct: 55, windKph: 40 } }).weather, { rainPct: 55, windKph: 40 });
  for (const bad of [{ rainPct: 0, windKph: 40 }, { rainPct: 101, windKph: 40 }, { rainPct: 50, windKph: 0 }, { rainPct: 50, windKph: 201 }, { rainPct: 'x', windKph: 40 }, { rainPct: 50 }]) {
    assert.throws(() => normalizeTerms({ ...base, weather: bad }), /rain|wind/i, JSON.stringify(bad));
  }
  assert.equal(normalizeTerms({ enabled: false }).weather, null);
  assert.match(describeTerms(normalizeTerms({ ...base, weather: { rainPct: 55, windKph: 40 } })), /55% chance of rain.*40 km\/h/);
});

test('the weather limits sent from the page reach the signed limits, and an old request without them gets the defaults', async () => {
  const { handleRequest } = await import('../src/api.js');
  const wd = await world({ run: scriptedModel([{ text: 'x' }]), checkout: false, docs: false });
  const post = (body) => handleRequest(new Request(`http://x/api/trips/${wd.id}/mandate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-token': wd.token, 'cf-connecting-ip': '1.1.1.1' }, body: JSON.stringify(body) }), wd.w.env, {});
  const ok = await post({ refundCap: 100, planIncreaseCap: 100, validUntil: '2026-05-08', rainPct: 60, windKph: 45 });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual((await wd.view()).proposal.mandateTerms.weather, { rainPct: 60, windKph: 45 });
  const old = await post({ refundCap: 100, planIncreaseCap: 100, validUntil: '2026-05-08' });
  assert.equal(old.status, 200);
  assert.deepEqual((await wd.view()).proposal.mandateTerms.weather, DEFAULT_WEATHER);
  assert.equal((await post({ refundCap: 100, planIncreaseCap: 100, validUntil: '2026-05-08', rainPct: 0, windKph: 45 })).status, 400);
});
