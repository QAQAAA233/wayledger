import { quoteIn, dateInQuote, numberInQuote, normalizeText } from './facts.js';

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

export function validatePolicyFact(raw, { docs, plan }) {
  const item = plan.items.find((i) => i.id === raw.itemId);
  if (!item) throw new PolicyError(`There is no plan item ${raw.itemId}.`);
  if (raw.none === true) {
    if (docs.some((d) => mentions(d.text, item.title))) throw new PolicyError(`The terms do mention ${item.title}. Copy the sentence that does and say what it means.`);
    return { docId: null, itemId: item.id, itemTitle: item.title, quote: null, nonRefundable: false, freeCancelUntil: null, freeCancelUntilMs: null, penaltyPercent: null, none: true };
  }
  const doc = docs.find((d) => d.id === raw.docId);
  if (!doc) throw new PolicyError(`There is no document ${raw.docId}. Use a docId from read_documents.`);
  if (typeof raw.quote !== 'string' || !quoteIn(doc.text, raw.quote)) {
    throw new PolicyError('The quote is not in that document word for word. Copy the exact sentence from the document; do not paraphrase it.');
  }
  const nonRefundable = raw.nonRefundable === true;
  const until = raw.freeCancelUntil ? parseUntil(raw.freeCancelUntil) : null;
  const penalty = raw.penaltyPercent == null ? null : Number(raw.penaltyPercent);
  if (!nonRefundable && !until && penalty == null) throw new PolicyError('Say what the sentence means: nonRefundable, freeCancelUntil, or penaltyPercent.');
  if (nonRefundable && (until || penalty != null)) throw new PolicyError('nonRefundable means it can never be cancelled for free. For "free until a date, then non-refundable" use freeCancelUntil with penaltyPercent 100.');
  if (nonRefundable && DATE_WORDS.test(raw.quote)) throw new PolicyError('The sentence names a date. If it is a free-cancellation deadline, use freeCancelUntil, with penaltyPercent 100 if it says non-refundable after that. Use nonRefundable only for a sentence without a deadline.');
  if (until && !dateInQuote(raw.freeCancelUntil, raw.quote)) throw new PolicyError(`The date ${raw.freeCancelUntil} is not in your quote. Quote the sentence that states the date.`);
  if (penalty != null) {
    const stated = numberInQuote(penalty, raw.quote) || (penalty === 100 && SAYS_NO_REFUND.test(raw.quote));
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
