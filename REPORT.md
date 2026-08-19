# Design write-up

A model drives a legacy UI once to work out how a task is done. That run gets compiled into a
typed, versioned capability artifact. The artifact is then replayed with no model in the loop,
returning typed outputs to the caller. If replay can't safely finish, it hands the live session
to a human and takes it back afterwards.

The target is a local stand-in: a 1998-era credit union console with framesets, table layout,
no test ids, and inputs named `q` and `f1`. It's fake, but it's fake in the right ways. Every
decision below was forced by something the app actually does.

## 1. Architecture

One TypeScript process, files on disk, no database, no queue. A replay is one browser session
doing one short flow, so there's nothing to scale yet.

The seams that matter are internal:

* `src/schema` is the artifact and its linter. Pure, no Playwright, no SDK.
* `src/surface` is the perceive/act seam. `types.ts` imports no Playwright on purpose, because
  it's the interface a desktop resolver would implement.
* `src/replay` is the production path. It has no Anthropic import and a test enforces that.
* `src/discover` is the only place a model exists, behind a `ModelClient` seam so the loop can
  be tested with a scripted client.
* `src/escalation` holds the intervention store, operator server and control transfer.
* `src/policy` and `src/evidence` are the gate and the observability.

A single process means a stuck replay holds a browser. In production that becomes a worker with
a lease, which is deployment work rather than design work. Artifacts as files is fine for review
and diffing and would become a registry with an approval workflow.

The decision everything else hangs off: the model never writes a locator. It picks a control by
a ref it was shown, and the perception layer emits the descriptor from what it already saw. So
targeting quality is a property of this code, not of model output, and it can be tested with no
model at all.

## 2. Artifact schema

`Capability` is zod, versioned with semver, and carries an approval state, typed inputs and
outputs, ordered steps, declared outcomes, recovery rules, a success checkpoint, a policy block,
provenance, stability counters and tenant overrides.

Three choices did most of the work.

**Targets are described, not selected.** A `TargetDescriptor` holds semantics (role, accessible
name, frame path, label text, table row and column scope) plus a ranked ladder of resolution
strategies: aria, label, placeholder, table_cell, text, attribute, nth_of_role, css, coordinate.
Each carries a confidence and whether it was captured off the live element or derived. No CSS
selector is the identity. That's what lets the same artifact target a different kind of surface,
and it means replay can report which strategy won.

`coordinate` is a real last resort and carries the viewport it was captured at. The resolver
refuses it if the viewport no longer matches, because a coordinate that quietly "works" at the
wrong size is worse than a clean failure.

**Checkpoints are a small predicate DSL, not code.** `text_present`, `control_present`,
`url_matches`, `all`/`any`/`not`. Not Turing-complete, so an artifact stays reviewable by a human
and safe to store. Every state-changing step carries a postcondition, which is what stops replay
assuming a click worked.

**Business outcomes are members of the artifact.** `MEMBER_NOT_FOUND` is a declared outcome with
a detection checkpoint and its own typed outputs, not an error string. If outcomes live in the
error path then sooner or later somebody catches one as a failure.

`sensitivity` on every input and output (`public`, `pii`, `secret`) drives redaction, screenshot
masking and what's allowed to reach disk. It isn't documentation.

The artifact is decoupled from the transcript. The raw model conversation is written separately
under `evidence/.../discovery/transcript.jsonl`. The artifact is a capability; the transcript is
how it was found.

## 3. Determinism and error handling

Replay resolves the artifact, validates inputs against the param specs, and executes steps. No
model, no heuristics, no trying something else.

The ordering is the design. After each action:

1. Evaluate declared business outcomes. A match returns a terminal `business_outcome`, before
   anything can be called a failure.
2. Then recovery rules, step-level first, bounded per run so a session-expiry loop can't spin.
3. Only then the postcondition. Failure is `CHECKPOINT_FAILED`.

The result is one of `success` with typed outputs, `business_outcome` with a code, `escalated`
with an intervention id, or `failed` with a class, step id, description, expected and observed.
Transient slowness isn't a status; waits and retries absorb it, and only exhausted retries
surface, as whatever the underlying class was.

Error classes: `INPUT_INVALID`, `POLICY_BLOCKED`, `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`,
`PRECONDITION_FAILED`, `CHECKPOINT_FAILED`, `TIMEOUT`, `SESSION_EXPIRED`, `PERMISSION_DENIED`,
`SURFACE_ERROR`, `CONTROL_LOST`, `INTERNAL`.

`PERMISSION_DENIED` is deliberately both an error class and a possible declared outcome. Whether
a permission denial is something the caller handles or a hard failure is a per-capability
decision, and the artifact expresses it by declaring the outcome or not.

`SURFACE_ERROR` keys off the transport status, any 5xx document response, with content matching
kept only as a fallback for legacy systems that return a friendly error page with HTTP 200.
Matching known error copy would have demoed fine and generalised to nothing.

Getting determinism on a frameset was the actual work. A child frame's navigation isn't tracked
by the page's load state: `waitForLoadState("networkidle")` comes back while the content frame is
still on its old URL, and reading it then throws "Execution context was destroyed". Frame handles
also go stale. So every navigating action arms a frame-scoped wait before dispatching and
re-acquires frames by name afterwards, and `Promise.all([waitForLoadState, click])` is banned in
this repo. Most flaky replay on this kind of app is that bug, not drift.

### Never fall back to a position for business data

The live discovery run turned up the sharpest failure in the design. The model recorded the
savings balance cell with a strategy ladder where every rung was record-specific or positional:
an aria match on `"1250.75"` (a cell's accessible name is its value), a `table_cell` row match on
account number `90000001`, then `nth_of_role`, then a CSS path. Replayed for a member with no
Savings account, the semantic rungs correctly failed and CSS matched anyway. It returned that
member's *Checking* balance as `savingsBalance`, with `status: "success"`.

A confident wrong number is worse than a crash, because nothing downstream can tell. So
extraction never falls back to a positional strategy: if a target has any semantic strategy, the
positional ones are dropped and extraction fails loudly when the semantic ones do. A target whose
only strategy is positional still resolves, because that's an author's deliberate choice and an
error-message region has no better anchor. The line is between position as a choice and position
as a guess. Evidence run `06` is this failing correctly.

Behaviours verified, each an injectable fault and each a test: happy path; not found as a
business outcome; restricted member as a business outcome; validation as a business outcome; slow
absorbed by waits; interstitial recovered; session expiry re-authenticated; a 500 as
`SURFACE_ERROR` with expected and observed; bad input rejected before a browser launches;
off-allowlist entry blocked. Plus three identical runs producing identical outputs and step
sequences.

## 4. Heterogeneity and multi-tenant

`Surface` is `observe`, `resolve`, `act`, `readText`, `screenshot`, `domSnapshot`,
`captureDescriptor`, `lastDocumentStatus`. A desktop implementation maps `observe` to the platform
accessibility API, `resolve` to walking the same descriptor ladder against UIAutomation elements,
and `act` to synthesised input. The artifact, checkpoints, outcomes, recovery rules and result
contract don't change. Surface-specific knowledge lives in the `strategies` array, which is why
it's a ranked list of tagged variants rather than one string.

Worth being straight about what accessibility-first bought here. Submit buttons do expose an
accessible name through `value=`, so aria targeting works for them. The member id input has no AX
name, no `<label>` and no `aria-label`; its only human-readable identifier is the adjacent `<td>`
text. Table row and column relationships aren't reliably in the AX tree either. So perception is
AX-first with a DOM fallback, and on this markup the fallback is the common case rather than the
exception. That's the reason the descriptor carries a ladder in the first place.

For multi-tenant, an artifact has to be a base plus deltas, never one recording per tenant.
`target.tenant: null` marks a base artifact for a vendor product and `tenantOverrides[tenant]`
supplies an entry URL and per-step partials, deep merged at replay time and re-validated. The
second tenant relabels the same controls over identical routes and field names, and one artifact
covers both.

Drift detection is the part that has to scale, and there are two cheap signals. Replay records
which strategy won, so a step that starts resolving via a lower-ranked strategy is a UI change
that hasn't broken anything yet, reported as a run-end `drift.summary`. And on
`TARGET_NOT_FOUND`, re-resolving by role and nearby-text similarity will sometimes find exactly
one candidate, which gets written to evidence as a proposed override. It's never applied.
Auto-healing a bank's back office without review isn't a feature.

## 5. Escalation and handoff

Discovery escalates on max steps, an explicit `request_human_help`, or a no-progress rule (same
URL and same control set three observations running). A step cap on its own just makes a stuck
agent expensive. Replay escalates on a step marked `onFailure: "escalate"`, on an unrecoverable
condition once recovery is exhausted, and on any action policy says needs approval.

One `BrowserSession` owns the context, page and cookie jar, and a `SessionControl` records the
holder. The operator claims the intervention, control transfers, and automation gets
`CONTROL_LOST` on its next act. The human drives that page, never a fresh one, because a fresh
session wouldn't have the state that caused the problem. Human input goes through the same policy
gate, so an operator can't navigate the automation's session off the allowlist either, and every
action is recorded with a timestamp so the audit trail survives the handoff.

The intervention carries what an operator needs: capability and version, goal, step id and
description, reason code, expected against observed, live URL and title, and a screenshot plus
DOM snapshot on disk.

Handing back is where the subtlety is, because the human may have done the step, part of it, or
nothing. So resume re-evaluates rather than continuing. If the postcondition already holds, the
human finished it and we advance. If preconditions hold but the postcondition doesn't, we re-run
the step. If neither, escalate once more rather than thrash. The branch taken is logged as
`resumeBranch`.

Mocked on purpose: the console's live view is a 2fps screenshot poll with coordinate and
keystroke forwarding, not a co-browsing stack. Production wants CDP screencast or WebRTC with
proper input channels. The control-transfer model is real and tested.

## 6. Safety

The allowlist is enforced inside `Surface.act()`, before any resolution or I/O, with no bypass
path. Not in the prompt, where a model could argue with it. It fails closed, so no resolved URL
means deny, and a `framenavigated` listener re-checks navigations so an off-allowlist redirect is
caught too. Human input goes through the same gate.

Every step carries a risk level, classified at record time and written into the artifact where a
reviewer can see it. `maxRisk` is the ceiling of what's permitted at all and `requireApprovalFor`
is the subset needing a human. In replay an irreversible step requires approval; in discovery
it's blocked outright unless explicitly enabled. Stalling beats posting a transaction. Both
directions are tested: approving performs the action and reaches the confirmation screen,
aborting leaves the sub-account uncreated, and both assert against the live page rather than the
result status.

One `Redactor` sits in front of the logger, the evidence writer and the artifact serialiser.
Secrets never reach disk, PII is masked, a regex sweep catches SSNs, card numbers, long digit runs
and credential assignments, and screenshots mask password fields and any target declared PII. Two
leaks turned up while reviewing it, both realistic. Values carried as numbers weren't redacted at
all, and `number` is exactly what an extracted balance or member id is, so PII went verbatim into
artifacts and logs. And the regex escape omitted `*`, so a secret containing one compiled to a
quantifier and never matched.

Limits. The allowlist is origin and path level, not semantic, so it can't express "may read
balances, may not move money"; that belongs in the capability contract and an approval workflow.
Redaction is deny-list shaped, protecting declared and pattern-matched values, so an undeclared
PII field in a screenshot could still reach evidence. And nothing here defends against a malicious
artifact, because artifacts are trusted input. That's why `approval` exists and why draft
capabilities are excluded from the agent-callable catalog.

## 7. Cuts

Not built: a desktop surface (designed to the seam, not implemented), real co-browsing,
multi-tenant plumbing beyond the override mechanism, queues, workers, containers, CI, a registry
service, auth beyond the demo operator, and a UI framework for the console.

Every core requirement has a working thread. Where something is thin it's thin deliberately: the
operator console is one HTML file, storage is JSON on disk, the catalog is a directory.

What a real discovery run changed is worth recording, because everything above the artifact was
testable without a model and the parts that weren't are exactly where the bugs were. One run
found five. Functions transpiled with preserved names broke every DOM helper under the CLI's
transpiler but not the test runner's. A frameset's children were perceived before their names
existed, baking a positional `frame-1` into the artifact. The recorder attached checkpoints one
step early, so a type step asserted a state only reachable after the following click. The model
declared the happy path as a business outcome, which would have shadowed success permanently. And
the positional-fallback problem in section 3. The lesson isn't that the model behaved badly. It's
that a recording pipeline has to be able to overrule the model, and the places where it must are
only visible against a real one.

Next, in order:

1. Multi-run stability scoring gating unattended replay. The counters and the approval state both
   exist; what's missing is the policy that promotes draft to approved after N clean runs and
   demotes on failure.
2. A second real surface. The seam is only proven once a desktop resolver replays an existing
   artifact. Until then it's a claim.
3. Semantic policy, expressing permitted operations rather than permitted URLs, so the allowlist
   survives a vendor reorganising its routes.
4. Bounded assisted recovery: on `TARGET_NOT_FOUND`, one policy-checked model call to re-identify
   a single control, recorded as evidence and never auto-committed.
5. Drift aggregation across tenants. The per-run signal exists; "step s4 now resolves via `text`
   on 12 tenants" is what turns it into an early warning.

Known weaknesses. The target app is ours, so it's hostile in the ways we anticipated and a real
vendor product will be hostile in ways we didn't. Postcondition synthesis during recording is
heuristic and benefits from review before an artifact is approved. And the discovery run is the
one path that can't be covered by tests; everything downstream of the artifact is.
