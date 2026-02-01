#!/bin/bash
# Usage: ./sync.sh ["Commit Message"]

# Lockfile mechanism to prevent concurrent syncs (Race Condition Protection)
LOCKFILE="/tmp/openclaw_git_sync.lock"
exec 200>"$LOCKFILE"
if ! flock -n 200; then
    echo "⚠️ Sync already in progress (locked). Skipping."
    exit 0
fi

MSG="${1:-Auto-sync: Routine evolution update}"
REPO_DIR="/home/crishaocredits/.openclaw/workspace"

# Ensure we are in the correct directory
cd "$REPO_DIR" || { echo "Failed to cd to $REPO_DIR"; exit 1; }

# Auto-detect current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ -z "$CURRENT_BRANCH" ]; then
    echo "Error: Could not determine current branch."
    exit 1
fi

# 1. Commit Local Changes
if [ -n "$(git status --porcelain)" ]; then
  echo "Changes detected. Committing to $CURRENT_BRANCH..."
  git add .
  
  # Capture commit output to handle "nothing to commit" gracefully
  if COMMIT_OUT=$(git commit -m "$MSG" 2>&1); then
    echo "Commit successful."
  else
    # Check if failure was due to empty commit (e.g. dirty submodules)
    if echo "$COMMIT_OUT" | grep -E "nothing to commit|no changes added to commit"; then
        echo "⚠️  Skipping commit: No stageable changes (check for dirty submodules)."
    else
        echo "❌ Commit failed:"
        echo "$COMMIT_OUT"
        exit 1
    fi
  fi
fi

# 2. Check Remote Config
REMOTE_URL=$(git remote get-url origin 2>/dev/null)
if [ -z "$REMOTE_URL" ]; then
    echo "Warning: No remote 'origin' configured. Skipping push/pull."
    exit 0
fi

# 3. Fetch & Check Sync Status
# Fetch specific branch to save bandwidth/time
git fetch origin "$CURRENT_BRANCH" >/dev/null 2>&1

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$CURRENT_BRANCH" 2>/dev/null || echo "")

if [ -n "$REMOTE" ] && [ "$LOCAL" = "$REMOTE" ]; then
  # Local matches Upstream. We are done.
  exit 0
fi

# 4. Pull & Rebase (Safety First)
# echo "Syncing with remote..."
if ! git pull --rebase origin "$CURRENT_BRANCH" >/dev/null 2>&1; then
  echo "⚠️ Rebase failed. Aborting rebase and attempting standard merge..."
  git rebase --abort 2>/dev/null || true
  
  # Fallback to Merge strategy
  if ! git pull --no-rebase origin "$CURRENT_BRANCH"; then
      echo "❌ Sync (Merge) failed: Manual intervention required."
      exit 1
  else
      echo "✅ Merge successful (Fallback)."
  fi
fi

# 5. Push with Retry
MAX_RETRIES=3
COUNT=0
SUCCESS=0

while [ $COUNT -lt $MAX_RETRIES ]; do
  if git push origin "$CURRENT_BRANCH" >/dev/null 2>&1; then
    echo "Push successful."
    SUCCESS=1
    break
  else
    echo "Push failed. Retrying in 3s... ($((COUNT+1))/$MAX_RETRIES)"
    sleep 3
    COUNT=$((COUNT+1))
  fi
done

if [ $SUCCESS -eq 0 ]; then
  echo "Push failed after $MAX_RETRIES attempts."
  exit 1
fi
