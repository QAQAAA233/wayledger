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
