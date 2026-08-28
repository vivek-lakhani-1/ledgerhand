#!/usr/bin/env bash
# One-command Meridian demo: a success, a business outcome, and a recovered fault.
# Needs .env with MERIDIAN_OPERATOR/MERIDIAN_PASSWORD (public demo teller credentials).
set -euo pipefail
cd "$(dirname "$0")/.."
run() { npx --no-install tsx src/cli/index.ts "$@"; }

echo "=== 1/3 Balance check for member 100987 — expected: SUCCESS with typed outputs"
run replay capabilities/meridian.member.balance.v1.json --input memberNumber=100987

echo "=== 2/3 Unknown member 999999 — expected: BUSINESS_OUTCOME MEMBER_NOT_FOUND (not a crash)"
run replay capabilities/meridian.member.balance.v1.json --input memberNumber=999999

echo "=== 3/3 Injected 503 maintenance interstitial — expected: recovered, then SUCCESS"
run replay capabilities/meridian.member.balance.v1.json --tenant demo-maintenance --input memberNumber=100987

echo "=== Demo complete. Watch the same runs live: 'ledgerhand console --port 4620'."
