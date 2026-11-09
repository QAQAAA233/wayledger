// Fixed-window counters for the public demo, kept apart from the Durable Object class so tests can run them.
export async function takeQuota(storage, key, limit, windowMs, now = Date.now()) {
  const rec = (await storage.get(key)) ?? { n: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
  if (rec.n >= limit) return false;
  rec.n++;
  await storage.put(key, rec);
  return true;
}
