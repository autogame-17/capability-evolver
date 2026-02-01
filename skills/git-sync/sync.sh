#!/bin/bash
# Usage: ./sync.sh ["Commit Message"]

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Lockfile mechanism to prevent concurrent syncs (Race Condition Protection)
LOCKFILE="/tmp/openclaw_git_sync.lock"
exec 200>"$LOCKFILE"
if ! flock -n 200; then
    log "⚠️ Sync already in progress (locked). Skipping."
    exit 0
fi

MSG="${1:-Auto-sync: Routine evolution update}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIMEOUT_CMD="timeout 120s"

# Ensure we are in the correct directory
cd "$REPO_DIR" || { log "Failed to cd to $REPO_DIR"; exit 1; }

# Auto-detect current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ -z "$CURRENT_BRANCH" ]; then
    log "Error: Could not determine current branch."
    exit 1
fi

# 1. Commit Local Changes
COMMITTED=0
if [ -n "$(git status --porcelain)" ]; then
  log "Changes detected. Committing to $CURRENT_BRANCH..."
  git add .
  
  # Capture commit output to handle "nothing to commit" gracefully
  if COMMIT_OUT=$(git commit -m "$MSG" 2>&1); then
    log "Commit successful."
    COMMITTED=1
  else
    # Check if failure was due to empty commit (e.g. dirty submodules)
    if echo "$COMMIT_OUT" | grep -E "nothing to commit|no changes added to commit"; then
        log "⚠️  Skipping commit: No stageable changes (check for dirty submodules)."
    else
        log "❌ Commit failed:"
        echo "$COMMIT_OUT"
        exit 1
    fi
  fi
fi

# 2. Check Remote Config
REMOTE_URL=$(git remote get-url origin 2>/dev/null)
if [ -z "$REMOTE_URL" ]; then
    log "Warning: No remote 'origin' configured. Skipping push/pull."
    exit 0
fi

# Optimization: Skip fetch/pull if no commits and recently fetched (throttling)
LAST_FETCH_FILE=".git/FETCH_HEAD"
if [ "$COMMITTED" -eq 0 ] && [ -f "$LAST_FETCH_FILE" ]; then
    # Get file modification time in seconds
    if [[ "$OSTYPE" == "darwin"* ]]; then
        LAST_FETCH=$(stat -f %m "$LAST_FETCH_FILE")
        NOW=$(date +%s)
    else
        LAST_FETCH=$(stat -c %Y "$LAST_FETCH_FILE")
        NOW=$(date +%s)
    fi
    DIFF=$((NOW - LAST_FETCH))
    
    # 300 seconds = 5 minutes
    if [ $DIFF -lt 300 ]; then
        log "ℹ️  Skipping remote sync (Last fetch was ${DIFF}s ago). No local changes."
        exit 0
    fi
fi

# 3. Fetch & Check Sync Status
# Fetch specific branch to save bandwidth/time
$TIMEOUT_CMD git fetch origin "$CURRENT_BRANCH" >/dev/null 2>&1

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$CURRENT_BRANCH" 2>/dev/null || echo "")

if [ -n "$REMOTE" ] && [ "$LOCAL" = "$REMOTE" ]; then
  # Local matches Upstream. We are done.
  exit 0
fi

# 4. Pull & Rebase (Safety First)
# log "Syncing with remote..."
# Use --autostash to handle background log updates during sync
if ! OUT=$($TIMEOUT_CMD git pull --rebase --autostash origin "$CURRENT_BRANCH" 2>&1); then
  log "⚠️ Rebase failed. Reason:"
  echo "$OUT" | sed 's/^/    /' # Indent output for readability
  
  log "Aborting rebase and attempting standard merge..."
  git rebase --abort 2>/dev/null || true
  
  # Fallback to Merge strategy
  if ! $TIMEOUT_CMD git pull --no-rebase origin "$CURRENT_BRANCH"; then
      log "❌ Sync (Merge) failed: Manual intervention required."
      exit 1
  else
      log "✅ Merge successful (Fallback)."
  fi
fi

# 5. Push with Retry
MAX_RETRIES=3
COUNT=0
SUCCESS=0

while [ $COUNT -lt $MAX_RETRIES ]; do
  if OUT=$($TIMEOUT_CMD git push origin "$CURRENT_BRANCH" 2>&1); then
    log "Push successful."
    SUCCESS=1
    break
  else
    log "Push failed. Retrying in 3s... ($((COUNT+1))/$MAX_RETRIES)"
    echo "DEBUG: $OUT"
    sleep 3
    COUNT=$((COUNT+1))
  fi
done

if [ $SUCCESS -eq 0 ]; then
  log "Push failed after $MAX_RETRIES attempts."
  exit 1
fi
