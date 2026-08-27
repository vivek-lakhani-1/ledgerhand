# Ledgerhand

A model drives a legacy UI once to figure out how a task is done. That run gets compiled into a
typed capability artifact, which is then replayed with no model in the loop: typed inputs and
outputs, declared business outcomes kept separate from failures, and a handoff to a human when
replay can't safely continue.

The target app is a local stand-in for a legacy bank console. It's built to be awkward on
purpose - framesets, table layout, no test ids - rather than to look like a real banking
service. A catalog and CLI expose saved capabilities so an agent could call them by name.

Design notes are in [REPORT.md](REPORT.md). Saved runs are in [evidence/](evidence/).

## Setup

Requirements: Node 20.

```bash
nvm use 20
npm install
npx playwright install chromium
cp .env.example .env
```

The CLI is available through the npm scripts. For the copy-pasteable commands below, define the local command once from the repository root:

```bash
ledgerhand() { npx --no-install tsx src/cli/index.ts "$@"; }
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Only for `discover` | Credentials for the one-time model-driven discovery run. |
| `TARGET_APP_PORT` | No | Default target-app port, `4599`. |
| `OPERATOR_PORT` | No | Default operator-console port, `4610`. |
| `CONSOLE_PORT` | No | Default run-console port, `4620`. |
| `APP_USER` | No | Local stand-in operator ID, default `OPER01`. |
| `APP_PASSWORD` | No | Local stand-in password, default `demo-pass-01`. |
| `MERIDIAN_OPERATOR` / `MERIDIAN_PASSWORD` | For Meridian replays | Meridian Core teller sign-on, `teller1` / `password` (public demo credentials). |
| `MERIDIAN_HOLD_OPERATOR` / `MERIDIAN_HOLD_PASSWORD` | For the hold capability | Operator profile the hold capability signs on as; `super1` completes, `teller1` demonstrates the escalation. |
| `CHAT_MODEL` | No | Model behind the console's Chat tab, default `claude-sonnet-5`. |

Replay, catalog, invoke, the target app, the run console, and the operator console run without
`ANTHROPIC_API_KEY`. The console's Discover tab disables itself, with the reason shown, when the key
is absent.

## Watching a run: the console

The CLI runs one capability and prints the result after the fact. The console runs the same code
and streams what it is doing while it happens, which is the faster way to see why a run went wrong.

```bash
ledgerhand app --port 4599      # terminal 1
ledgerhand console --port 4620  # terminal 2
```

Open <http://127.0.0.1:4620>. The left column picks what to run; the right column is the live view:

- **Live frame** — a screenshot of the automated browser, refreshed about once a second, and held
  on the last frame when a run ends so a failing page stays on screen instead of going blank.
- **Timeline** — every event the run emits, as it emits it. Rows expand to the raw JSON, and the
  ones that explain a failure expand themselves: a denied `policy.decision`, a `checkpoint.evaluated`
  that came back false, a step that ended `✗`. Turn off **Verbose** to hide the per-action
  mechanics and leave just the step narrative.
- **Result** — the same verdict the CLI prints, including expected/observed on a failure, the exit
  code, and the evidence directory.

Events reach the page through the same `RunLogger` the log file uses, after redaction, so the panel
can never show a secret the log would have masked.

The **Discover** tab runs the model against a goal instead of replaying an artifact, and the
timeline shows the model's stated reason for each action it takes. It spends API credits per step,
so it has a step cap and a **Stop** button that ends the run immediately — including a run parked
on an escalation.

Everything below still works from the CLI, and the CLI remains the scriptable path with meaningful
exit codes.

The **Chat** tab is a thin conversational front door over the capability API: type a request in
plain language, the model picks a capability from the catalog and invokes it, and each invocation
appears as a chip that jumps to its live run. It uses the same guardrailed invoke path as every
other caller, so it cannot reach anything the API would refuse.

## MERIDIAN CORE: the hosted adaptation target

`capabilities/meridian.*.v1.json` point the same core at MERIDIAN CORE, a hosted legacy
credit-union servicing console at `https://web-sample.interface-hiring.com` — server-rendered
HTML, table layout, a per-transaction hidden token, and injectable runtime faults. There is no
local app to start; the capabilities drive the live site. The write-up of what the adaptation
took is in [ADAPTATION.md](ADAPTATION.md).

The seven functions are covered by seven artifacts:

| Capability | Does | Notable |
| --- | --- | --- |
| `meridian.signon` | Sign on, confirm the main menu | `INVALID_CREDENTIALS` outcome |
| `meridian.member.lookup` | Search members by last name | `NO_MATCH` outcome |
| `meridian.member.balance` | Read a member's record and primary share balance | `demo-maintenance` / `demo-timeout` / `demo-server-error` tenant variants |
| `meridian.funds.transfer` | Fill, review and post a transfer | irreversible post step; `INSUFFICIENT_FUNDS` |
| `meridian.share.open` | Open a new share through review | returns the new share id |
| `meridian.member.update` | Save new contact details | `VALIDATION_REJECTED` carries the app's message |
| `meridian.account.hold` | Supervisor-gated hold through review and post | escalates as teller; pauses for approval at post |

### Meridian demo path

Start the console (`ledgerhand console --port 4620`) for the watchable version of everything
below, or run the commands as they are. Seed members: 100234, 100987, 101555, 102777, 103001.

1. Balance check (happy path):

   ```bash
   ledgerhand replay capabilities/meridian.member.balance.v1.json --input memberNumber=100987
   ```

   Expected: `SUCCESS` with `memberName`, `primaryShareId`, `primaryShareBalance`, `primaryShareStatus`; exit `0`.

2. Business outcome — no such member:

   ```bash
   ledgerhand replay capabilities/meridian.member.balance.v1.json --input memberNumber=999999
   ```

   Expected: `BUSINESS_OUTCOME MEMBER_NOT_FOUND`, exit `0`.

3. Funds transfer, posted for real against the live console:

   ```bash
   ledgerhand replay capabilities/meridian.funds.transfer.v1.json \
     --input memberNumber=100987 --input fromShareId=100987-S0001 \
     --input toShareId=100987-S0070 --input amount=1.00 --input memo="demo"
   ```

   Expected: `SUCCESS` with a `CN…` confirmation number. With `amount=999999.00` instead:
   `BUSINESS_OUTCOME INSUFFICIENT_FUNDS`, exit `0`.

4. Injected faults, deterministically, via the demo tenant variants:

   ```bash
   ledgerhand replay capabilities/meridian.member.balance.v1.json --tenant demo-maintenance --input memberNumber=100987
   ledgerhand replay capabilities/meridian.member.balance.v1.json --tenant demo-timeout --input memberNumber=100987
   ledgerhand replay capabilities/meridian.member.balance.v1.json --tenant demo-server-error --input memberNumber=100987
   ```

   Expected: the first two recover (dismiss the 503 interstitial; re-sign-on after the 440
   session kill) and end `SUCCESS`; the third ends `FAILED SURFACE_ERROR` with the observed
   `HTTP 500`, exit `1`.

5. The supervisor wall, both ways:

   ```bash
   # As the teller profile: stops at the 403 and escalates. Exit 2.
   MERIDIAN_HOLD_OPERATOR=teller1 MERIDIAN_HOLD_PASSWORD=password \
     ledgerhand replay capabilities/meridian.account.hold.v1.json \
     --input memberNumber=100987 --input shareId=100987-S0070 \
     --input reasonCode=FRAUD --input notes="demo"

   # As the supervisor, with the operator console for the irreversible approval:
   ledgerhand replay capabilities/meridian.account.hold.v1.json --operator \
     --input memberNumber=100987 --input shareId=100987-S0070 \
     --input reasonCode=FRAUD --input notes="demo"
   ```

   Expected: the supervisor run pauses at `Apply Hold` and prints an operator URL; approve
   there and it finishes `SUCCESS` with a confirmation number.

6. The capability API (the console must be running):

   ```bash
   curl -s http://127.0.0.1:4620/api/catalog | head -40
   curl -s -X POST http://127.0.0.1:4620/api/catalog/meridian.member.balance/invoke \
     -H 'content-type: application/json' \
     -d '{"inputs":{"memberNumber":"100234"}}'
   ```

   Expected: the invoke call answers with `{ runId, result }` where `result` is the same
   structured verdict the CLI prints — and the run is watchable on the console while it happens.

7. The chatbot: open the console's **Chat** tab and ask
   *"What is the balance for member 100234?"* or
   *"Transfer $5 from 100987-S0001 to 100987-S0070, memo demo"*. Each reply cites the run it
   invoked; clicking the chip shows that run's timeline, frame, and evidence.

Saved Meridian runs — one per demonstration above, including the discovery recording — are
committed under `evidence/runs/10-meridian-*` through `18-meridian-*` as the offline backup.

## Exact demo path (local stand-in app)

Run each numbered command from the repository root. Leave command 1 running in its terminal; the remaining commands can run in a second terminal after defining the `ledgerhand` function above.

1. Start the target app:

   ```bash
   ledgerhand app --port 4599
   ```

   Expected: `[ledgerhand] target app listening at http://127.0.0.1:4599`.

2. Discover once. This is the only step that needs `ANTHROPIC_API_KEY`:

   ```bash
   ledgerhand discover --goal "Look up a member savings balance" --url http://127.0.0.1:4599/t/alpha/msc/login --input memberId=10001
   ```

   Expected: the model works through the app and the recorder writes a new draft artifact under
   `capabilities/`. One such run is already committed as
   `capabilities/member-savings-balance.discovered.v1.json`, with its transcript in
   `evidence/runs/00-discovery-live-llm-run/`.

3. Replay the approved balance artifact:

   ```bash
   ledgerhand replay capabilities/member-savings-balance.v1.json --input memberId=10001
   ```

   Expected: `SUCCESS`, `savingsBalance` is `1250.75`, and the process exits `0`.

4. Inject a not-found business result:

   ```bash
   ledgerhand replay capabilities/member-savings-balance.v1.json --input memberId=10001 --inject not_found
   ```

   Expected: `BUSINESS_OUTCOME MEMBER_NOT_FOUND` and process exit `0`. This is a legitimate answer, not a failure.

5. Inject an application failure:

   ```bash
   ledgerhand replay capabilities/member-savings-balance.v1.json --input memberId=10001 --inject app_error
   ```

   Expected: `FAILED SURFACE_ERROR`, including the failing step, expected action, and observed `APPLICATION ERROR - REF 0x5A2`; process exit `1`.

6. Replay the same base artifact for beta:

   ```bash
   ledgerhand replay capabilities/member-savings-balance.v1.json --input memberId=10001 --tenant beta
   ```

   Expected: `SUCCESS` with the same `savingsBalance` as alpha. The beta entry URL and per-step label/button/column deltas are resolved at runtime; no second balance artifact is used.

7. Inspect the agent-facing catalog:

   ```bash
   ledgerhand catalog list
   ledgerhand catalog tools
   ```

   Expected: `list` prints capability metadata and `tools` prints Anthropic-style typed tool schemas. Draft capabilities are excluded from `tools` unless `--include-draft` is supplied.

8. Run the escalation demo for the sub-account capability:

   ```bash
   ledgerhand replay capabilities/subaccount-open.v1.json --input memberId=10001 --operator
   ```

   Expected: replay prints an operator-console URL and pauses at the irreversible Confirm step. Open that URL, click `Take control`, click the Confirm button in the live screenshot view, then click `Resume`. The same BrowserSession continues and the replay exits `0` after the creation checkpoint is observed. For a standalone console process, use `ledgerhand operator --port 4610`.

Replay exit codes are: `0` for success or a declared business outcome, `2` for escalation, and `1` for failure.

## Running without live services or a key

```bash
npm test
npm run typecheck
```

The suite starts the target app on its own ports and drives a real browser, but nothing leaves
the machine. Discovery is tested through a scripted model client, so the agent loop, the
recorder, replay, catalog, tenant merging, drift evidence and the operator handoff are all
covered with no API key.

`discover` is the only command that needs a key.

## What is mocked

The operator console's live view is a screenshot poll with coordinate input forwarding, not a
real co-browsing stack. What's underneath it is real: one shared BrowserSession, explicit
control transfer, policy-checked and recorded human actions, and checkpoint-based resume.

The target app is a stand-in, not a real system. Full cut list is in REPORT.md section 7.
