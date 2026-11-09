import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePolicyFact, operatorLoss, PolicyError } from '../src/domain/policy.js';
import { normalizePlan } from '../src/domain/plan.js';
import { SAMPLE_PLAN } from './helpers.js';

// Second-round review, finding 4: the reading of a booking term is the model's, the checking is code's. A sentence has to
// be about the item it is recorded for, every date has to be real in the sentence and on the trip's calendar, and a
// deadline counted back from the start can be recorded too.
const plan = normalizePlan(SAMPLE_PLAN, null, { budgetSource: 'text', startDate: '2026-05-04' }); // boat is day 2: 5 May
const boat = plan.items.find((i) => /boat/i.test(i.title));
const sintra = plan.items.find((i) => /Sintra/.test(i.title));
const NOW = Date.parse('2026-05-01T09:00:00Z');
const doc = (text) => [{ id: 'd1', text }];
const fact = (docs, raw, item = boat) => validatePolicyFact({ docId: 'd1', itemId: item.id, ...raw }, { docs, plan, now: NOW });

test('finding 4: a year that is not in the sentence cannot be made up, and a deadline after the trip is refused', () => {
  const noYear = doc('Sunset boat tour: free cancellation until 2 May 12:00, after that non-refundable.');
  const q = 'Sunset boat tour: free cancellation until 2 May 12:00';
  assert.equal(fact(noYear, { quote: q, freeCancelUntil: '2026-05-02T12:00' }).freeCancelUntil, '2026-05-02 12:00');
  // the 2099 trick: the sentence names no year, the model picks one so far ahead that the deadline "has not passed"
  assert.throws(() => fact(noYear, { quote: q, freeCancelUntil: '2099-05-02T12:00' }), (e) => e instanceof PolicyError && /after the trip/.test(e.message));
  assert.throws(() => fact(noYear, { quote: q, freeCancelUntil: '2027-05-02T12:00' }), /after the trip/);

  const withYear = doc('Sunset boat tour: free cancellation until 2 May 2026 12:00, after that non-refundable.');
  const qy = 'Sunset boat tour: free cancellation until 2 May 2026 12:00';
  assert.ok(fact(withYear, { quote: qy, freeCancelUntil: '2026-05-02T12:00' }));
  assert.throws(() => fact(withYear, { quote: qy, freeCancelUntil: '2027-05-02T12:00' }), /not in your quote/, 'the sentence says 2026');
  const iso = doc('Sunset boat tour: free cancellation until 2026-05-02 12:00');
  assert.ok(fact(iso, { quote: 'Sunset boat tour: free cancellation until 2026-05-02 12:00', freeCancelUntil: '2026-05-02T12:00' }));
});

test('finding 4: a sentence about another item is not a rule for this one; a sentence about no item in particular is', () => {
  const both = doc('Sunset boat tour: free cancellation until 2 May 12:00.\nSintra day trip: non-refundable from the moment of booking.');
  assert.throws(() => fact(both, { quote: 'Sintra day trip: non-refundable from the moment of booking.', nonRefundable: true }, boat), (e) => e instanceof PolicyError && /another item/.test(e.message) && /Sintra day trip/.test(e.message));
  assert.ok(fact(both, { quote: 'Sintra day trip: non-refundable from the moment of booking.', nonRefundable: true }, sintra));
  const generic = doc('All bookings: free cancellation until 2 May 12:00, after that non-refundable.');
  assert.ok(fact(generic, { quote: 'All bookings: free cancellation until 2 May 12:00', freeCancelUntil: '2026-05-02T12:00' }, boat));
  assert.ok(fact(generic, { quote: 'All bookings: free cancellation until 2 May 12:00', freeCancelUntil: '2026-05-02T12:00' }, sintra));
});

test('finding 4: a deadline counted back from the start is recorded from the number in the sentence, worked out by code', () => {
  const rel = doc('Sunset boat tour: free cancellation up to 48 hours before the start, after that 50% is charged.');
  const q = 'Sunset boat tour: free cancellation up to 48 hours before the start, after that 50% is charged.';
  const f = fact(rel, { quote: q, freeCancelHoursBefore: 48, penaltyPercent: 50 }, boat);
  assert.equal(f.freeCancelUntil, '2026-05-03 00:00', 'two days before the start of the boat day (5 May)');
  assert.equal(operatorLoss({ ...boat }, f, NOW).lossCents, 0);
  assert.equal(operatorLoss({ ...boat }, f, Date.parse('2026-05-04T09:00:00Z')).lossCents, 9000, 'after the deadline half the price is lost');
  const days = doc('Sunset boat tour: free cancellation up to 2 days before arrival.');
  assert.equal(fact(days, { quote: 'Sunset boat tour: free cancellation up to 2 days before arrival.', freeCancelDaysBefore: 2 }).freeCancelUntil, '2026-05-03 00:00');
  assert.throws(() => fact(rel, { quote: q, freeCancelHoursBefore: 24 }), /not in your quote/, 'the number must be the sentence\'s own');
  assert.throws(() => fact(rel, { quote: q, freeCancelHoursBefore: 48, freeCancelUntil: '2026-05-03' }), /either|not both/i);
  const noDates = { ...plan, startDate: null };
  assert.throws(() => validatePolicyFact({ docId: 'd1', itemId: boat.id, quote: q, freeCancelHoursBefore: 48 }, { docs: rel, plan: noDates, now: NOW }), /no start date/);
});

test('finding 4: a percentage that is what comes back is not the penalty; the penalty is what is left', () => {
  const refund = doc('Sunset boat tour: cancel up to the day before for an 80% refund.');
  const q = 'Sunset boat tour: cancel up to the day before for an 80% refund.';
  assert.throws(() => fact(refund, { quote: q, penaltyPercent: 80 }), (e) => /80% comes back/.test(e.message) && /20%/.test(e.message));
  assert.equal(fact(refund, { quote: q, penaltyPercent: 20 }).penaltyPercent, 20);
});
