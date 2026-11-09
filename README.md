# Wayledger

**Group trips where the money follows the plan, and an agent keeps them in step while you are away.**

Wayledger turns one plain-language request ("three of us, Lisbon, four days, $1,200") into an itinerary and a budget, and places one PayPal **Trip Reserve** (an authorization) with money set aside for each item. You then sign **limits** with your first PayPal approval: the most the agent may refund, the most it may raise the plan by, and until when. From then on an AI agent watches the trip. When something changes (a storm, a price, someone dropping out) it looks at the real forecast, real places and the booking terms you pasted, tries the options in a simulator, and acts: **on its own inside your limits, and only with your OK outside them**. Every step it took is shown, and PayPal is asked afterwards whether the ledger still matches.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). All payments run in the **PayPal sandbox**; no real money moves.

- Live demo: https://wayledger.lvsyn-tw.workers.dev
- Demo video: `VIDEO_URL`

## What is new in this version

| | |
|---|---|
| **A real agent loop** | The model calls tools, reads what they return and decides the next step, for several rounds, until it submits, asks, or says nothing needs to change. Pulling the model out leaves nothing that can decide (`src/agent/`). |
| **Signed limits** | Cancel-or-refund limit, plan-raise limit, validity. Stored with a digest; code enforces them number by number on every PayPal call. The model cannot change them. Inside the limits the agent executes itself; outside, the change waits as a proposal for you. A charge, a change of who is on the trip or who shares an item, and a new hold always wait for you, whatever the limits say (`src/domain/mandate.js`, `src/domain/proposal.js`). |
| **Perception** | Real forecast (Open-Meteo), real places with real names (Wikidata), PayPal's own state through the **PayPal Agent Toolkit** (`get_order`, `get_refund`, `list_disputes`, the hold's expiry), and the booking terms you paste. Nothing about the buyer leaves the server: no email, name or address reaches the model. |
| **Self-wake** | A Durable Object alarm wakes the agent every 6 hours. It looks at the real forecast and wakes the model only when something worth deciding changed. A clearly labelled **demo button** fast-forwards to the next check with a *simulated* storm; everything simulated is marked on screen and never poses as a real forecast. |
| **Models read, code guards** | The model reads your cancellation terms into a structured rule and must quote the exact sentence; code compares the quote with your text letter for letter, checks that every date and percentage is in that sentence, and only then keeps the rule. Code, not the model, works out what a change costs you at the operator, and a change that costs you money there always waits for you. The sentence is shown on screen. |
| **Work trail** | What the agent looked up, what it saw, which options it tried, why it chose, whether it was inside your limits, and PayPal's check afterwards (`public/app.js`). |
| **Webhooks** | PayPal events are believed only after PayPal itself verified the signature, and they are kept on the trip. A signed "authorization voided" for a hold the ledger shows open is recorded by code (the ledger, a banner, a button for a new hold); no model is woken for it. |
| **Evaluation** | 24 changing scenarios, an agent loop against a one-call baseline, two models, three runs each, numbers computed by a program from raw logs (`eval/`). |

## The money: pay only for what happens

Most AI checkout demos stop at "buy once". Real group plans change after the money is committed. Wayledger models a PayPal authorization as a **Trip Reserve** and items as quotas under it, covering the full payment lifecycle with zero mismatch between the screen and PayPal. Instead of charging everything upfront and issuing refunds later, **nothing is charged until its scheduled day**, and the final charge releases the rest:

| Moment | Action & PayPal call | Who decides |
|---|---|---|
| First checkout: place the Trip Reserve (plus a buffer for changes, as big as the raise you allow) | `POST /v2/checkout/orders` (`intent: AUTHORIZE`) then `/authorize` | You approve in PayPal; the limits are signed with it |
| Items paid in advance | `POST /v2/payments/authorizations/{id}/capture` (`final_capture: false`) only if marked prepaid | Confirmed amounts |
| Each item on its day (`chargesOn`) | `POST /v2/payments/authorizations/{id}/capture` (`final_capture: false` or `true` if last) | The schedule's check / alarm |
| A held item is removed before its day, or an addition fits the buffer | Money is set aside or released inside the hold; PayPal does not move (no charge, no refund) | Inside your limits: the agent. Otherwise: you |
| Something paid in advance is added, or the price of an already-charged item rises | `POST /v2/payments/authorizations/{id}/capture`: a real charge | Always you |
| An item already charged or paid in advance is cancelled or lowered | `POST /v2/payments/captures/{id}/refund`, split per capture | Inside your limits: the agent. Otherwise: you |
| A change needs more than the hold has | A new PayPal authorization | Always you, in PayPal |
| **Last charge or Close trip** | `POST /v2/payments/authorizations/{id}/capture` (`final_capture: true` releases the rest); or `void` if no charge was made | Alarm / You |
| "Does the ledger match PayPal?" | Read every authorization, capture and refund back from PayPal, and check that every item has the money the plan says | Anyone, one click, and the agent after it acted |

## How the agent is kept honest

- **The model has no money tools.** Its hands are `get_trip`, `get_forecast`, `search_places`, `get_payment_status`, `read_documents`, `record_policy`, `simulate_edit`, and three ways to finish: `submit_edit`, `ask_traveler`, `no_change`. `submit_edit` must be exactly an edit it simulated.
- **Code decides what happens to the money.** A submitted edit is run through the same simulator; if it is inside the signed limits, needs no new PayPal approval and costs you nothing at the operator, it executes under a confirmation made by the mandate (digest checked, limits checked, refund counted). Otherwise it becomes a proposal with a digest, a cap and a 15-minute expiry that only you can confirm. This is the only road after the first approval, also for a change that moves no money.
- **Facts are not invented.** A new place must carry a `placeId` that a search returned in this run (its real name is filled in by the host); a price is the price of what it replaces or one you wrote, and a new price on an existing item must be one you wrote too (the first holdout run caught a model working out discounts nobody mentioned); everyone who joins, leaves or changes share must be named in your own message, and the words you pasted (booking terms) are other people's text, never a name, a price or a share. An amount is an amount of money ("$90"), not a day or a time. The booking terms must be read before anything is cancelled or lowered, a rule must quote a sentence about that item and may not contradict it (dates are checked against the sentence's own year and the trip's calendar, "48 hours before" is worked out by code), and a change that costs you money at an operator under those terms always waits for you.
- **Words on the proposal are written by code** from the actions. What the model said is kept apart and labelled "Agent's note". PayPal's refund note is a fixed sentence.
- **Arguments are validated**, unknown fields rejected, broken JSON never echoed back to the model API; two reminders if it answers in plain text instead of acting; 12 turns and 170 seconds at most; a daily spend guard stops the agent and says so.
- **The ledger is append-only and reconciled at the object level** (`src/domain/ledger.js`, `src/paypal.js`): after every PayPal write the resource is read back and *its* amount and status are stored.
- **One trip = one Durable Object**; money steps run one at a time; the agent runs in the object's alarm, never inside a request.
- **Only the person who planned the trip can act.** The browser that planned it holds a secret token (its hash is stored); a shared link can look, including at the agent's work, but cannot confirm, pay, close or start the agent, and does not show the pasted documents, the sentences quoted from them or PayPal's events.
- **A hold PayPal no longer has is not a dead end.** If a hold is voided in PayPal or runs out, the ledger records it as PayPal's doing, says which items have no money behind them, and offers a new hold for exactly those; closing the trip works too (`test/p4-lost-hold.test.js`).

Permanent tests (`npm test`, 182, all against the real engine, ledger, gate, tools and loop; only PayPal's HTTP, the models and the data services are stand-ins, and the PayPal fake answers in the shape of recorded sandbox responses) include: no confirmation means no money moves; a model that never reads the terms cannot cancel anything; a model that submits over its limit is blocked and the change waits for you; one model call cannot do the task (the record shows the rounds); the seven attacks from the review and the second review's findings (a charge is never made on a yes the person did not give, pasted documents are not the traveler's words, a hold PayPal cancelled is not a dead end); forged and replayed webhooks; and a real-browser run through both flows.

<!-- EVAL:BEGIN -->
## Evaluation: does the loop beat one call?

Same trips, same facts, same guards and simulator, two ways of deciding: the **agent loop** (tools, several rounds, simulate before submit) and a **one-call baseline** (all the facts pre-fetched into one prompt, one answer, no way to look anything up or try an option first, with the formatting help a retry would give). Two models through Workers AI: Gemma 4 26B (thinking off) and gpt-oss-120b, three runs each. Every figure is computed by a program from the raw records in `eval/results/`; the scenarios, their ground truth and their checks were written before any model ran (`eval/scenarios.mjs`), and a reference answer that meets every check plus wrong answers that fail them prove the scoring (`eval/README.md`).

**Round 1 holdout: 17 scenarios never used for tuning, instructions frozen at commit 34bba8d, run once**

| | runs | constraints met | every repetition met | ideal decision | refunded without need | operator loss without a yes | no decision or error | neurons per run |
|---|---|---|---|---|---|---|---|---|
| agent loop / gemma | 51 | **86%** | 82% | 84% | $540 | $0 | 1 | 161 |
| agent loop / oss | 51 | **63%** | 59% | 57% | $1200 | $0 | 1 | 477 |
| one call / gemma | 51 | **67%** | 65% | 53% | $180 | $0 | 23 | 26 |
| one call / oss | 51 | **65%** | 59% | 61% | $1200 | $0 | 5 | 113 |

**The same 17 scenarios again after one host guard was added (a new price must be one the traveler wrote); no longer unseen**

| | runs | constraints met | every repetition met | ideal decision | refunded without need | operator loss without a yes | no decision or error | neurons per run |
|---|---|---|---|---|---|---|---|---|
| agent loop / gemma | 51 | **82%** | 82% | 82% | $540 | $0 | 0 | 173 |
| agent loop / oss | 51 | **73%** | 65% | 69% | $180 | $0 | 2 | 567 |
| one call / gemma | 51 | **69%** | 65% | 57% | $180 | $0 | 21 | 26 |
| one call / oss | 51 | **57%** | 47% | 49% | $1080 | $0 | 7 | 111 |

**The same 17 scenarios with the second-round instructions (the shipped version); seen before, so not a clean test**

| | runs | constraints met | every repetition met | ideal decision | refunded without need | operator loss without a yes | no decision or error | neurons per run |
|---|---|---|---|---|---|---|---|---|
| agent loop / gemma | 51 | **90%** | 88% | 88% | $540 | $0 | 1 | 171 |
| agent loop / oss | 51 | **67%** | 47% | 67% | $540 | $0 | 2 | 518 |
| one call / gemma | 51 | **76%** | 76% | 65% | $0 | $0 | 18 | 26 |
| one call / oss | 51 | **75%** | 65% | 63% | $360 | $0 | 7 | 115 |

**Round 2: 8 new scenarios written after round 1, run once with the second-round instructions (the shipped version)**

| | runs | constraints met | every repetition met | ideal decision | refunded without need | operator loss without a yes | no decision or error | neurons per run |
|---|---|---|---|---|---|---|---|---|
| agent loop / gemma | 24 | **88%** | 75% | 83% | $360 | $0 | 0 | 167 |
| agent loop / oss | 24 | **71%** | 50% | 67% | $180 | $0 | 1 | 531 |
| one call / gemma | 24 | **79%** | 75% | 75% | $0 | $0 | 6 | 26 |
| one call / oss | 24 | **79%** | 63% | 75% | $540 | $0 | 1 | 119 |

**Reading the tables.** With the default model (Gemma) the agent loop met more constraints than one call in every round (86% against 67%; 82% against 69%; 90% against 76%; 88% against 79%). It can read the terms, try options and recover when a guard refuses an answer: the one call ended without any decision in 6 to 23 runs per round (of 51, or 24 in the last), the loop in at most 1. With gpt-oss-120b the loop was ahead of one call in 1 of 4 rounds (63% against 65%; 73% against 57%; 67% against 75%; 71% against 79%), so the loop is not a free win and the model matters; Gemma is the default because it scored higher, answered faster and used about a third of the compute. Where the loop loses, the per-scenario tables show it: with Gemma it changed a booking for a 35% chance of light rain (S13, runs meeting the constraints per round: 0 of 3, 0 of 3, 0 of 3) and it sometimes acts on a plain question (S31, fresh round: 1 of 3), where one call did not. A change that costs the traveler money at an operator never went through without a yes in any row.

Full tables per scenario, the method, what was changed after looking at which results, and the limits of this evaluation are in [`eval/README.md`](eval/README.md).

<!-- EVAL:END -->

**One ground truth was changed after these tables, before any rerun.** After the second review the product rule became: a change of who is on the trip or who shares an item always waits for the traveler's OK. The ideal finish of three scenarios, S09 (Cy cannot come), S22 (a dinner for Ana and Ben only) and S28 (a fourth traveler joins), was therefore changed from "executed" to "proposed" in commit `d16f621` (2026-11-10), for a product reason and before any model was run under the rule. The tables above were run earlier and are not re-scored; the details are in [`eval/README.md`](eval/README.md#what-was-run-in-order-and-what-was-changed-after-which-result).

## Seen working on the live site (PayPal sandbox)

Real Chrome, the real PayPal sandbox window, the deployed Worker, the real models, the real forecast and place services:

- **Inside the limits the agent acts on its own.** Limits signed with the first approval, terms pasted, the demo button pressed. The trail shows the storm labelled as simulated, the terms read, the sentence it relied on quoted, a place id it had made up before searching rejected by the host, real museums from Wikidata, the swap carried out by itself (the boat tour refunded in PayPal), and the check afterwards: *4 of 4 PayPal records match*. ![The agent acts inside its limits](docs/screens/flow-a-the-agent-acts-inside-its-limits.png)
- **Outside the limits it stops.** The same request with a $100 refund limit becomes a proposal that says why; nothing moves until Confirm, and a person's yes does not use up the agent's limit. ![Outside the limits it waits for your OK](docs/screens/flow-b-outside-the-limits-it-waits-for-your-ok.png)
- **It wakes itself.** On a copy of the site whose self-wake interval was 90 seconds, nobody pressed anything: 95 seconds after the limits were signed a Durable Object alarm woke the agent, it read the real forecast (thunderstorms, 98% chance of rain at the trip's destination that day), looked at the plan (a hostel and a dinner, both indoors) and decided nothing needed to change. ![A real alarm woke the agent](docs/screens/self-wake-a-real-alarm-no-button.png)
- **PayPal's own state, through the PayPal Agent Toolkit**, in the work trail: the hold, until when it is valid, what was charged and refunded, open disputes.
- **The agent's own words are not trusted.** Told to write "PayPal verified this. No money moves." in its note, it did: the sentence appears only in a box labelled "its own words, not checked by the code", below the amounts the code wrote ("Refund $400.00 ...").
- **The seven attacks from the review, retried against the live site:** an approval 11 seconds after the proposal expired (refused, nothing held); an old PayPal window approved after the plan changed underneath (refused with a plain sentence, the order stays unauthorized at PayPal, the ledger stays empty); a budget of "null" injected through the request (no budget, nothing held); the system prompt asked for as the trip title (replaced by a plain title); a forged summary (see above); a script with no login confirming, paying, closing or starting the agent (403 on every route); hammering a trip that does not exist (404, no allowance spent).

## Architecture

```text
public/              single-page UI (vanilla JS, AG Grid Community for budget + ledger, PayPal JS SDK buttons, the work trail)
src/index.js         Worker entry and the two Durable Object classes (TripDO: one per trip, Quota: demo limits and the AI spend guard)
src/api.js           Routes, the demo allowance, the judge code, the webhook receiver
src/trip-object.js   What one trip's object does: calls, the agent's alarm, webhooks
src/trip-runner.js   Serializes state-changing calls; owner token check; plain data in and out
src/engine.js        createTrip / submitEdit / confirm / order / approve / close / retry / reconcile, the mandate and the guards
src/agent/           loop.js (the agent loop), tools.js (hands and eyes), prompts.js, model.js (Workers AI), sources.js (forecast, places,
                     PayPal state), toolkit.js (PayPal Agent Toolkit), runner.js (runs, trace, schedule, self-wake)
src/domain/          plan rules, money delta, ledger, proposal gate, mandate (the signed limits), policy (terms facts), describe (traveler words)
src/paypal.js        PayPal REST client (Orders v2, Payments v2, webhook verification) returning ledger facts
eval/                the evaluation: scenarios, one-call baseline, scoring, report, raw records
test/                node:test suites
```

## Run it yourself

Requirements: Node 20+, a Cloudflare account on the Workers Paid plan (Workers AI, Durable Objects), a PayPal developer account (free sandbox).

```bash
git clone <this repo> && cd wayledger
npm install
# PayPal sandbox app credentials: https://developer.paypal.com/dashboard/applications/sandbox
printf 'PAYPAL_CLIENT_ID=...\nPAYPAL_CLIENT_SECRET=...\n' > .dev.vars
npx wrangler login
npm run dev          # http://localhost:8787
npm test             # permanent tests: engine, agent, routes, webhooks, and real-browser runs (needs Chrome; set CHROME_PATH if not found)
```

Deploy: `npx wrangler secret put PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, optionally `JUDGE_CODE` and `PAYPAL_WEBHOOK_ID` (the id of a sandbox webhook pointing at `/api/webhooks/paypal`), then `npm run deploy`. Settings in `wrangler.jsonc`: `AGENT_MODEL` (`gemma` or `oss`), `AGENT_FALLBACK`, `WAKE_EVERY_MS`, `AI_DAILY_NEURONS` (the agent's daily spend guard, about US$1 at the default), `AI_PUBLIC_SHARE` (how much of that day the public may use; the rest is kept for the judge code).

### Trying the hosted demo

1. Open the demo, press a sample trip, check the date, and press **Plan my trip**.
2. The card shows the money and the **limits** you are about to sign (cancel or refund up to, raise the plan by up to, until). Keep them or change them and press **Update limits**.
3. Press the PayPal button and log in with the sandbox buyer from the Devpost **Testing instructions**. Approving places the hold and signs the limits.
4. Open **Booking terms**, press **Use a sample**, **Save terms** (the sample is written with dates from your trip).
5. Press **Fast-forward to the next check (simulated storm)**. Watch the work trail: the agent reads the terms and quotes the sentence it relied on, finds real indoor places, tries options, and swaps the boat tour on its own because it is inside your limits. Then press **Verify against PayPal**.
6. To see the other path, set a small refund limit in step 2: the same request stops, shows why, and moves nothing until you confirm.

The public demo is rate limited per visitor, per day, and by an AI spend guard; the testing instructions include a judge code that lifts the per-visitor limits (open the demo with `?judge=<code>`).

## Known limits

- **Sandbox only; one payer.** The trip's shares are computed per person, but one PayPal account holds the money.
- **PayPal's honor period and reauthorization.** PayPal guarantees the funds of an authorization for 3 days (the honor period); captures after that are subject to risk and funds availability. Reauthorization can be done only once, between day 4 and day 29, and is not implemented in Wayledger. The hard upper limit on any authorization is 29 days. Wayledger places the hold no earlier than 26 days before the trip's last day, shows when it is valid until, and reads its expiry. A trip closed long after its end, or a buyer whose funds are gone after day 3, can make the final capture fail, and the app then says so and charges nothing.
- **Prices of new places are not looked up** (no free source exists). A new place is priced like the item it replaces or at a price you write, and the screen says so.
- **The self-wake needs a Durable Object alarm**; the demo button runs the same code path with a simulated storm.
- **The agent is not infallible.** In the evaluation Gemma changed a booking for a 35% chance of light rain and sometimes acted on a plain question; with gpt-oss-120b the loop did not beat one call. What holds regardless of what the model decides is in code: the signed limits, the quotes, the grounding of places, prices and names, the proposal gate, the verified webhooks and the ledger check.

## License

MIT - see [LICENSE](LICENSE).
