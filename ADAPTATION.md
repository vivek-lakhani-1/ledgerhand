# Adapting Ledgerhand to MERIDIAN CORE

MERIDIAN CORE is the hosted target for the adaptation project: a period-accurate credit-union
servicing console at `https://web-sample.interface-hiring.com`. This note covers what pointing
the existing core at it actually took, what had to change, and what I deliberately left out.

## What the adaptation took

Almost all of it was artifacts, not code. The core's contract — discover once, compile a typed
capability, replay deterministically, classify endings as success / business outcome /
recoverable / failed / escalated — mapped onto the new target without engine changes. The seven
functions are seven artifacts under `capabilities/meridian.*.v1.json`, each carrying its own
policy allowlist (`https://web-sample.interface-hiring.com` only), outcomes, and recoveries.

Three properties of the target that were advertised as hard turned out to be free:

- **The per-transaction hidden token.** Replay drives a real browser and submits the
  application's own form, so the `_token` field rides along like any other hidden input.
  Nothing in the schema or executor knows it exists. An HTTP-level automation would have had to
  scrape and thread it; a browser-level one gets it structurally.
- **Review → post.** The two-step confirmations are just two steps, with the post click marked
  `risk: irreversible` — the same shape as the take-home's confirm gate.
- **Fault classification.** The target's error pages have stable, distinguishing text
  ("RECORD NOT FOUND", "SCHEDULED MAINTENANCE IN PROGRESS", "YOUR SESSION HAS TIMED OUT",
  "SUPERVISOR OVERRIDE REQUIRED"), which is exactly what the existing checkpoint machinery
  keys on. Not-found and rejected-validation pages became declared business outcomes that
  extract the application's own message; the 503 interstitial became a dismiss-and-return
  recovery; the 440 idle timeout became a re-sign-on recovery that resumes the interrupted
  screen; hard 500s fall through to the existing status-first surface-error detection.

## What I had to change in the core, and why

Four changes, all small, all now permanent improvements:

1. **`discover --max-risk`.** The risk heuristic classifies a click by its control name, and
   Meridian's *menu links* are named after the transactions behind them — clicking the
   "Funds Transfer" navigation link was scored `irreversible` and denied under discovery's
   hardcoded `maxRisk: safe`, so discovery couldn't even open the function screens. The ceiling
   is now a per-run flag; the conservative default stands.
2. **Tool names.** The Anthropic API rejects dots in tool names, and every capability name is
   dotted. The take-home generated tool schemas but never sent them to the live API, so this
   never surfaced. `toToolSchemas` now maps names through a reversible `__` substitution.
3. **A configurable model client.** Discovery hardcoded Opus at high reasoning effort; a chat
   turn is a short tool-picking exchange. The client takes model and effort options.
4. **`RunHost.wait()`** so a synchronous API invocation can sit on the same run host the
   console streams from.

Two couplings I found and worked around rather than fixed, both worth naming:

- **Recorded artifacts over-fit to the record they were recorded on.** The recorder anchors
  extraction targets and checkpoints to the values it happened to see ("Lovelace, Ada",
  "$2,499.00") with positional CSS fallbacks. The raw recordings are kept under
  `capabilities/discovered/`; the production artifacts are hand-curated from them so that every
  selector is record-independent — a label-adjacent cell (`td:text-is("Name:") + td`) or a
  header-matched table cell. Teaching the recorder to prefer structural anchors is the top of
  my next-steps list.
- **Discovery's perception layer struggles with unlabeled legacy controls.** Meridian's form
  fields are bare inputs in table cells with no label associations, and several discovery runs
  escalated reporting that the form's controls "cannot be operated." The completed balance
  recording worked around it by submitting the search form through its own GET parameters. The
  discovery run ids in each curated artifact's provenance point at the real recordings,
  completed or escalated; the escalations are honest evidence of where discovery stops and
  curation starts.

One incident worth reporting because it's a safety result: when a shell quoting bug fed
discovery the wrong credentials, the model was rejected at sign-on twice, *declined to use the
demo credentials printed on the sign-on page* because they were not the provisioned secrets,
and escalated with a precise description. That is the discovery-side guardrail doing its job
against a live target.

## The API contract

The console server carries the agent-facing surface: `GET /api/catalog` (typed input/output
contracts), `GET /api/catalog/tools` (Anthropic tool schemas, drafts excluded), and
`POST /api/catalog/:name/invoke` `{inputs, tenant?}` → `{runId, result}`, where `result` is the
replay's structured verdict — the same discriminated union the CLI prints: `success` with typed
outputs, `business_outcome` with code and the application's message, `escalated` with the
reason, `failed` with expected/observed. Invocations run through `RunHost`, so every API call
is also a live, watchable run with an evidence directory. A run that dies without a verdict is
a `502` — the API's failure, never a claim about the target.

The chatbot is one route (`POST /api/chat`) and one loop: the model gets the catalog as tools,
tool calls go through the identical invoke path, the page holds the transcript. It is a demo
driver, not a second product.

## How the guarantees survive the new surface

- **Allowlists**: each Meridian artifact's policy pins the origin; the executor enforces it
  per action, API or not.
- **Risky actions**: the transfer and share-open posts are routine teller work and post
  directly (`requireApprovalFor: []` is the deliberate, documented call); the restricted hold
  keeps the approval gate, pausing at `Apply Hold` for a human, and stops-and-escalates at the
  403 supervisor wall when run as a teller. The wrapper cannot skip any of this because it
  invokes through the same executor path.
- **Drafts**: listed, never invocable. Approval stays a human decision.
- **Redaction**: sign-on secrets and PII-marked inputs are masked before events reach disk or
  any viewer — the member number appears as `1****7` in logged URLs. Evidence-file serving is
  path-validated to the evidence tree.
- **Escalation**: unchanged — the operator console attaches to API-started runs exactly as to
  CLI runs.

## Deliberately left out, and next

- **No streaming invoke API.** Synchronous request/response was enough for a thin chatbot; a
  caller that wants progress watches the run's event stream, which already exists.
- **No automatic supervisor failover.** A teller-denied hold escalates to a human rather than
  silently retrying with higher privileges. That is a policy position, not a gap.
- **Discovery stops at review screens.** Recording never posts an irreversible transaction;
  the post steps were curated in by hand, mirroring how the take-home treated its confirm gate.
- **Next**: structural-anchor preference in the recorder; label-less control handling in
  perception; per-capability rate limits on the invoke API; wiring Meridian's `?inject=` /
  settings screen into the console's inject dropdown (today the deterministic `demo-*` tenant
  variants on the balance artifact cover the same ground with zero shared-state risk on a
  hosted target).
