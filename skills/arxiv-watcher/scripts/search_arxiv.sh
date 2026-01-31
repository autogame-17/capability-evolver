#!/usr/bin/env bash
# scripts/search_arxiv.sh
QUERY=$1
COUNT=${2:-5}
# Use curl to query ArXiv API
curl -sL "https://export.arxiv.org/api/query?search_query=all:$QUERY&start=0&max_results=$COUNT&sortBy=submittedDate&sortOrder=descending"
