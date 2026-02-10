#!/bin/bash
# deploy_local.sh -- Deploy evolver-private-dev to skills/evolver/ with read-only protection
#
# Usage: bash scripts/deploy_local.sh
#
# What it does:
#   1. Unlock all protected files (chmod +w)
#   2. Copy source from private-dev to skills/evolver/
#   3. Clean junk files created by Hand Agent
#   4. Re-lock all files (chmod a-w)
#   5. Verify

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
DST="$WORKSPACE_ROOT/skills/evolver"

PROTECTED_FILES=(
  index.js package.json
  src/evolve.js
  src/gep/prompt.js src/gep/signals.js src/gep/strategy.js src/gep/solidify.js
  src/gep/selector.js src/gep/mutation.js src/gep/personality.js src/gep/memoryGraph.js
  src/gep/paths.js src/gep/bridge.js src/gep/envFingerprint.js src/gep/contentHash.js
  src/gep/assetStore.js src/gep/validationReport.js src/gep/candidates.js
  src/gep/a2a.js src/gep/a2aProtocol.js
  src/ops/index.js src/ops/lifecycle.js src/ops/skills_monitor.js src/ops/cleanup.js
  src/ops/trigger.js src/ops/commentary.js src/ops/self_repair.js
)

echo "[Deploy] Unlocking protected files..."
for f in "${PROTECTED_FILES[@]}"; do
  [ -f "$DST/$f" ] && chmod +w "$DST/$f" 2>/dev/null || true
done

echo "[Deploy] Copying source..."
for f in "${PROTECTED_FILES[@]}"; do
  mkdir -p "$(dirname "$DST/$f")" 2>/dev/null
  cp "$REPO_ROOT/$f" "$DST/$f"
done

echo "[Deploy] Cleaning junk..."
rm -f "$DST/src/gep/implement_innovation.js" 2>/dev/null
rm -f "$DST/lifecycle.js" 2>/dev/null
rm -f "$DST/temp_evolution_output.json" "$DST/temp_gep_output.json" 2>/dev/null
rm -rf "$DST/out" "$DST/assets/gep/gep" 2>/dev/null
rm -f "$DST/event.json" "$DST/mutation.json" "$DST/personality.json" "$DST/selector.json" 2>/dev/null

echo "[Deploy] Locking protected files (read-only)..."
for f in "${PROTECTED_FILES[@]}"; do
  [ -f "$DST/$f" ] && chmod a-w "$DST/$f"
done

echo "[Deploy] Verifying..."
cd "$DST" && node -e "require('./index'); require('./src/ops'); require('./src/gep/strategy'); console.log('v' + require('./package.json').version + ' deployed + locked')"

echo "[Deploy] Done."
