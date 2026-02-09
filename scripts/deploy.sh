#!/bin/bash
# deploy.sh -- Bump, build, deploy, and publish evolver
#
# Usage:
#   ./scripts/deploy.sh patch    # bump patch (1.8.0 -> 1.8.1)
#   ./scripts/deploy.sh minor    # bump minor (1.8.0 -> 1.9.0)
#   ./scripts/deploy.sh major    # bump major (1.8.0 -> 2.0.0)
#   ./scripts/deploy.sh 1.9.0   # explicit version
#
# What it does:
#   1. Bump version in package.json
#   2. Commit & push evolver-private-dev to GitHub
#   3. Build public distribution (dist-public/)
#   4. Deploy to skills/evolver/ in the workspace
#   5. Publish to GitHub Release (autogame-17/evolver)
#   6. Publish to ClawHub (evolver + capability-evolver)
#   7. Restart feishu-evolver-wrapper
#
# Prerequisites:
#   - gh CLI authenticated
#   - clawhub CLI authenticated
#   - Working directory: evolver-private-dev repo root
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$REPO_ROOT/../.." && pwd)"
SKILLS_EVOLVER="$WORKSPACE_ROOT/skills/evolver"
PUBLIC_REPO="autogame-17/evolver"

cd "$REPO_ROOT"

# --- Parse version argument ---
BUMP="${1:-}"
if [ -z "$BUMP" ]; then
    echo "Usage: $0 <patch|minor|major|X.Y.Z>"
    echo ""
    echo "Current version: $(node -p "require('./package.json').version")"
    exit 1
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")

case "$BUMP" in
    patch|minor|major)
        NEW_VERSION=$(node -e "
            var v = '$CURRENT_VERSION'.split('.');
            if ('$BUMP' === 'patch') v[2] = parseInt(v[2]) + 1;
            if ('$BUMP' === 'minor') { v[1] = parseInt(v[1]) + 1; v[2] = 0; }
            if ('$BUMP' === 'major') { v[0] = parseInt(v[0]) + 1; v[1] = 0; v[2] = 0; }
            console.log(v.join('.'));
        ")
        ;;
    *)
        NEW_VERSION="$BUMP"
        ;;
esac

echo "=== Evolver Deploy Pipeline ==="
echo "Version: $CURRENT_VERSION -> $NEW_VERSION"
echo ""

# --- Step 1: Bump version ---
echo "[1/7] Bumping version to $NEW_VERSION..."
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json

# --- Step 2: Commit & push private-dev ---
echo "[2/7] Committing and pushing evolver-private-dev..."
git add -A
git commit -m "chore(release): prepare v$NEW_VERSION" || echo "(nothing to commit)"
git push origin main

# --- Step 3: Build ---
echo "[3/7] Building public distribution..."
RELEASE_VERSION="$NEW_VERSION" node scripts/build_public.js

# --- Step 4: Deploy to skills/evolver ---
echo "[4/7] Deploying to skills/evolver/..."
rm -rf "$SKILLS_EVOLVER"/*
cp -r dist-public/* "$SKILLS_EVOLVER/"
cp dist-public/.gitignore "$SKILLS_EVOLVER/" 2>/dev/null || true
cd "$SKILLS_EVOLVER"
ln -sf ../../memory memory
ln -sf ../../MEMORY.md MEMORY.md
cd "$REPO_ROOT"

# Verify
node -e "require('$SKILLS_EVOLVER/src/evolve'); console.log('  Deploy verified OK');"

# --- Step 5: Publish GitHub Release ---
echo "[5/7] Publishing GitHub Release v$NEW_VERSION..."
PUBLIC_REPO="$PUBLIC_REPO" \
PUBLIC_USE_BUILD_OUTPUT=true \
RELEASE_TAG="v$NEW_VERSION" \
RELEASE_TITLE="v$NEW_VERSION" \
RELEASE_NOTES="Release v$NEW_VERSION" \
node scripts/publish_public.js 2>&1 || echo "  (GitHub release done, ClawHub may need manual publish)"

# --- Step 6: Publish ClawHub ---
echo "[6/7] Publishing to ClawHub..."
clawhub publish "$REPO_ROOT/dist-public" --slug evolver --name "Evolver" --version "$NEW_VERSION" --changelog "v$NEW_VERSION" --tags latest 2>&1 || echo "  (evolver publish failed)"
clawhub publish "$REPO_ROOT/dist-public" --slug capability-evolver --name "Capability Evolver" --version "$NEW_VERSION" --changelog "v$NEW_VERSION" --tags latest 2>&1 || echo "  (capability-evolver publish failed)"

# --- Step 7: Restart wrapper ---
echo "[7/7] Restarting feishu-evolver-wrapper..."
pkill -f "feishu-evolver-wrapper/index.js" 2>/dev/null || true
sleep 2
cd "$WORKSPACE_ROOT"
export EVOLVE_WRAPPER_LOOP_SLEEP_SECONDS="${EVOLVE_WRAPPER_LOOP_SLEEP_SECONDS:-600}"
export FORCE_INNOVATION="${FORCE_INNOVATION:-true}"
nohup node skills/feishu-evolver-wrapper/index.js --loop > skills/feishu-evolver-wrapper/wrapper.log 2>&1 &
echo "  Wrapper restarted (PID: $!)"

echo ""
echo "=== Deploy Complete: v$NEW_VERSION ==="
echo "  GitHub:  https://github.com/$PUBLIC_REPO/releases/tag/v$NEW_VERSION"
echo "  ClawHub: https://clawhub.ai/autogame-17/evolver"
echo "  ClawHub: https://clawhub.ai/autogame-17/capability-evolver"
