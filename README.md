# Wayledger

**Group trips where the money follows the plan.**

Wayledger turns one plain-language request ("three of us, Lisbon, four days, $1,200") into an itinerary and a budget, places one PayPal authorization hold per paid item, and keeps the money in step with the plan. When the plan changes - a storm, a cancellation, someone dropping out - an AI agent proposes the exact money difference (release a hold, refund a charge, place a new hold). **Nothing moves until a person confirms the exact amounts**, and the ledger on screen is copied from PayPal's own responses.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). All payments run in the **PayPal sandbox**; no real money moves.

- Live demo: https://wayledger.lvsyn-tw.workers.dev
- Demo video: `VIDEO_URL`

## Why this is different

Most AI checkout demos stop at "buy once". Real group plans change after the money is committed. Wayledger covers the whole lifecycle with the PayPal Orders and Payments APIs:

| Moment | PayPal call | Who decides |
|---|---|---|
| Place holds for every item (one buyer approval, itemized breakdown) | `POST /v2/checkout/orders` (`intent: AUTHORIZE`, itemized breakdown) → `/authorize` | Person approves in PayPal |
| Prepaid items (lodging) charged at booking | `POST /v2/payments/authorizations/{id}/capture` (`final_capture: false`) | Confirmed amounts |
| Item removed while only held | `POST /v2/payments/authorizations/{id}/void` | Person confirms the proposal |
| Item removed or cheaper after it was charged | `POST /v2/payments/captures/{id}/refund` (full or partial) | Person confirms the proposal |
| Item added or price rose | new authorization hold, approved in PayPal | Person approves in PayPal |
| "Is the ledger right?" | `GET` every authorization, capture and refund and compare | Anyone, one click |

## How the agent is kept honest

The design rule is: **the model decides, the tools are hands and eyes, the code guards the hard rules.**

- **The model has no money tools.** It can only return a plan, or a list of plan edits (`remove`, `reprice`, `add`). `src/ai.js`
- **Code, not the model, computes the money difference** from the plan edit and the ledger. `src/domain/delta.js`
- **A proposal is the only way money can move.** It carries a digest of its exact actions, a cap and a 15-minute expiry. A confirmation counts only for the digest the person was shown; every PayPal money call re-checks "confirmed, untampered, unexpired, in the proposal, under the cap". `src/domain/proposal.js`
- **The ledger is append-only and copied from PayPal.** After every write we re-read the resource from PayPal and store *its* amount and status. If PayPal reports a different amount than the confirmed one, nothing is recorded or released. `src/paypal.js`, `src/domain/ledger.js`
- **Failures never move money silently.** A model error or invalid answer produces a visible reason and no proposal. A PayPal error mid-way stops the run, keeps what succeeded, and offers a retry that repeats only what is missing (idempotent `PayPal-Request-Id`s). `src/engine.js`
- **One trip = one Durable Object**, requests serialized, plan switches only after every step of its proposal succeeded.

Permanent tests guard the two promises that matter: *no confirmation means no money moves* and *the ledger equals what PayPal returned* (`test/`).

## Architecture

```
public/            single-page UI (vanilla JS, AG Grid Community for budget + ledger, PayPal JS SDK buttons)
src/index.js       Worker routes, TripDO (one per trip), Quota DO (per-visitor + daily demo limits)
src/engine.js      createTrip / requestChange / confirm / order / approve / retry / reconcile
src/ai.js          Cloudflare Workers AI (Llama 3.3 70B, JSON-schema output, one corrective retry)
src/paypal.js      PayPal REST client (Orders v2, Payments v2) returning ledger facts
src/domain/        plan rules, money delta, proposal guard, ledger (pure, no I/O)
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
npm test             # permanent tests, no network needed
```

Deploy: `npx wrangler secret put PAYPAL_CLIENT_ID`, `npx wrangler secret put PAYPAL_CLIENT_SECRET`, `npm run deploy`.

### Trying the hosted demo

Open the demo, press a sample trip, then press the PayPal button on the proposal card and log in with the PayPal Sandbox buyer credentials provided in the Devpost submission's **Testing instructions** (or any personal PayPal Sandbox buyer account). The public demo is rate limited per visitor and per day.

## License

MIT - see [LICENSE](LICENSE).
