# Evidence

Curated runs showing the thread end to end. Each directory has:

* `capability.json` - the artifact the run executed, after tenant resolution
* `run.jsonl` - structured, redacted event log, one JSON object per line
* `result.json` - the `ReplayResult` returned to the caller
* `screenshots/` - entry, each passed checkpoint, and always on outcome or failure
* `dom/` - DOM snapshot, written on failure and escalation

Directory names are labels I added; the original `runId` is still inside every file.

## The runs

`00-discovery-live-llm-run` is a real `claude-opus-5` run against the live app, 14 tool calls,
compiled into `capabilities/member-savings-balance.discovered.v1.json`.

`01-replay-success-alpha` is the happy path, `savingsBalance=1250.75` and
`memberName="Ada Exampleton"`.

`02-replay-business-outcome-member-not-found` returns `MEMBER_NOT_FOUND` and exits 0.

`03-replay-failure-surface-error` fails with `SURFACE_ERROR` at step `s3` and exits 1.

`04-replay-success-tenant-beta` runs the same base artifact against the other tenant via
`tenantOverrides.beta` and gets the same balance.

`05-replay-discovered-artifact-success` replays the discovered artifact.

`06-replay-discovered-artifact-refuses-wrong-value` fails on purpose. See below.

`07-replay-discovered-artifact-not-found` is the discovered artifact's own declared outcome
firing.

Runs 02 and 03 are the contrast the whole design is built around. Both are "we didn't get the
balance", and they're deliberately different kinds of answer:

```
02  business_outcome  MEMBER_NOT_FOUND   exit 0   caller handles it
03  failed            SURFACE_ERROR      exit 1   somebody gets paged
```

Run 03's `result.json` carries enough to debug without opening the log:

```json
"error": {
  "class": "SURFACE_ERROR",
  "stepId": "s3",
  "stepDescription": "Sign into the Member Services Console",
  "expected": "the target application to return a usable page",
  "observed": "HTTP 500 from http://127.0.0.1:4599/t/alpha/msc/search ... APPLICATION ERROR - REF 0x5A2"
}
```

`observed` leads with the transport status. `SURFACE_ERROR` comes from any 5xx document
response, not from recognising this app's error copy.

## Reading run.jsonl

Event types: `run.start`, `step.start`, `policy.decision`, `target.resolved`, `action.performed`,
`checkpoint.evaluated`, `outcome.matched`, `recovery.applied`, `retry`, `escalation.raised`,
`human.action`, `human.resolved`, `recorder.outcome_dropped`, `drift.summary`, `step.end`,
`run.end`.

Two are worth pulling out. `target.resolved` records `resolvedBy` plus every attempted strategy,
so a step that starts winning on a lower-ranked strategy is a UI change that hasn't broken
anything yet. `drift.summary` aggregates that at run end.

Everything is redacted before it's written. You'll see `«redacted:secret»` where the operator
password was typed and `1***1` where the PII-marked member id was. The raw values aren't in the
log or the artifact.

## Run 06, and why failing is the right answer

The artifact was recorded against member `10001`, who has a Savings account. Member `10002` has
Checking and Money Market and no Savings account at all.

Before the extraction rule in `REPORT.md` §3, this run returned:

```
SUCCESS  savingsBalance = 842.19      <- actually the Checking balance
```

The semantic strategy (a `table_cell` row match on the recorded account number) failed correctly,
then resolution fell through to a CSS position, matched a different row, and returned its balance
with full confidence. Now it returns:

```
FAILED  Required output savingsBalance could not be extracted: source returned no value
```

A wrong number that looks right is worse than a crash, because nothing downstream can catch it.

## About the discovered artifact

It's recorded as `draft`, and reviewing it shows why that state exists. The model declared a
plausible-looking output that captured a whole page of text, and its own success criterion
asserted the specific balance it happened to see. The recorder overruled the second one. The
first is the kind of thing a human accepts or rejects before a capability gets promoted.

The transcript lives in `discovery/transcript.jsonl`, separate from the artifact, so the
capability stays a reviewable contract rather than a model log.
