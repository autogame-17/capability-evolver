#!/bin/bash
# Usage: ./sync.sh ["Commit Message"]

MSG="${1:-Auto-sync: Routine evolution update}"
REPO_DIR="/home/crishaocredits/.openclaw/workspace"

cd "$REPO_DIR" || exit 1

# 1. Commit Local Changes
if [ -n "$(git status --porcelain)" ]; then
  echo "Changes detected. Committing..."
  git add .
  if git commit -m "$MSG"; then
    echo "Commit successful."
  else
    echo "Commit failed."
    exit 1
  fi
else
  echo "No new file changes to commit."
fi

# 2. Check for Unpushed Commits
# logic: if local main is ahead of origin/main
# First, fetch to know the state of origin
echo "Fetching origin..."
git fetch origin main

LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u})

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "Local and Remote are in sync. Nothing to push."
  exit 0
fi

# 3. Pull & Rebase (Safety First)
# This handles the case where we have commits (just made or previous) 
# and remote has moved ahead.
echo "Syncing with remote (Pull --rebase)..."
if git pull --rebase origin main; then
  echo "Rebase successful."
else
  echo "⚠️ Rebase failed/conflict. Aborting rebase to restore state."
  git rebase --abort
  echo "Sync failed: Manual intervention required to resolve conflicts."
  exit 1
fi

# 4. Push with Retry
MAX_RETRIES=3
COUNT=0
SUCCESS=0

while [ $COUNT -lt $MAX_RETRIES ]; do
  if git push origin main; then
    echo "Push successful."
    SUCCESS=1
    break
  else
    echo "Push failed. Retrying in 3 seconds... ($((COUNT+1))/$MAX_RETRIES)"
    sleep 3
    COUNT=$((COUNT+1))
  fi
done

if [ $SUCCESS -eq 0 ]; then
  echo "Push failed after $MAX_RETRIES attempts."
  exit 1
fi
