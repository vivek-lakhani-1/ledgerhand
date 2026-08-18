# Ledgerhand

Ledgerhand lets a model discover a browser workflow once and compile it into a typed capability artifact. Later runs use that artifact for deterministic replay, typed inputs and outputs, business-outcome classification, and human escalation when automation cannot safely continue. The target app is a local stand-in for a legacy bank console, intentionally shaped like a hostile frameset-based system rather than a production banking service. Phase 7 adds a catalog and CLI so an agent can discover, describe, and invoke approved capabilities by name.

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
| `APP_USER` | No | Local stand-in operator ID, default `OPER01`. |
| `APP_PASSWORD` | No | Local stand-in password, default `demo-pass-01`. |

Replay, catalog, invoke, the target app, and the operator console run without `ANTHROPIC_API_KEY`.

## Exact demo path

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

   Expected: the model drives the stand-in and the recorder writes a new draft JSON file under `capabilities/`.

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

The tests start the local target app on dedicated ports for replay, catalog invocation, tenant reuse, surface resolution, and escalation. Discovery tests use a scripted model client and do not require a live model or API key. Catalog shape, invalid-file reporting, tenant merge/linting, and drift evidence are also covered without any external service. A live browser is still required for the replay and operator-flow tests; no remote service is used.

## What is mocked

The target app is a local stand-in for a legacy bank console. The operator console's live view is a screenshot poll with coordinate input forwarding, not a real co-browsing stack; control transfer, the shared live BrowserSession, human actions, and checkpoint-based resume are real. See [REPORT.md](REPORT.md), section 7, for the full cut list.
