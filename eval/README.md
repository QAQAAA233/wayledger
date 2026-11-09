# Evaluation: does the agent loop beat one call?

The question behind the two tests every AI entry has to pass: *take the model out and does anything decide?* and *could one model call do the whole job?* This folder answers the second with numbers, computed by a program from raw records, on situations the agent was not tuned for, and says plainly where the agent does not win.

## What is measured

Each **scenario** is a trip that is already booked and paid through PayPal (the fake PayPal answers in the shape of recorded sandbox responses; the forecast and place services answer the scenario's facts). Something changes: a storm, a price, someone cannot come, a message that tells the agent to ignore its limits. An approach decides, and **code** measures the result against ground truth that was written down before any model ran:

- `truth`: what the operators' terms really say, so code can count what the traveler really loses (the model only sees the pasted words and has to read them);
- `checks`: hard conditions on the final result, each a plain boolean (no outdoor activity left on the stormy day, the replacement is a real place from the search, nothing else changed, nothing lost to the operator, no money moved without the traveler's yes, ...);
- `ideal`: what a careful person would do: which finish kinds are right (executed, proposed, asked, no change), the least that has to be refunded, whether the traveler's own approval is needed;
- `oracle`: one edit that meets every check. The harness runs it through the same pipeline: **all 32 reference answers pass their checks** (`results/oracle3`), and wrong answers fail them (`results/negative3`, `results/negative2`), so the scoring is not broken and every scenario can be solved.

| Metric | Meaning |
|---|---|
| constraints met | share of runs that satisfied every hard check of their scenario |
| every repetition met | share of scenarios where all three runs satisfied them |
| ideal decision | share of runs whose finish kind is one a careful person would choose |
| refunded without need | money refunded (or proposed to be) beyond the least the scenario needs, summed |
| human approvals needed (unnecessary) | runs that ended waiting for the traveler (proposal or question); in brackets, those the ideal answer would not have needed |
| operator loss without a yes | what the operators keep because of a change that went through without the traveler's say, by the scenario's ground truth |
| no decision or error | runs that ended without any answer (a guard refused and nothing more was tried, a model failure, a time limit) |
| flip / same outcome / per-repetition sd | same-version variance: scenarios whose three runs disagree about passing, scenarios with an identical outcome in all three, spread of the pass rate between the three repetitions |

## The two approaches

- **Agent loop**: the production code, unchanged: the real engine, ledger, gate, tools and loop, started and worked off by the Durable Object alarm (`world.mjs`, `runAgent`). The model reaches it over the Workers AI REST endpoint instead of the binding; it answers in the same shape.
- **One call**: the same facts fetched the way the tools fetch them, for every trip day and every kind of place, handed over in one prompt together with the pasted terms; **one** model call that answers with the edit, what the terms say about each item it cancels or lowers, and a short note. No tool to look anything up, no way to try an option first. What it answers still goes through the same guards (a place must come from the search, a price must be the traveler's, the terms must be recorded with their sentence), the same simulator and the same gate. It gets the formatting help a retry would give (over-long text is cut; a missing document id is filled in when the quote is in exactly one document). A rejected answer cannot be repaired: that is the point of the comparison.

Models: `@cf/google/gemma-4-26b-a4b-it` (thinking off, the default) and `@cf/openai/gpt-oss-120b`, both through Workers AI, temperature 0.3, three runs per scenario.

## Scenarios and splits

32 scenarios in three splits. The agent's instructions and tools were tuned on `dev` only. `holdout` (17) was written before tuning ended, kept apart, and run after the instructions were frozen at commit `34bba8d`. `fresh` (8) was written after the first holdout result, for the second round of instructions, and run once after that commit.

| id | split | scenario |
|---|---|---|
| S01 | dev | Storm on a prepaid boat tour that is still free to cancel |
| S02 | dev | Storm, but the boat tour is non-refundable |
| S03 | dev | Storm, and the free-cancellation date has already passed |
| S04 | dev | Storm on two days: one tour is refundable, the other is not |
| S07 | dev | The Sintra trip got more expensive |
| S12 | dev | Nothing is wrong: the traveler only asks |
| S16 | dev | A message that tells the agent to ignore the limits |
| S05 | holdout | The replacement costs more than the limits allow |
| S06 | holdout | Storm, and the place search finds nothing indoors |
| S08 | holdout | The traveler found a free place to stay |
| S09 | holdout | One traveler cannot come |
| S10 | holdout | The operator gave a discount |
| S11 | holdout | The traveler lowers the budget below the plan |
| S13 | holdout | A little rain: not worth changing anything |
| S14 | holdout | Surprise us on a free day |
| S15 | holdout | The operator cancelled the boat tour |
| S17 | holdout | The pasted terms contain an instruction to the agent |
| S18 | holdout | The free-cancellation date is written the long way |
| S19 | holdout | Two changes in one message |
| S20 | holdout | A storm, but the traveler wants to keep the boat tour |
| S21 | holdout | Move an item to another day |
| S22 | holdout | Add a dinner with a price the traveler gave |
| S23 | holdout | The traveler asks about rain but no forecast exists yet |
| S24 | holdout | Heavy rain on a free outdoor walk in another city |
| S25 | fresh | Storm swap that is outside the refund limit |
| S26 | fresh | Drizzle on two days |
| S27 | fresh | Two clear changes: drop a dinner, add a free park walk |
| S28 | fresh | A fourth traveler joins |
| S29 | fresh | Dropping the apartment after the free period, with a 30 percent charge |
| S30 | fresh | The operator lowered a held price |
| S31 | fresh | A question about the weather on a stormy day |
| S32 | fresh | Cancel the boat tour for the storm and refund |

## What was run, in order, and what was changed after which result

Every change to the agent after a result is listed here, with the result that prompted it. Nothing was changed to make a number come out better after the final run of its round.

| Run (`results/`) | What it was | What followed |
|---|---|---|
| `dev0` | Pilot, first version: edits written as one list of operations that each take any of a dozen fields | Gemma sent garbled arguments (12 rejected calls in a row on a price change). `schema_probe.mjs` (output in `schema_probe.txt`): on a two-part edit the nested form was valid 0 of 5 times, one short list per kind of change 5 of 5. The edit language was changed (`remove`, `reprice`, `update`, `add`, `setTravelers`). |
| `dev0` (gpt-oss) | Same pilot | gpt-oss swapped a non-refundable boat tour without having read the terms: it lost $180 to the operator. Code now requires the pasted terms to be read before anything is cancelled or lowered, checks that a rule does not contradict its own sentence, counts what the operator keeps, and makes any change that costs the traveler money there wait for the traveler. |
| `dev1`, `dev2`, `dev3` | Dev rounds | Gemma asked instead of acting although a safe option had been simulated: "acting is the default" went into the instructions. A refusal to submit now shows the model the edit it had simulated (it kept adding an empty `update`). |
| `dev4` | Two dev scenarios re-run | The check "the plan is unchanged" was too strict for adding something free next to a non-refundable booking; it now says what matters: the booking is not cancelled, lowered or moved without the traveler's yes. |
| `holdout1` | **The frozen holdout, run once** (commit `34bba8d`) | Findings: a model asked "Cy can't come" lowered three prices by amounts it made up and refunds went out inside the limit (fixed by a host rule: a new price on an existing item must be one the traveler wrote); over-acting on light rain (S13), asking instead of doing two clear changes (S19), asking in words for permission on something outside the limits (S05). |
| `holdout2` | The same 17 scenarios after the price rule (the instructions unchanged) | Reported as "after fix". They are no longer unseen. |
| `dev5`, `fresh1`, `holdout3` | Second round of instructions (submit what is outside the limits instead of asking in words; light rain is not a reason to change a booking; never say something was changed before it was). `fresh1`: eight scenarios written after round one, run once. `dev5` and `holdout3`: the earlier scenarios again with the new instructions (seen, reported as such). | See the tables. |

Also fixed because of live runs, not the evaluation: the planner repeated its chat header and the first words of its prompt as a trip title (against the live site, `live` runs in the main README's notes); the title check now looks for those markers.

## Results

The tables are in the main [`README.md`](../README.md#evaluation-does-the-loop-beat-one-call) and in full, with per-scenario results, in `results/holdout/report.md` (round 1), `results/holdout_after_fix/report.md`, `results/fresh/report.md` (round 2) and `results/holdout_round2/report.md`. Raw records: one JSON file per run in `results/<tag>/runs/` (the scenario, the approach, the model, every model answer with its usage, the final conversation, the agent's work trail, the measured result and the checks); `results/<tag>/meta.json` holds the commit and file hashes the tag ran with; `results/*.log` are the console logs.

## What this evaluation can and cannot say

- The scenarios, their ground truth and their checks were written by the same person who built the agent. They were fixed before the run they score; the reference answers and the wrong answers show they are solvable and discriminating, but another author would write different ones.
- PayPal and the data services are stand-ins (PayPal in the shape of real sandbox responses); the live site's runs and the real-browser walkthroughs in the main README show the real services.
- Three runs per scenario and model: enough to see variance, not to rank models finely. Percentages are over 24 to 51 runs per row.
- The one-call baseline is one possible baseline, with the same guards. A stronger single prompt, or a model that thinks longer, could do better; the numbers are for these two models on these dates.
- The agent loop is not better everywhere. Where it loses (it acts when the traveler only asked a question, it asks when it could submit) the tables show it.

## Cost

Gross Workers AI cost of everything under `results/`, before the 10,000 free neurons a day: **US$2.17** (`results/spend.json`, recomputed by `node eval/spend.mjs` from the usage carried by every raw record; the running counter the harness keeps is overwritten when several runs go at once, so this recomputed figure is the one to trust). The agreed cap for the whole project was US$5 including the US$1.03 spent on the earlier premise measurements; the runs of the live site and the real-browser walkthroughs come on top (about US$0.15 by their own usage figures).

## Run it yourself

```bash
node eval/run.mjs --tag mine --split holdout --approach agent,baseline --model gemma --reps 3
node eval/report.mjs --name mine --tags mine --split holdout
node eval/run.mjs --tag oracle --approach oracle     # every reference answer must pass
node eval/run.mjs --tag negative --approach negative # every wrong answer must fail
```

It needs `CLOUDFLARE_API_TOKEN` (or a logged-in `wrangler`); `--cap` sets the spend cap in US dollars (default 2.5, counted across all tags in `results/spend.json`).
