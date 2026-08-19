# Design write-up

Ledgerhand gives an AI agent hands inside legacy back-office software. A model drives the UI
once to work out how a task is done; that run is compiled into a typed, versioned **capability
artifact**; the artifact is then replayed deterministically, with no model in the decision loop,
returning typed outputs to the caller. When replay can't safely proceed it hands the *live
session* to a human and takes it back.

The target is a local stand-in — a deliberately hostile 1998-era credit-union console
(`<frameset>`, table layout, `<font>` tags, no test IDs, inputs named `q`/`u`/`f1`) with two
tenants and injectable runtime faults. It is a stand-in, but it is the right *shape* of stand-in:
every design decision below was forced by something the app actually does.

---

## 1. Architecture

Single TypeScript process, files on disk, no database, no queue. The brief explicitly says not to
build scaling infrastructure, and nothing here needs it: a replay is one browser session doing one
short flow.

The seams that matter are internal:

```
discovery ──emits──▶  Capability artifact  ──consumed by──▶  replay
   │                   (typed, versioned,                      │
   │                    reviewable)                            │
   └──────────────┐                                ┌───────────┘
                  ▼                                ▼
                        Surface  (perceive / act)
                  ▲                                ▲
        WebSurface (Playwright)          [DesktopSurface — not built]
```

- **`src/schema`** — the artifact and its linter. Pure; imports no Playwright and no SDK.
- **`src/surface`** — the perceive/act seam. `types.ts` imports no Playwright *on purpose*: it is
  the interface a desktop resolver would implement.
- **`src/replay`** — the production path. Imports nothing from the Anthropic SDK, and a test
  asserts that, so "no LLM in the loop" is enforced rather than promised.
- **`src/discover`** — the only place a model exists. Behind a `ModelClient` seam, so the whole
  loop is tested with a scripted client, no key and no network.
- **`src/escalation`** — intervention store, operator server, control transfer.
- **`src/policy`**, **`src/evidence`** — cross-cutting gate and observability.

**Trade-offs.** A single process means a stuck replay holds a browser; in production this becomes
a worker with a lease, which is a deployment change, not a design change. Artifacts as files is
fine for review and diffing and would become a registry with approval workflow. Both were left
because the brief rewards a correct core over premature infrastructure.

**The load-bearing decision** is that the model never authors a locator. It picks a control by a
`ref` it was shown; the perception layer emits the descriptor from what it already observed. So
targeting quality is a property of this codebase, not of model output — and it can be tested
without a model at all.

---

## 2. Artifact schema

`Capability` (zod, `schemaVersion` + semver, `approval: draft|approved|deprecated`) carries typed
`inputs`/`outputs`, ordered `steps`, declared `outcomes`, `recoveries`, a `successCheckpoint`, a
`policy` block, `provenance`, `stability` counters, and `tenantOverrides`.

Three choices did most of the work:

**Targeting is a description, not a selector.** A `TargetDescriptor` holds semantics — role,
accessible name, `framePath`, label text, table row/column scope — plus a **ranked ladder** of
resolution strategies: `aria > label > placeholder > table_cell > text > attribute > nth_of_role
> css > coordinate`. Each carries a confidence and whether it was *captured* from the live element
or *derived*. No CSS selector is the identity. This is the seam that lets the same artifact target
a non-web surface, and replay records **which strategy won**, which is the drift signal (below).

`coordinate` exists as a genuine last resort and carries the viewport it was captured at; the
resolver refuses it outright if the viewport no longer matches. A coordinate that silently
"works" at the wrong size is worse than a clean failure.

**Checkpoints are a small predicate DSL, not code.** `text_present`, `control_present`,
`url_matches`, `all/any/not`, etc. Deliberately not Turing-complete so an artifact stays
reviewable by a human and safe to store and ship. Every state-changing step carries a
`postcondition`, which is what stops replay from assuming a click worked.

**Business outcomes are first-class members of the artifact.** `MEMBER_NOT_FOUND` is a declared
`BusinessOutcome` with a detection checkpoint and its own typed outputs — not an error string.
The brief names conflating these as the most common mistake, and the fix has to be structural: if
outcomes live in the error path, someone eventually catches one as a failure.

`sensitivity: public|pii|secret` on every input and output is load-bearing, not documentation: it
drives redaction, screenshot masking, and what is allowed to reach disk.

The artifact is decoupled from the transcript. The raw model conversation is written separately
under `evidence/.../discovery/transcript.jsonl`. The artifact is a capability; the transcript is
how it was found.

---

## 3. Determinism & error handling

Replay resolves the artifact, validates inputs against the ParamSpecs, and executes steps. No
model, no heuristics, no "try something else."

**The ordering is the design.** At every step boundary, after the action:

1. **Business outcomes first.** Evaluate declared `outcomes[].detect`. A match returns terminal
   `business_outcome` — *before anything can be called a failure*.
2. **Then recovery.** Step-level then capability-level rules, bounded per run so a session-expiry
   loop can't spin, then retry the step.
3. **Only then** the postcondition. Failure is `CHECKPOINT_FAILED`.

Result contract: `success` (typed outputs) | `business_outcome` (code + outputs) | `escalated`
(intervention id) | `failed` (class, step id, step description, expected, observed). Transient
slowness is **not** a status — it's absorbed by condition waits and retries; only exhausted
retries surface, as the underlying class.

Error classes: `INPUT_INVALID`, `POLICY_BLOCKED`, `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`,
`PRECONDITION_FAILED`, `CHECKPOINT_FAILED`, `TIMEOUT`, `SESSION_EXPIRED`, `PERMISSION_DENIED`,
`SURFACE_ERROR`, `CONTROL_LOST`, `INTERNAL`.

`PERMISSION_DENIED` appears both as an error class and as a declared outcome, deliberately:
whether a permission denial is a result the caller should handle or a hard failure is a
**per-capability decision**, expressed by whether the artifact declares it as an outcome.

`SURFACE_ERROR` keys off the transport status — any 5xx document response — rather than matching
the app's error-page wording, with content matching kept only as a fallback for legacy systems
that return a friendly error with HTTP 200. Scraping known error copy would have demoed fine and
generalised to nothing.

**Determinism on a frameset was the real work.** Verified empirically: a child frame's navigation
is *not* tracked by the page's load state — `waitForLoadState("networkidle")` returns while the
content frame is still on its previous URL, and reading it then throws *"Execution context was
destroyed."* Frame handles also go stale. Every navigating action therefore arms a frame-scoped
wait *before* dispatching and re-acquires frames by semantic path; `Promise.all([waitForLoadState,
click])` is banned repo-wide. Most "flaky replay" on this kind of app is this bug, not drift.

**A positional fallback must never produce business data.** The live discovery run exposed the
sharpest failure mode in the whole design. The model recorded the savings balance cell with a
ladder whose every rung was record-specific or positional: an `aria` match on `"1250.75"` (a
cell's accessible name *is* its value), a `table_cell` row match on the account number
`90000001`, then `nth_of_role` and a CSS path. Replayed for a member with no Savings account,
the semantic rungs correctly failed and CSS matched anyway — returning that member's *Checking*
balance, labelled `savingsBalance`, with `status: "success"`.

A confident wrong number is worse than a crash: nothing downstream can detect it. Extraction
therefore never *falls back* to a positional strategy — if a target has any semantic strategy,
positional ones are dropped and extraction fails loudly. A target whose only strategy is
positional is an author's deliberate choice (an error-message region has no better anchor) and
still resolves; screen coordinates never do. The distinction is between position as a choice and
position as a guess. Evidence run `06` is this case failing correctly.

Verified behaviours (each an injectable fault, each a test): happy path; `not_found` →
business outcome; restricted member → business outcome; validation → business outcome; slow →
success via waits; interstitial → success via recovery; session expiry → success via
re-authentication; app 500 → `SURFACE_ERROR` with expected/observed; bad input → `INPUT_INVALID`
before a browser launches; off-allowlist entry → `POLICY_BLOCKED`. Plus a determinism test: three
runs, identical outputs and identical step sequence.

---

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** `Surface` is `observe / resolve / act / readText / screenshot /
domSnapshot / captureDescriptor / lastDocumentStatus`. A desktop implementation would map
`observe` to the platform accessibility API, `resolve` to walking the same descriptor ladder
against UIAutomation/AX elements, and `act` to synthesised input — the artifact, checkpoints,
outcomes, recovery rules and result contract are unchanged. The `strategies` array is where
surface-specific knowledge lives, which is why it is a ranked list of tagged variants rather than
one string.

Honest finding from building it: accessibility-first is right, but "accessibility-only" would
have failed on this markup. Submit buttons *do* expose an accessible name from `value=`, so aria
targeting works for them. The member-ID input has no AX name, no `<label>`, no `aria-label` — its
only human-readable identifier is the adjacent `<td>` text. Table row/column relationships aren't
reliably in the AX tree either. So perception is AX-first with a DOM fallback, and the fallback
is the common case, not the exception. That is exactly why the descriptor carries a ladder.

**Multi-tenant.** Hundreds of tenants running the same vendor product means an artifact must be a
*base* plus deltas, never one recording per tenant. `target.tenant: null` marks a base artifact
for a vendor product; `tenantOverrides[tenant]` supplies an entry URL and per-step partials, deep
merged at replay time and re-validated. Demonstrated with a second tenant that relabels the same
controls ("Member ID:"→"Account Number:", "Retrieve"→"Search", "Current Balance"→"Balance (USD)")
over identical routes and field names — one artifact, both tenants.

**Drift detection is the part that scales.** Two signals, both cheap:

- Replay records which strategy won. A step that starts resolving via a *lower*-ranked strategy
  than it used to is a UI change that hasn't broken anything yet — an early warning rather than
  an outage. Surfaced as a run-end `drift.summary`.
- On `TARGET_NOT_FOUND`, re-resolve by role + nearby-text similarity; if exactly one candidate
  exists, write a **proposed** override to evidence. Never auto-applied. Auto-healing a
  bank's back office without review is not a feature.

---

## 5. Escalation & handoff

**Detecting stuck.** Discovery escalates on max steps, an explicit `request_human_help`, or a
no-progress rule (same URL and same control set three observations running) — a step cap alone
just makes a stuck agent expensive. Replay escalates on a step marked `onFailure: "escalate"`, on
an unrecoverable condition after recovery is exhausted, and on any action the policy says needs
approval.

**Taking control of the live session.** One `BrowserSession` owns the context, page and cookie
jar; a `SessionControl` records the holder. The operator claims the intervention, control
transfers to `human`, and automation immediately gets `CONTROL_LOST` on its next act. The human
drives *that* page — never a fresh one, because a fresh session wouldn't have the state that
caused the problem. Human input is forwarded into the same page, passes the **same policy gate**
(an operator cannot navigate the automation's session off the allowlist either), and every action
is recorded with a timestamp so the audit trail spans the handoff rather than stopping at it.

The intervention carries what an operator actually needs: capability and version, goal, step id
and description, reason code, expected vs observed, live URL/title, and screenshot + DOM snapshot
on disk.

**Handing back.** Resume does not blindly continue — that is the subtle failure mode, because the
human may have done the step, part of it, or nothing. The executor re-evaluates:

| State on resume | Action | Logged as |
|---|---|---|
| Postcondition already satisfied | Human completed it → advance | `postcondition_satisfied` |
| Preconditions satisfied, postcondition not | Re-run the step | `preconditions_satisfied_rerun` |
| Neither | Escalate once more, then fail — don't thrash | `escalated_again` |

**Mocked, and stated plainly:** the console's live view is a ~2 fps screenshot poll with
coordinate/keystroke forwarding, not a co-browsing stack. Production wants CDP screencast or
WebRTC with proper input channels. The *control-transfer model* — single session, explicit
holder, policy-gated and recorded human actions, checkpoint-based resume — is real and tested.

---

## 6. Safety

**Allowlist, enforced at the act layer.** Origins, path globs, action types and risk are checked
inside `Surface.act()` before any resolution or I/O, with no bypass path — not in the prompt,
where a model could argue with it. The gate **fails closed**: no resolved URL means deny. A
`framenavigated` listener re-checks navigations, so an off-allowlist *redirect* is caught too.
Human input goes through the same gate.

**Risky actions.** Every step carries `risk: safe|sensitive|irreversible`, classified at record
time and written into the artifact where a reviewer can see it. `maxRisk` is the ceiling of what
is permitted at all; `requireApprovalFor` is the subset needing a human. Default posture: in
replay an irreversible step **requires approval**; in discovery it is **blocked outright** unless
explicitly enabled. We would rather stall than post a transaction. Tested in both directions —
approving performs the action and reaches the confirmation screen; aborting leaves the
sub-account uncreated, asserted against the live page rather than the result status.

**Data handling.** A single `Redactor` sits in front of the logger, the evidence writer and the
artifact serialiser. `secret` values never reach disk; `pii` is masked; a regex sweep catches
SSNs, card numbers, long digit runs and credential assignments; screenshots mask password fields
and any target declared PII.

Two leaks found while reviewing this, both worth naming because they are the realistic ones:
values carried as **numbers** were not redacted at all — and `number`/`currency` is the normal
representation for an extracted balance or member ID, so PII went verbatim into artifacts and
logs; and the regex escape omitted `*`, so any secret containing it compiled to a quantifier and
was never matched. Both now have regression tests.

**Limits.** The allowlist is origin/path level, not semantic — it cannot express "may read
balances, may not move money"; that belongs in the capability contract and an approval workflow.
Redaction is deny-list-shaped: it protects declared and pattern-matched values, so an undeclared
PII field in a screenshot could still land in evidence. Nothing here defends against a malicious
*artifact* — artifacts are trusted input, which is why `approval` exists and why draft
capabilities are excluded from the agent-callable catalog.

---

## 7. Cuts

**Deliberately not built.** Desktop surface (designed to the seam, not implemented); real
co-browsing; multi-tenant plumbing beyond the override mechanism; queues, workers, containers,
CI; a capability registry service; authentication beyond the demo operator; a UI framework for
the console.

**Cut depth, not capability.** Every core requirement has a working thread. Where something is
thin it is thin on purpose: the operator console is one HTML file; storage is JSON on disk; the
"catalog" is a directory.

**With more time, in order:**

1. **Multi-run stability scoring gating unattended replay.** `stability` counters exist and
   `approval` exists; the missing piece is the policy that promotes draft→approved on N clean
   runs and demotes on failure. That is what makes unattended execution defensible at scale.
2. **A second real surface.** The seam is only proven by a desktop or Win32 resolver actually
   replaying an existing artifact. Until then it is a claim.
3. **Semantic policy.** Express permitted *operations* ("read balance") rather than permitted
   URLs, so the allowlist survives a vendor reorganising its routes.
4. **Bounded assisted recovery.** On `TARGET_NOT_FOUND`, allow a single policy-checked model call
   to re-identify one control, recorded as evidence and never auto-committed to the artifact.
5. **Drift dashboards across tenants.** The per-run signal exists; aggregating "step s4 now
   resolves via `text` on 12 tenants" is what turns it into an early-warning system.

**What the live run changed.** Everything above the artifact was testable without a model, and
the parts that were not are where the bugs were. One real discovery run found five: functions
transpiled with preserved names broke every DOM helper under the CLI's transpiler but not the
test runner's; a frameset's child frames were perceived before their names existed, baking a
positional `frame-1` into the artifact; the recorder attached checkpoints one step early, so a
type step asserted a state only reachable after the following click; the model declared the
happy path as a business outcome, which would have shadowed success permanently; and the
positional-fallback problem above. The lesson is not that the model behaved badly — it is that
a recording pipeline needs to *overrule* the model, and the places it must do so are only
visible against a real one.

**Known weaknesses.** The target app is ours, so it is hostile in the ways we anticipated —
a real vendor product will be hostile in ways we did not. Postcondition synthesis during
recording is heuristic and benefits from human review before an artifact is approved. And the
single genuinely untestable-by-me path is the live discovery run itself; everything downstream of
the artifact is covered by tests that need no model.
