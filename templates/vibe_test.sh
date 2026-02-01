#!/bin/bash
# Vibe Check Template
# Usage: ./templates/vibe_test.sh <url>

URL="$1"
if [ -z "$URL" ]; then
  echo "Usage: $0 <url>"
  exit 1
fi

echo "Starting Vibe Check on $URL..."
agent-browser open "$URL"
agent-browser wait 2000
agent-browser snapshot -i
agent-browser screenshot "vibe_check_$(date +%s).png"
echo "Vibe check complete. Check snapshot output for interactive elements."
