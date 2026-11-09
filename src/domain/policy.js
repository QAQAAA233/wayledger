import { quoteIn, dateInQuote, numberInQuote, normalizeText } from './facts.js';
import { dayDate, tripEndDate } from './plan.js';

// Cancellation terms, read by the model and checked by code. The model reads the person's pasted words and reports a
// structured fact together with the exact sentence it relied on. Code verifies the sentence is really in the document,
// that any date or percentage in the fact really appears in that sentence, and only then keeps it. Code, not the model,
// then works out what a change would cost the person on the operator's side.
export class PolicyError extends Error {}

export const MAX_DOC_CHARS = 4000;

function parseUntil(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s));
  if (!m) throw new PolicyError('freeCancelUntil must look like 2026-05-06 or 2026-05-06T12:00.');
  const t = Date.parse(`${m[1]}T${m[2] ? `${m[2]}:${m[3]}` : '23:59'}:00Z`);
  if (Number.isNaN(t)) throw new PolicyError('freeCancelUntil is not a real date.');
  return { text: m[2] ? `${m[1]} ${m[2]}:${m[3]}` : m[1], ms: t };
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const DATE_WORDS = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}/\\d{1,2}\\b`, 'i');
const SAYS_NO_REFUND = /non-?\s?refundable|no refund|not refundable|forfeit/i;

// Does a pasted text mention an item by its name? Judged by the words that make the name distinctive (5 letters or more).
export function mentions(text, title) {
  const words = normalizeText(title).toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^a-zÀ-ɏ]+/).filter(Boolean);
  const key = words.filter((w) => w.length >= 5);
  const t = normalizeText(text).toLowerCase();
  return (key.length ? key : words.filter((w) => w.length >= 3)).some((w) => t.includes(w));
}

// What a sentence says comes back, as a percentage: "an 80% refund", "refund of 80%". The penalty is what is left.
const REFUND_PERCENT = /(\d{1,3}(?:\.\d+)?)\s?%\s*(?:of the \w+\s+)?(?:will be\s+|is\s+|are\s+)?refund(?:ed|able)?|refunds?(?:ed)?\s+(?:of\s+|is\s+|are\s+)?(\d{1,3}(?:\.\d+)?)\s?%/i;
const refundPercentIn = (quote) => { const m = REFUND_PERCENT.exec(String(quote)); const n = m ? Number(m[1] ?? m[2]) : NaN; return Number.isFinite(n) ? n : null; };

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

export function validatePolicyFact(raw, { docs, plan }) {
  const item = plan.items.find((i) => i.id === raw.itemId);
  if (!item) throw new PolicyError(`There is no plan item ${raw.itemId}.`);
  if (raw.none === true) {
    if (docs.some((d) => mentions(d.text, item.title))) throw new PolicyError(`The terms do mention ${item.title}. Copy the sentence that does and say what it means.`);
    return { docId: null, itemId: item.id, itemTitle: item.title, quote: null, nonRefundable: false, freeCancelUntil: null, freeCancelUntilMs: null, penaltyPercent: null, none: true };
  }
  if (!raw.docId) throw new PolicyError('Say which document the sentence is in: give its docId (the ids come from read_documents).');
  const doc = docs.find((d) => d.id === raw.docId);
  if (!doc) throw new PolicyError(`There is no document ${raw.docId}. Use a docId from read_documents.`);
  if (typeof raw.quote !== 'string' || !quoteIn(doc.text, raw.quote)) {
    throw new PolicyError('The quote is not in that document word for word. Copy the exact sentence from the document; do not paraphrase it.');
  }
  // The sentence has to be about this item: one that names another item and not this one is somebody else's rule.
  if (!mentions(raw.quote, item.title)) {
    const other = plan.items.find((i) => i.id !== item.id && mentions(raw.quote, i.title));
    if (other) throw new PolicyError(`That sentence is about another item (${other.title}), not ${item.title}. Quote the sentence that is about ${item.title}, or record none: true if no sentence mentions it.`);
  }
  const nonRefundable = raw.nonRefundable === true;
  let until = raw.freeCancelUntil ? parseUntil(raw.freeCancelUntil) : null;
  const penalty = raw.penaltyPercent == null ? null : Number(raw.penaltyPercent);
  // a deadline counted back from the start ("48 hours before", "2 days before"): the number is the sentence's own, the
  // calendar is code's. It counts from the start of the item's day, which is the careful reading.
  const hours = raw.freeCancelHoursBefore == null ? null : Number(raw.freeCancelHoursBefore);
  const days = raw.freeCancelDaysBefore == null ? null : Number(raw.freeCancelDaysBefore);
  if (hours != null || days != null) {
    if (until) throw new PolicyError('Give either freeCancelUntil (a date the sentence states) or a number of hours or days before the start, not both.');
    if (hours != null && days != null) throw new PolicyError('Give freeCancelHoursBefore or freeCancelDaysBefore, not both.');
    const n = hours ?? days;
    if (!Number.isFinite(n) || n <= 0 || n > 366 * 24) throw new PolicyError('The number of hours or days before the start must be above zero.');
    if (!numberInQuote(n, raw.quote)) throw new PolicyError(`The number ${n} is not in your quote. Copy the sentence's own number: "48 hours before" is freeCancelHoursBefore 48, "2 days before" is freeCancelDaysBefore 2.`);
    const day = dayDate(plan.startDate, item.day);
    if (!day) throw new PolicyError('This trip has no start date, so a deadline counted back from the item cannot be worked out. Ask the traveler for the date.');
    const ms = Date.parse(`${day}T00:00:00Z`) - n * (hours != null ? 3_600_000 : 86_400_000);
    until = { text: stamp(ms), ms };
  }
  if (!nonRefundable && !until && penalty == null) throw new PolicyError('Say what the sentence means: nonRefundable, freeCancelUntil (or a number of hours or days before the start), or penaltyPercent.');
  if (nonRefundable && (until || penalty != null)) throw new PolicyError('nonRefundable means it can never be cancelled for free. For "free until a date, then non-refundable" use freeCancelUntil with penaltyPercent 100.');
  if (nonRefundable && DATE_WORDS.test(raw.quote)) throw new PolicyError('The sentence names a date. If it is a free-cancellation deadline, use freeCancelUntil, with penaltyPercent 100 if it says non-refundable after that. Use nonRefundable only for a sentence without a deadline.');
  if (raw.freeCancelUntil && !dateInQuote(raw.freeCancelUntil, raw.quote)) throw new PolicyError(`The date ${raw.freeCancelUntil} is not in your quote. Quote the sentence that states the date, and use the year it states.`);
  // a free-cancellation deadline falls before the trip is over; a year picked to make it "not passed yet" does not
  const end = tripEndDate(plan);
  if (raw.freeCancelUntil && end && until.ms > Date.parse(`${end}T23:59:59Z`) + 86_400_000) {
    throw new PolicyError(`The date ${raw.freeCancelUntil} is after the trip ends on ${end}. A free-cancellation deadline comes before the trip: check the year, which the sentence does not state.`);
  }
  if (penalty != null) {
    const comesBack = refundPercentIn(raw.quote);
    if (comesBack != null && penalty === comesBack && comesBack !== 50) throw new PolicyError(`The sentence says ${comesBack}% comes back, so the penalty is ${100 - comesBack}%, not ${comesBack}%.`);
    const stated = numberInQuote(penalty, raw.quote) || (penalty === 100 && SAYS_NO_REFUND.test(raw.quote)) || (comesBack != null && penalty === 100 - comesBack);
    if (!Number.isFinite(penalty) || penalty < 0 || penalty > 100 || !stated) throw new PolicyError(`The penalty ${raw.penaltyPercent}% is not in your quote. Quote the sentence that states it.`);
  }
  return {
    docId: doc.id, itemId: item.id, itemTitle: item.title, quote: String(raw.quote).trim().slice(0, 300),
    nonRefundable, freeCancelUntil: until?.text ?? null, freeCancelUntilMs: until?.ms ?? null, penaltyPercent: penalty, none: false,
  };
}

// What the person would lose to the operator by cancelling `item` at `nowMs` under `fact`. null = nothing is known.
// When the free period is over and the terms do not say what then, the worst case is assumed (`assumed`).
export function operatorLoss(item, fact, nowMs) {
  if (!fact) return { lossCents: null, why: 'no cancellation terms were recorded for this item' };
  if (fact.none) return { lossCents: null, why: 'the pasted terms do not mention it' };
  if (fact.nonRefundable) return { lossCents: item.amountCents, why: 'the terms say it is non-refundable' };
  if (fact.freeCancelUntilMs != null && nowMs <= fact.freeCancelUntilMs) return { lossCents: 0, why: `free to cancel until ${fact.freeCancelUntil}` };
  if (fact.penaltyPercent != null) return { lossCents: Math.round((item.amountCents * fact.penaltyPercent) / 100), why: fact.freeCancelUntil ? `free cancellation ended ${fact.freeCancelUntil}; the terms charge ${fact.penaltyPercent}%` : `the terms charge ${fact.penaltyPercent}%` };
  return { lossCents: item.amountCents, assumed: true, why: `free cancellation ended ${fact.freeCancelUntil}, and the terms do not say what happens after, so the whole price may be lost` };
}
