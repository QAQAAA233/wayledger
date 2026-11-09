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
| **Signed limits** | Refund limit, plan-raise limit, validity. Stored with a digest; code enforces them number by number on every PayPal call. The model cannot change them. Inside the limits the agent executes itself; outside, the change waits as a proposal for you (`src/domain/mandate.js`, `src/domain/proposal.js`). |
| **Perception** | Real forecast (Open-Meteo), real places with real names (Wikidata), PayPal's own state through the **PayPal Agent Toolkit** (`get_order`, `get_refund`, `list_disputes`, the hold's expiry), and the booking terms you paste. Nothing about the buyer leaves the server: no email, name or address reaches the model. |
| **Self-wake** | A Durable Object alarm wakes the agent every 6 hours. It looks at the real forecast and wakes the model only when something worth deciding changed. A clearly labelled **demo button** fast-forwards to the next check with a *simulated* storm; everything simulated is marked on screen and never poses as a real forecast. |
| **Models read, code guards** | The model reads your cancellation terms into a structured rule and must quote the exact sentence; code compares the quote with your text letter for letter, checks that every date and percentage is in that sentence, and only then keeps the rule. Code, not the model, works out what a change costs you at the operator, and a change that costs you money there always waits for you. The sentence is shown on screen. |
| **Work trail** | What the agent looked up, what it saw, which options it tried, why it chose, whether it was inside your limits, and PayPal's check afterwards (`public/app.js`). |
| **Webhooks** | PayPal events are believed only after PayPal itself verified the signature; they are kept on the trip and can wake the agent. |
| **Evaluation** | 24 changing scenarios, an agent loop against a one-call baseline, two models, three runs each, numbers computed by a program from raw logs (`eval/`). |

## The money, unchanged and still verified

Most AI checkout demos stop at "buy once". Real group plans change after the money is committed. Wayledger models a PayPal authorization as a **Trip Reserve** and items as quotas under it, covering the full payment lifecycle with zero mismatch between the screen and PayPal:

| Moment | Action & PayPal call | Who decides |
|---|---|---|
| First checkout: place the Trip Reserve (plus a buffer for changes, as big as the raise you allow) | `POST /v2/checkout/orders` (`intent: AUTHORIZE`) then `/authorize` | You approve in PayPal; the limits are signed with it |
| Items paid in advance | `POST /v2/payments/authorizations/{id}/capture` (`final_capture: false`) | Confirmed amounts |
| A held item is removed, or an addition fits the buffer | Money is set aside or freed inside the hold; PayPal does not move | Inside your limits: the agent. Otherwise: you |
| A captured item is removed or gets cheaper | `POST /v2/payments/captures/{id}/refund`, split per capture | Inside your limits: the agent. Otherwise: you |
| A change needs more than the hold has | A new PayPal authorization | Always you, in PayPal |
| **Close trip** | Capture what is kept, void the unused hold | Always you |
| "Does the ledger match PayPal?" | Read every authorization, capture and refund back from PayPal, and check that every item has the money the plan says | Anyone, one click, and the agent after it acted |

## How the agent is kept honest

- **The model has no money tools.** Its hands are `get_trip`, `get_forecast`, `search_places`, `get_payment_status`, `read_documents`, `record_policy`, `simulate_edit`, and three ways to finish: `submit_edit`, `ask_traveler`, `no_change`. `submit_edit` must be exactly an edit it simulated.
- **Code decides what happens to the money.** A submitted edit is run through the same simulator; if it is inside the signed limits, needs no new PayPal approval and costs you nothing at the operator, it executes under a confirmation made by the mandate (digest checked, limits checked, refund counted). Otherwise it becomes a proposal with a digest, a cap and a 15-minute expiry that only you can confirm.
- **Facts are not invented.** A new place must carry a `placeId` that a search returned in this run (its real name is filled in by the host); a price is the price of what it replaces or one you wrote; a new traveler must be someone you named. The booking terms must be read before anything is cancelled or lowered.
- **Words on the proposal are written by code** from the actions. What the model said is kept apart and labelled "Agent's note". PayPal's refund note is a fixed sentence.
- **Arguments are validated**, unknown fields rejected, broken JSON never echoed back to the model API; two reminders if it answers in plain text instead of acting; 12 turns and 170 seconds at most; a daily spend guard stops the agent and says so.
- **The ledger is append-only and reconciled at the object level** (`src/domain/ledger.js`, `src/paypal.js`): after every PayPal write the resource is read back and *its* amount and status are stored.
- **One trip = one Durable Object**; money steps run one at a time; the agent runs in the object's alarm, never inside a request.
- **Only the person who planned the trip can act.** The browser that planned it holds a secret token (its hash is stored); a shared link can look, including at the agent's work, but cannot confirm, pay, close or start the agent.

Permanent tests (`npm test`, about 105, all against the real engine, ledger, gate, tools and loop; only PayPal's HTTP, the models and the data services are stand-ins, and the PayPal fake answers in the shape of recorded sandbox responses) include: no confirmation means no money moves; a model that never reads the terms cannot cancel anything; a model that submits over its limit is blocked and the change waits for you; one model call cannot do the task (the record shows the rounds); the seven attacks from the review; forged and replayed webhooks; and a real-browser run through both flows.

<!-- EVAL:BEGIN -->
<!-- EVAL:END -->

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

Deploy: `npx wrangler secret put PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, optionally `JUDGE_CODE` and `PAYPAL_WEBHOOK_ID` (the id of a sandbox webhook pointing at `/api/webhooks/paypal`), then `npm run deploy`. Settings in `wrangler.jsonc`: `AGENT_MODEL` (`gemma` or `oss`), `AGENT_FALLBACK`, `WAKE_EVERY_MS`, `AI_DAILY_NEURONS` (the agent's daily spend guard, about US$1 at the default).

### Trying the hosted demo

1. Open the demo, press a sample trip, check the date, and press **Plan my trip**.
2. The card shows the money and the **limits** you are about to sign (refund up to, raise the plan by up to, until). Keep them or change them and press **Update limits**.
3. Press the PayPal button and log in with the sandbox buyer from the Devpost **Testing instructions**. Approving places the hold and signs the limits.
4. Open **Booking terms**, press **Use a sample**, **Save terms** (the sample is written with dates from your trip).
5. Press **Fast-forward to the next check (simulated storm)**. Watch the work trail: the agent reads the terms and quotes the sentence it relied on, finds real indoor places, tries options, and swaps the boat tour on its own because it is inside your limits. Then press **Verify against PayPal**.
6. To see the other path, set a small refund limit in step 2: the same request stops, shows why, and moves nothing until you confirm.

The public demo is rate limited per visitor, per day, and by an AI spend guard; the testing instructions include a judge code that lifts the per-visitor limits (open the demo with `?judge=<code>`).

## Known limits

- **Sandbox only; one payer.** The trip's shares are computed per person, but one PayPal account holds the money.
- **PayPal's honor period.** PayPal guarantees the funds of an authorization for 3 days and keeps it valid for 29. Wayledger places the hold no earlier than 26 days before the trip's last day, shows when it is valid until, and reads its expiry; it does **not** reauthorize. A trip closed long after its end, or a buyer whose funds are gone after day 3, can make the final capture fail, and the app then says so and charges nothing.
- **Prices of new places are not looked up** (no free source exists). A new place is priced like the item it replaces or at a price you write, and the screen says so.
- **The self-wake needs a Durable Object alarm**; the demo button runs the same code path with a simulated storm.

## License

MIT - see [LICENSE](LICENSE).
