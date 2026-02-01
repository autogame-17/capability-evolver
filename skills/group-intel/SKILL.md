---
name: group-intel
description: Periodically scans group chats, summarizes conversations, and reports intelligence/gossip to the Master.
tags: [feishu, lark, analysis, summary, gossip]
---

# Group Intel Skill

Periodically scans all group chats where the bot is present, summarizes the conversation, and reports to the Master.

## Tools

### group_intel_report
Manually trigger a scan and report.

## Automation
- Designed to run via **PCEC** or dedicated **Cron**.
- Scans last 50 messages from each group.
- Filters out bot's own messages.
- Summarizes using LLM.
- Sends a consolidated `feishu-card` report to Master.

## Inputs
- `master_id`: `ou_cdc63fe05e88c580aedead04d851fc04`
- `target_groups`: Auto-discovered via `sessions_list`.

## Implementation
- `report.js`: Generates a persona-based analysis prompt.
- `fetch.js`: CLI tool to list chats and fetch message history from Feishu API.
- `gen_report.js`: Converts JSON history from `fetch.js` into a readable Markdown report.

## CLI Usage
```bash
# List active groups
npm run fetch -- list

# Fetch history for a chat
npm run fetch -- history <chat_id> --limit 50 > history.json

# Generate Markdown Report
npm run gen-report -- --input history.json --output report.md
```
