# Evidence

Curated runs demonstrating the end-to-end thread. Each directory holds:

| File | Contents |
| --- | --- |
| `capability.json` | the exact artifact the run executed (after tenant resolution) |
| `run.jsonl` | structured, **redacted** event log — one JSON object per line |
| `result.json` | the `ReplayResult` returned to the caller |
| `screenshots/` | entry, each passed checkpoint, and always on outcome/failure |
| `dom/` | DOM snapshot, written on failure and escalation |

Directory names are curated labels; the original `runId` is preserved inside every file.

## Replay runs

| Directory | Demonstrates | Result |
| --- | --- | --- |
| `00-discovery-live-llm-run` | the **real** model-driven discovery run | recorded `capabilities/member-savings-balance.discovered.v1.json` |
| `01-replay-success-alpha` | happy path, typed outputs | `success` — `savingsBalance=1250.75`, `memberName="Ada Exampleton"` |
| `02-replay-business-outcome-member-not-found` | an **expected business outcome**, not a crash | `business_outcome` — `MEMBER_NOT_FOUND` (CLI exits 0) |
| `03-replay-failure-surface-error` | a **hard failure** with a debuggable report | `failed` — `SURFACE_ERROR` at step `s3` (CLI exits 1) |
| `04-replay-success-tenant-beta` | **cross-tenant reuse**: the same base artifact plus `tenantOverrides.beta` | `success` — same balance as alpha |
| `05-replay-discovered-artifact-success` | the **discovered** artifact replaying deterministically | `success` — `savingsBalance=1250.75` |
| `06-replay-discovered-artifact-refuses-wrong-value` | refusing to guess rather than returning a wrong number | `failed` — output could not be extracted |
| `07-replay-discovered-artifact-not-found` | the discovered artifact's declared outcome firing | `business_outcome` — `MEMBER_NOT_FOUND` |

Runs 02 and 03 are the contrast the design is built around. Both are "the flow did not reach
the balance", and they are deliberately different kinds of answer:

```
02  status "business_outcome"  code MEMBER_NOT_FOUND      exit 0   → the caller handles it
03  status "failed"            class SURFACE_ERROR        exit 1   → someone gets paged
```

Run 03's `result.json` shows the failure contract carrying enough to debug without opening the log:

```json
"error": {
  "class": "SURFACE_ERROR",
  "stepId": "s3",
  "stepDescription": "Sign into the Member Services Console",
  "expected": "the target application to return a usable page",
  "observed": "HTTP 500 from http://127.0.0.1:4599/t/alpha/msc/search — … APPLICATION ERROR - REF 0x5A2"
}
```

Note `observed` leads with the **transport status**. `SURFACE_ERROR` is classified from any 5xx
document response rather than from recognising this app's particular error copy.

## Reading the log

`run.jsonl` event types: `run.start`, `step.start`, `policy.decision`, `target.resolved`,
`action.performed`, `checkpoint.evaluated`, `outcome.matched`, `recovery.applied`, `retry`,
`escalation.raised`, `human.action`, `human.resolved`, `step.end`, `drift.summary`, `run.end`.

Two are worth singling out:

- **`target.resolved`** records `resolvedBy` and every attempted strategy. A step that starts
  winning on a *lower*-ranked strategy than before is a UI change that has not broken anything
  yet.
- **`drift.summary`** aggregates that at run end.

Everything is passed through the redactor before it is written. In the logs you will see
`«redacted:secret»` where the operator password was typed and `1***1` where the PII-marked
member ID was — the raw values are in neither the log nor the artifact.

## Discovery run

`00-discovery-live-llm-run` is a real `claude-opus-5` run against the live target app — 14 tool
calls, compiled into `capabilities/member-savings-balance.discovered.v1.json` (`approval: draft`).

It carries `discovery/transcript.jsonl`: the model's tool calls and our tool results, kept
**separate from the artifact** so the capability stays a reviewable contract rather than a model
log. The transcript is redacted like everything else — the operator password appears in it as
`«redacted:secret»`, never as its value.

The artifact is recorded as `draft` on purpose. Reviewing this one showed why: the model
declared a plausible-looking output that captured a whole page of text, and its own success
criterion asserted the specific balance it happened to see. The recorder overruled the second
(see `REPORT.md` §3); the first is exactly the kind of thing a human approves or rejects before
a capability is promoted out of draft.

## Run 06 — why a failure here is the correct answer

The discovered artifact was recorded against member `10001`, who has a Savings account.
Member `10002` has Checking and Money Market, and **no Savings account at all**.

Before the extraction rule described in `REPORT.md` §3, this run returned:

```
SUCCESS  savingsBalance = 842.19      ← actually the *Checking* balance
```

The semantic strategy (`table_cell` matching the recorded account number) correctly failed,
and resolution then fell through to a positional CSS strategy which matched a different row
and returned its balance with full confidence. It now returns:

```
FAILED  Required output savingsBalance could not be extracted: source returned no value
```

For a system reading financial data, a confident wrong number is the worst possible outcome —
worse than a crash, because nothing downstream can detect it. Extraction therefore never falls
back to a positional strategy once a semantic one has failed.
