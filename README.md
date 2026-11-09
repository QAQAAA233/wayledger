# Wayledger

**Group trips where the money follows the plan.**

Wayledger turns one plain-language request ("three of us, Lisbon, four days, $1,200") into an itinerary and a budget, places a PayPal **Trip Reserve** authorization with a quota for each item, and keeps the money in step with the plan. When the plan changes - a storm, a cancellation, someone dropping out - an AI agent proposes the exact money difference (free item quota back to the trip reserve, allocate from free reserve or open a new hold, refund a captured charge). At the end of the trip, **Close trip** captures all remaining held items and voids any unused reserve in PayPal. **Nothing moves until a person confirms the exact amounts**, and the ledger is verified directly against PayPal's API.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). All payments run in the **PayPal sandbox**; no real money moves.

- Live demo: https://wayledger.lvsyn-tw.workers.dev
- Demo video: `VIDEO_URL`

## Why this is different

Most AI checkout demos stop at "buy once". Real group plans change after the money is committed. Wayledger models a PayPal authorization as a **Trip Reserve** and items as quotas under that reserve, covering the full payment lifecycle (`authorize`, `capture`, `void`, `refund`) with zero mismatch between the UI and PayPal:

| Moment | Action & PayPal call | Who decides |
|---|---|---|
| First checkout: place Trip Reserve & item quotas | `POST /v2/checkout/orders` (`intent: AUTHORIZE`, itemized breakdown) → `/authorize` | Person approves in PayPal |
| Prepaid items (lodging) charged at booking | `POST /v2/payments/authorizations/{id}/capture` (`final_capture: false`) | Confirmed amounts |
| Uncaptured (`held`) item removed | Quota is released back into the Trip Reserve (no premature PayPal void; unused reserve is voided at trip close) | Person confirms the proposal |
| Item added or price rose | Covered by free Trip Reserve quota (`allocate`), or opens a new PayPal authorization (`hold`) if reserve is exceeded | Person confirms (and approves in PayPal if a new authorization is needed) |
| Captured (`paid`) item removed or cheaper | `POST /v2/payments/captures/{id}/refund` (full or partial) | Person confirms the proposal |
| **Close trip** | `POST /v2/payments/authorizations/{id}/capture` for all kept held items, then `POST /v2/payments/authorizations/{id}/void` for any unused reserve | Person confirms the close proposal |
| "Does the ledger match PayPal?" | Object-level reconciliation: `GET` every authorization (status, amount, captured total, active status for any held items), capture, and refund | Anyone, one click |

## How the agent is kept honest

The design rule is: **the model decides, the tools are hands and eyes, the code guards the hard rules.**

- **The model has no money tools.** It can only return a plan, or a list of plan edits (`remove`, `reprice`, `add`). `src/ai.js`
- **Code, not the model, computes the money difference** from the plan edit, item quotas, and open Trip Reserves. `src/domain/delta.js`
- **A proposal is the only way money or quotas can move.** It carries a digest of its exact actions, a cap and a 15-minute expiry. A confirmation counts only for the digest the person was shown; every step re-checks "confirmed, untampered, unexpired, in the proposal, under the cap". `src/domain/proposal.js`
- **The ledger is append-only and reconciled at the object level.** After every PayPal write we re-read the resource from PayPal and store *its* amount and status. Reconciliation checks every authorization's status, amount, and captured total, and verifies that any `HELD` item is backed by an active, non-voided PayPal authorization. `src/paypal.js`, `src/domain/ledger.js`
- **Failures never move money silently.** A model error or invalid answer produces a visible reason and no proposal. A PayPal error mid-way stops the run, keeps what succeeded, and offers a retry that repeats only what is missing (idempotent `PayPal-Request-Id`s). `src/engine.js`
- **One trip = one Durable Object**, requests serialized, plan switches only after every step of its proposal succeeded.

Permanent tests guard the promises that matter: *no confirmation means no money moves* and *the ledger equals what PayPal returned, including flagging any HELD item on a VOIDED authorization* (`test/`).

## Architecture

```
public/            single-page UI (vanilla JS, AG Grid Community for budget + ledger, PayPal JS SDK buttons)
src/index.js       Worker entry and the two Durable Object classes (TripDO: one per trip, Quota: demo limits)
src/api.js         Routes and the demo allowance (per visitor, per day, judge code)
src/trip-runner.js Serializes calls on one trip; plain data in, plain data out
src/quota.js       Fixed-window counters
src/engine.js      createTrip / requestChange / closeTrip / confirm / order / approve / refresh / retry / reconcile
src/ai.js          Cloudflare Workers AI (Llama 3.3 70B, JSON-schema output, one corrective retry)
src/paypal.js      PayPal REST client (Orders v2, Payments v2) returning ledger facts
src/domain/        plan rules, money delta (reserves + quotas + close), proposal guard, ledger (pure, no I/O)
test/              node:test suites (PayPal replaced by an HTTP-level fake only inside tests)
```

## Run it yourself

Requirements: Node 20+, a free Cloudflare account (Workers AI free tier), a PayPal developer account (free sandbox).

```bash
git clone <this repo> && cd wayledger
npm install
# PayPal sandbox app credentials: https://developer.paypal.com/dashboard/applications/sandbox
printf 'PAYPAL_CLIENT_ID=...\nPAYPAL_CLIENT_SECRET=...\n' > .dev.vars
npx wrangler login
npm run dev          # http://localhost:8787
npm test             # permanent tests: engine, routes, and a real-browser run (needs Chrome; set CHROME_PATH if not found)
```

Deploy: `npx wrangler secret put PAYPAL_CLIENT_ID`, `npx wrangler secret put PAYPAL_CLIENT_SECRET`, `npm run deploy`.

### Trying the hosted demo

Open the demo, press a sample trip, then press the PayPal button on the proposal card and log in with the PayPal Sandbox buyer credentials provided in the Devpost submission's **Testing instructions** (or any personal PayPal Sandbox buyer account). The public demo is rate limited per visitor and per day; the testing instructions include a judge code that lifts those limits (open the demo with `?judge=<code>`).

## License

MIT - see [LICENSE](LICENSE).
