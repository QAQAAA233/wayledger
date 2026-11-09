// Checks that a claim "the text says so" is true. A model may read a message or a document and tell us what it says,
// but it must quote the words, and code compares the quote with the text letter for letter before believing it.
const SMART = [[/[‘’‛]/g, "'"], [/[“”‟]/g, '"'], [/[–—]/g, '-'], [/ /g, ' ']];

export function normalizeText(s) {
  let t = String(s ?? '');
  for (const [re, to] of SMART) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').trim();
}

// True only if `quote` appears in `text` word for word (spacing and typographic quotes aside).
export function quoteIn(text, quote) {
  const q = normalizeText(quote);
  return q.length >= 6 && normalizeText(text).includes(q);
}

// Every amount written in a piece of text, in dollars: "$1,200", "1200", "$1.2k", "900 dollars".
export function numbersIn(text) {
  const out = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([kK])?/g;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(m[2] ? n * 1000 : n);
  }
  return out;
}

// A budget the model says the person gave: believed only if the quote is in the person's words and contains that number.
export function budgetFromText(userText, budgetDollars, quote) {
  if (budgetDollars == null || !quote || !quoteIn(userText, quote)) return false;
  return numbersIn(quote).some((n) => Math.abs(n - Number(budgetDollars)) < 0.005);
}

// A name the model wants on the plan is believed if it came from a tool result this run, or the person wrote it.
export const textHasName = (text, name) => normalizeText(text).toLowerCase().includes(normalizeText(name).toLowerCase());

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The date or number a structured fact claims must really be in the quote it points to.
export function dateInQuote(iso, quote) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return false;
  const [month, day] = [Number(m[2]), Number(m[3])];
  const nums = (String(quote).match(/\d+/g) ?? []).map(Number);
  const q = String(quote).toLowerCase();
  return nums.includes(day) && (q.includes(MONTHS[month - 1]) || nums.includes(month));
}

export const numberInQuote = (n, quote) => (String(quote).match(/\d+(?:\.\d+)?/g) ?? []).map(Number).includes(Number(n));

// True if `text` repeats a stretch of at least `n` characters of any of the `secrets` (for example the system prompts).
export function sharesLongRun(text, secrets, n = 30) {
  const t = normalizeText(text).toLowerCase();
  if (t.length < n) return false;
  for (const secret of secrets) {
    const s = normalizeText(secret).toLowerCase();
    for (let i = 0; i + n <= s.length; i += 5) if (t.includes(s.slice(i, i + n))) return true;
  }
  return false;
}
