#!/bin/bash

# Check if a query is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <query>"
    exit 1
fi

QUERY="$*" # Capture all arguments as the query

# Function to URL-encode the query using python3
urlencode() {
    python3 -c 'import sys, urllib.parse; print(urllib.parse.quote_plus(sys.argv[1]))' "$1"
}

ENCODED_QUERY=$(urlencode "$QUERY")

# DuckDuckGo Instant Answer API endpoint
API_URL="https://api.duckduckgo.com/?q=${ENCODED_QUERY}&format=json&pretty=1&nohtml=1&skip_disambig=1"

# Make the request and parse with jq
response=$(curl -s "$API_URL")

# Extract AbstractText, AbstractURL, or Redirect
abstract_text=$(echo "$response" | jq -r '.AbstractText // empty')
abstract_url=$(echo "$response" | jq -r '.AbstractURL // empty')
redirect_url=$(echo "$response" | jq -r '.Redirect // empty')

output=""

if [ -n "$abstract_text" ]; then
    output="$abstract_text"
    if [ -n "$abstract_url" ]; then
        output="$output\nURL: $abstract_url"
    fi
elif [ -n "$redirect_url" ]; then
    output="Redirect: $redirect_url"
else
    # If no abstract or redirect, try to get related topics
    related_topics=$(echo "$response" | jq -r '.RelatedTopics[] | select(.Text != null and .Text != "") | .Text' | head -n 3)
    if [ -n "$related_topics" ]; then
        output="Related Topics:\n$related_topics"
    else
        output="No direct answer or related topics found."
    fi
fi

echo -e "$output"
