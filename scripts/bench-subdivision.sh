#!/usr/bin/env bash
set -euo pipefail

# Benchmark subdivision factors against payment_intents on goldilocks.
# Usage: ./scripts/bench-subdivision.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

source .envrc 2>/dev/null || true

POSTGRES_URL="postgresql://postgres:postgres@localhost:55432/postgres?sslmode=disable"
FACTORS=(2 3 5 7 9 10)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Subdivision factor benchmark (payment_intents)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for n in "${FACTORS[@]}"; do
  echo "--- N=$n ---"
  SUBDIVISION_FACTOR=$n \
  env -u PG_PROXY_HOST -u PG_PROXY_PORT \
    LOG_LEVEL=debug LOG_PRETTY=false \
    node --use-env-proxy --conditions bun --import tsx apps/engine/src/bin/sync-engine.ts sync \
    --stripe-api-key "$STRIPE_API_KEY_GOLDILOCKS_PROD" \
    --postgres-url "$POSTGRES_URL" \
    --postgres-schema "test_prod_goldilocks_sk" \
    --state none \
    --stripe-rate-limit 80 \
    --streams payment_intents 2>&1 | \
    node -e "
      const lines = require('fs').readFileSync('/dev/stdin','utf8').split('\n');
      const rounds = [];
      let complete = null;
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.event === 'subdivision_round') rounds.push(obj);
          if (obj.event === 'subdivision_complete') complete = obj;
        } catch {}
      }
      if (complete) {
        console.log('  rounds:       ' + complete.total_rounds);
        console.log('  api_calls:    ' + complete.total_api_calls);
        console.log('  empty_probes: ' + complete.total_empty_probes);
        console.log('  records:      ' + complete.total_records);
        console.log('  elapsed:      ' + (complete.elapsed_ms / 1000).toFixed(1) + 's');
        console.log('  effective_rps:' + complete.effective_rps.toFixed(1));
      }
      // Show per-round detail with histogram
      for (const r of rounds) {
        const h = r.records_per_segment || {};
        const hist = h.histogram || [];
        const zeros = hist.filter(x => x === 0).length;
        const full = hist.filter(x => x === 100).length;
        const partial = hist.filter(x => x > 0 && x < 100).length;
        console.log('  round ' + String(r.round).padStart(2) + ': ' +
          String(r.ranges_fetched).padStart(4) + ' fetched  ' +
          String(r.records_this_round).padStart(5) + ' rec  ' +
          String(r.round_ms).padStart(5) + 'ms  ' +
          'segments: ' + zeros + ' empty, ' + partial + ' partial, ' + full + ' full  ' +
          'min=' + (h.min ?? '-') + ' p50=' + (h.p50 ?? '-') + ' p90=' + (h.p90 ?? '-') + ' max=' + (h.max ?? '-'));
      }
    "
  echo ""
done
