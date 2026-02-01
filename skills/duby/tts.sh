#!/bin/bash
# Usage: duby_tts.sh "Text to speak" [VoiceID]
# 🧬 Evolution v2.0: Added Caching & Resilience

API_KEY="${DUBY_API_KEY}"
TEXT="$1"

if [ -z "$API_KEY" ]; then
  echo "Error: DUBY_API_KEY not set" >&2
  exit 1
fi

# Default to Xinduo (芯朵) if not provided.
VOICE_ID="${2:-2719350d-9f0c-40af-83aa-b3879a115ca1}" 

# --- ⚡ OPTIMIZATION: CACHING LAYER ---
CACHE_DIR="/tmp/openclaw_duby_cache"
mkdir -p "$CACHE_DIR"

# Hash the inputs to create a unique key
HASH_INPUT="${TEXT}_${VOICE_ID}_1.1" # Including speed factor in hash
HASH=$(echo -n "$HASH_INPUT" | md5sum | awk '{print $1}')
CACHE_FILE="$CACHE_DIR/$HASH.mp3"

if [ -f "$CACHE_FILE" ]; then
  echo "⚡ [Duby] Cache Hit! Serving pre-synthesized audio." >&2
  echo "MEDIA:$CACHE_FILE"
  exit 0
fi

echo "🎤 [Duby] Synthesizing new audio..." >&2

# 1. Create Job
RESPONSE=$(curl -s -X POST "https://api.duby.so/openapi/tts/jobs" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{
    \"clone_job_id\": \"$VOICE_ID\",
    \"text\": \"$TEXT\",
    \"speed_factor\": 1.1
  }")

JOB_ID=$(echo "$RESPONSE" | jq -r '.data.id')

if [ "$JOB_ID" == "null" ] || [ -z "$JOB_ID" ]; then
  echo "Error creating job: $RESPONSE" >&2
  exit 1
fi

# 2. Poll for completion (with Timeout)
STATUS="queued"
ATTEMPTS=0
MAX_ATTEMPTS=60 # 60 seconds timeout

while [ "$STATUS" != "succeeded" ] && [ "$STATUS" != "failed" ]; do
  if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then
    echo "Error: Timed out waiting for TTS job $JOB_ID" >&2
    exit 1
  fi
  
  sleep 1
  ATTEMPTS=$((ATTEMPTS+1))
  
  JOB_INFO=$(curl -s -X GET "https://api.duby.so/openapi/tts/jobs/$JOB_ID" \
    -H "Authorization: Bearer $API_KEY")
  STATUS=$(echo "$JOB_INFO" | jq -r '.data.status')
done

if [ "$STATUS" == "failed" ]; then
  echo "Job failed: $(echo "$JOB_INFO" | jq -r '.data.error')" >&2
  exit 1
fi

# 3. Download Audio & Cache
AUDIO_PATH=$(echo "$JOB_INFO" | jq -r '.data.output_audio_url')
# Handle cases where path might already contain host
if [[ "$AUDIO_PATH" == http* ]]; then
    FULL_URL="$AUDIO_PATH"
else
    FULL_URL="https://api.duby.so$AUDIO_PATH"
fi

curl -s -o "$CACHE_FILE" "$FULL_URL"

if [ -f "$CACHE_FILE" ]; then
  echo "MEDIA:$CACHE_FILE"
else 
  echo "Error: Download failed." >&2
  exit 1
fi
