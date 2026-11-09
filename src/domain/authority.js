import { normalizeText, quoteIn } from './facts.js';

// The basis of a move of money. An edit the agent submits must rest on one of two things, and code checks which:
//   traveler   words the traveler wrote in this run, quoted letter for letter. Pasted terms and the agent's own sentences are not.
//   threshold  a weather limit the traveler signed with the other limits, that a forecast the agent fetched in this run crossed.
//              It is for the schedule's wake-ups: a traveler who only asks about the weather has not asked for a change.
// Without a basis the agent can only answer. What the agent says about the basis is a claim; what is stored is what code verified.
export const WEATHER_METRICS = {
  rainPct: { read: (f) => f.rainChancePct, fmt: (n) => `${n}%`, what: (n) => `${n}% chance of rain` },
  windKph: { read: (f) => f.windKph, fmt: (n) => `${n} km/h`, what: (n) => `wind up to ${n} km/h` },
};

export function verifyAuthority(a, { trigger, travelerText, mandate, now, forecasts }) {
  if (a.source === 'traveler') {
    if (trigger !== 'message') throw new Error('This run has no message from the traveler, so there are no traveler\'s own words to quote: the schedule woke you. A change needs a weather limit the traveler signed (source threshold) that a forecast you fetched in this run crossed. Otherwise finish with no_change.');
    if (!quoteIn(travelerText, a.quote ?? '')) throw new Error('The quote is not in the traveler\'s own words. Copy the part of the traveler\'s message that asks for this change, letter for letter. Pasted terms and your own summary are not their words. If the traveler did not ask for a change, finish with no_change or ask_traveler.');
    return { source: 'traveler', quote: normalizeText(a.quote) };
  }
  if (trigger === 'message') throw new Error('A message from the traveler needs the traveler\'s own words as its basis (source traveler). A weather limit is for the schedule\'s wake-ups: a traveler who asks about the weather has not asked you to act.');
  const metric = WEATHER_METRICS[a.metric];
  if (!metric || !Number.isInteger(a.day)) throw new Error('A weather basis names the metric (rainPct or windKph) and the trip day whose forecast crossed the limit.');
  const live = mandate?.terms?.enabled && now < mandate.terms.validUntil;
  const limit = live ? mandate.terms.weather?.[a.metric] : undefined;
  if (limit == null) throw new Error('The traveler has no live weather limit signed, so a forecast cannot back a change. Finish with no_change or ask_traveler.');
  const f = forecasts.get(a.day);
  if (!f?.available) throw new Error(`The agent has not looked at the forecast for day ${a.day} in this run. Call get_forecast for that day first.`);
  const observed = metric.read(f);
  if (!(observed >= limit)) throw new Error(`The forecast for day ${a.day} says ${metric.what(observed)}, below the ${metric.fmt(limit)} limit the traveler signed, so it does not back a change. Finish with no_change.`);
  return { source: 'threshold', metric: a.metric, day: a.day, date: f.date, limit, observed, simulated: Boolean(f.simulated) };
}

// The one sentence the traveler reads next to the choice: what it rests on.
export function describeAuthority(auth) {
  if (auth.source === 'traveler') return `You wrote: “${auth.quote}”`;
  const m = WEATHER_METRICS[auth.metric];
  return `The forecast for day ${auth.day} (${auth.date}) says ${m.what(auth.observed)}, at or above the ${m.fmt(auth.limit)} limit you signed.${auth.simulated ? ' SIMULATED by the demo button, not a real forecast.' : ''}`;
}
