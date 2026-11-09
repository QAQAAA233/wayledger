// Fixed-window counters for the public demo, kept apart from the Durable Object class so tests can run them.
export async function takeQuota(storage, key, limit, windowMs, now = Date.now()) {
  const rec = (await storage.get(key)) ?? { n: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
  if (rec.n >= limit) return false;
  rec.n++;
  await storage.put(key, rec);
  return true;
}

// The money guard for the AI itself: neurons are what Workers AI bills (US$0.011 per 1,000). Every model call adds what
// it used to today's total (UTC day), and nothing starts once the day's allowance is spent. The check is code; no model
// can talk its way past it.
export async function addNeurons(storage, day, n) {
  const key = `neurons:${day}`;
  const total = ((await storage.get(key)) ?? 0) + Number(n || 0);
  await storage.put(key, total);
  return total;
}
export const neuronsToday = async (storage, day) => (await storage.get(`neurons:${day}`)) ?? 0;
export const DEFAULT_DAILY_NEURONS = 95_000; // about US$1.05 gross, about US$0.93 after the 10,000 free neurons a day
