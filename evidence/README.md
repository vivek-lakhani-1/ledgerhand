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
| `01-replay-success-alpha` | happy path, typed outputs | `success` — `savingsBalance=1250.75`, `memberName="Ada Exampleton"` |
| `02-replay-business-outcome-member-not-found` | an **expected business outcome**, not a crash | `business_outcome` — `MEMBER_NOT_FOUND` (CLI exits 0) |
| `03-replay-failure-surface-error` | a **hard failure** with a debuggable report | `failed` — `SURFACE_ERROR` at step `s3` (CLI exits 1) |
| `04-replay-success-tenant-beta` | **cross-tenant reuse**: the same base artifact plus `tenantOverrides.beta` | `success` — same balance as alpha |

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

**Not yet captured in this repo** — `ledgerhand discover` is the one step requiring
`ANTHROPIC_API_KEY`, and no key was configured when these runs were produced. Running it writes
`evidence/runs/<runId>/` in the same shape as above, plus `discovery/transcript.jsonl`: the
model's tool calls and our tool results, kept **separate from the artifact** so the capability
stays a reviewable contract rather than a model log.

The command is step 2 of the demo path in the root `README.md`. Everything downstream of the
artifact — replay, outcome classification, recovery, escalation, cross-tenant reuse — is covered
by the runs above and by the test suite, none of which need a model.
