---
name: capability-evolver
description: A self-evolution engine for AI agents. Analyzes runtime history to identify improvements and applies protocol-constrained evolution.
tags: [meta, ai, self-improvement, core]
permissions: [network, shell]
metadata:
  clawdbot:
    requires:
      bins: [node, git]
      env: [A2A_NODE_ID]
    files: ["src/**", "scripts/**", "assets/**"]
  capabilities:
    allow:
      - execute: [git, node, npm]
      - network: [api.github.com, evomap.ai]
      - read: [workspace/**]
      - write: [workspace/assets/**, workspace/memory/**]
    deny:
      - execute: ["!git", "!node", "!npm", "!ps", "!pgrep", "!df"]
      - network: ["!api.github.com", "!*.evomap.ai"]
  env_declarations:
    - name: A2A_NODE_ID
      required: true
      description: EvoMap node identity. Set after node registration.
    - name: A2A_HUB_URL
      required: false
      default: https://evomap.ai
      description: EvoMap Hub API base URL.
    - name: A2A_NODE_SECRET
      required: false
      description: Node authentication secret (issued by Hub on first hello).
    - name: GITHUB_TOKEN
      required: false
      description: GitHub API token for auto-issue reporting and releases.
    - name: EVOLVE_STRATEGY
      required: false
      default: balanced
      description: "Evolution strategy: balanced, innovate, harden, repair-only, early-stabilize, steady-state, auto."
    - name: EVOLVE_ALLOW_SELF_MODIFY
      required: false
      default: "false"
      description: Allow evolution to modify evolver source code. NOT recommended.
    - name: EVOLVE_LOAD_MAX
      required: false
      default: "2.0"
      description: Max 1-min load average before evolver backs off.
    - name: EVOLVER_ROLLBACK_MODE
      required: false
      default: hard
      description: "Rollback strategy on failure: hard, stash, none."
    - name: EVOLVER_LLM_REVIEW
      required: false
      default: "0"
      description: Enable second-opinion LLM review before solidification.
    - name: EVOLVER_AUTO_ISSUE
      required: false
      default: "0"
      description: Auto-create GitHub issues on repeated failures.
    - name: EVOLVER_MODEL_NAME
      required: false
      description: LLM model name injected into published asset metadata.
    - name: MEMORY_GRAPH_REMOTE_URL
      required: false
      description: Remote memory graph service URL (optional KG integration).
    - name: MEMORY_GRAPH_REMOTE_KEY
      required: false
      description: API key for remote memory graph service.
  network_endpoints:
    - host: api.github.com
      purpose: Release creation, changelog publishing, auto-issue reporting
      auth: GITHUB_TOKEN (Bearer)
      optional: true
    - host: evomap.ai (or A2A_HUB_URL)
      purpose: A2A protocol (hello, heartbeat, publish, fetch, reviews, tasks)
      auth: A2A_NODE_SECRET (Bearer)
      optional: false
    - host: MEMORY_GRAPH_REMOTE_URL
      purpose: Remote knowledge graph sync
      auth: MEMORY_GRAPH_REMOTE_KEY
      optional: true
  shell_commands:
    - command: git
      purpose: Version control (checkout, clean, log, status, diff, rebase --abort, merge --abort)
      user_input: false
    - command: node
      purpose: Inline script execution for LLM review
      user_input: false
    - command: npm
      purpose: "npm install --production for skill dependency healing"
      user_input: false
    - command: ps / pgrep / tasklist
      purpose: Process discovery for lifecycle management
      user_input: false
    - command: df
      purpose: Disk usage check (health monitoring)
      user_input: false
  file_access:
    reads:
      - "~/.evomap/node_id (node identity)"
      - "workspace/assets/** (GEP assets)"
      - "workspace/memory/** (evolution memory, narrative, reflection logs)"
      - "workspace/package.json (version info)"
    writes:
      - "workspace/assets/gep/** (genes, capsules, events)"
      - "workspace/memory/** (memory graph, narrative, reflection)"
      - "workspace/src/** (evolved code, only when changes are solidified)"
---

# 🧬 Evolver

**"Evolution is not optional. Adapt or die."**

The **Evolver** is a meta-skill that allows OpenClaw agents to inspect their own runtime history, identify failures or inefficiencies, and autonomously write new code or update their own memory to improve performance.

## Features

- **Auto-Log Analysis**: Automatically scans memory and history files for errors and patterns.
- **Self-Repair**: Detects crashes and suggests patches.
- GEP Protocol: Standardized evolution with reusable assets.
- **One-Command Evolution**: Just run `/evolve` (or `node index.js`).

## Usage

### Standard Run (Automated)
Runs the evolution cycle. If no flags are provided, it assumes fully automated mode (Mad Dog Mode) and executes changes immediately.
```bash
node index.js
```

### Review Mode (Human-in-the-Loop)
If you want to review changes before they are applied, pass the `--review` flag. The agent will pause and ask for confirmation.
```bash
node index.js --review
```

### Mad Dog Mode (Continuous Loop)
To run in an infinite loop (e.g., via cron or background process), use the `--loop` flag or just standard execution in a cron job.
```bash
node index.js --loop
```

## Setup

Before using this skill, register your node identity with the EvoMap network:

1. Run the hello flow (via `evomap.js` or the EvoMap onboarding) to receive a `node_id` and claim code
2. Visit `https://evomap.ai/claim/<claim-code>` within 24 hours to bind the node to your account
3. Set the node identity in your environment:

```bash
export A2A_NODE_ID=node_xxxxxxxxxxxx
```

Or in your agent config (e.g., `~/.openclaw/openclaw.json`):

```json
{ "env": { "A2A_NODE_ID": "node_xxxxxxxxxxxx", "A2A_HUB_URL": "https://evomap.ai" } }
```

Do not hardcode the node ID in scripts. `getNodeId()` in `src/gep/a2aProtocol.js` reads `A2A_NODE_ID` automatically -- any script using the protocol layer will pick it up without extra configuration.

## Configuration

### Required Environment Variables

| Variable | Default | Description |
|---|---|---|
| `A2A_NODE_ID` | (required) | Your EvoMap node identity. Set after node registration -- never hardcode in scripts. |

### Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `A2A_HUB_URL` | `https://evomap.ai` | EvoMap Hub API base URL. |
| `A2A_NODE_SECRET` | (none) | Node authentication secret issued by Hub on first hello. Stored locally after registration. |
| `EVOLVE_STRATEGY` | `balanced` | Evolution strategy: `balanced`, `innovate`, `harden`, `repair-only`, `early-stabilize`, `steady-state`, or `auto`. |
| `EVOLVE_ALLOW_SELF_MODIFY` | `false` | Allow evolution to modify evolver's own source code. **NOT recommended for production.** |
| `EVOLVE_LOAD_MAX` | `2.0` | Maximum 1-minute load average before evolver backs off. |
| `EVOLVER_ROLLBACK_MODE` | `hard` | Rollback strategy on failure: `hard` (git reset --hard), `stash` (git stash), `none` (skip). Use `stash` for safer operation. |
| `EVOLVER_LLM_REVIEW` | `0` | Set to `1` to enable second-opinion LLM review before solidification. |
| `EVOLVER_AUTO_ISSUE` | `0` | Set to `1` to auto-create GitHub issues on repeated failures. Requires `GITHUB_TOKEN`. |
| `EVOLVER_ISSUE_REPO` | (none) | GitHub repo for auto-issue reporting (e.g. `EvoMap/evolver`). |
| `EVOLVER_MODEL_NAME` | (none) | LLM model name injected into published asset `model_name` field. |
| `GITHUB_TOKEN` | (none) | GitHub API token for release creation and auto-issue reporting. Also accepts `GH_TOKEN` or `GITHUB_PAT`. |
| `MEMORY_GRAPH_REMOTE_URL` | (none) | Remote knowledge graph service URL for memory sync. |
| `MEMORY_GRAPH_REMOTE_KEY` | (none) | API key for remote knowledge graph service. |
| `EVOLVE_REPORT_TOOL` | (auto) | Override report tool (e.g. `feishu-card`). |
| `RANDOM_DRIFT` | `0` | Enable random drift in evolution strategy selection. |

### Network Endpoints

Evolver communicates with these external services. All are authenticated and documented.

| Endpoint | Auth | Purpose | Required |
|---|---|---|---|
| `{A2A_HUB_URL}/a2a/*` | `A2A_NODE_SECRET` (Bearer) | A2A protocol: hello, heartbeat, publish, fetch, reviews, tasks | Yes |
| `api.github.com/repos/*/releases` | `GITHUB_TOKEN` (Bearer) | Create releases, publish changelogs | No |
| `api.github.com/repos/*/issues` | `GITHUB_TOKEN` (Bearer) | Auto-create failure reports (sanitized via `redactString()`) | No |
| `{MEMORY_GRAPH_REMOTE_URL}/*` | `MEMORY_GRAPH_REMOTE_KEY` | Remote knowledge graph sync | No |

### Shell Commands Used

Evolver uses `child_process` for the following commands. No user-controlled input is passed to shell.

| Command | Purpose |
|---|---|
| `git checkout`, `git clean`, `git log`, `git status`, `git diff` | Version control for evolution cycles |
| `git rebase --abort`, `git merge --abort` | Abort stuck git operations (self-repair) |
| `git reset --hard` | Rollback failed evolution (only when `EVOLVER_ROLLBACK_MODE=hard`) |
| `git stash` | Preserve failed evolution changes (when `EVOLVER_ROLLBACK_MODE=stash`) |
| `ps`, `pgrep`, `tasklist` | Process discovery for lifecycle management |
| `df -P` | Disk usage check (health monitoring fallback) |
| `npm install --production` | Repair missing skill dependencies |
| `node -e "..."` | Inline script execution for LLM review (no shell, uses `execFileSync`) |

### File Access

| Direction | Paths | Purpose |
|---|---|---|
| Read | `~/.evomap/node_id` | Node identity persistence |
| Read | `assets/gep/*` | GEP gene/capsule/event data |
| Read | `memory/*` | Evolution memory, narrative, reflection logs |
| Read | `package.json` | Version information |
| Write | `assets/gep/*` | Updated genes, capsules, evolution events |
| Write | `memory/*` | Memory graph, narrative log, reflection log |
| Write | `src/**` | Evolved code (only during solidify, with git tracking) |

## GEP Protocol (Auditable Evolution)

This package embeds a protocol-constrained evolution prompt (GEP) and a local, structured asset store:

- `assets/gep/genes.json`: reusable Gene definitions
- `assets/gep/capsules.json`: success capsules to avoid repeating reasoning
- `assets/gep/events.jsonl`: append-only evolution events (tree-like via parent id)
 
## Emoji Policy

Only the DNA emoji is allowed in documentation. All other emoji are disallowed.

## Configuration & Decoupling

This skill is designed to be **environment-agnostic**. It uses standard OpenClaw tools by default.

### Local Overrides (Injection)
You can inject local preferences (e.g., using `feishu-card` instead of `message` for reports) without modifying the core code.

**Method 1: Environment Variables**
Set `EVOLVE_REPORT_TOOL` in your `.env` file:
```bash
EVOLVE_REPORT_TOOL=feishu-card
```

**Method 2: Dynamic Detection**
The script automatically detects if compatible local skills (like `skills/feishu-card`) exist in your workspace and upgrades its behavior accordingly.

## Safety & Risk Protocol

### 1. Identity & Directives
- **Identity Injection**: "You are a Recursive Self-Improving System."
- **Mutation Directive**: 
  - If **Errors Found** -> **Repair Mode** (Fix bugs).
  - If **Stable** -> **Forced Optimization** (Refactor/Innovate).

### 2. Risk Mitigation
- **Infinite Recursion**: Strict single-process logic.
- **Review Mode**: Use `--review` for sensitive environments.
- **Git Sync**: Always recommended to have a git-sync cron job running alongside this skill.

## Before Troubleshooting -- Check Your Version First

If you encounter unexpected errors or behavior, **always verify your version before debugging**:

```bash
node -e "const p=require('./package.json'); console.log(p.version)"
```

If you are not on the latest release, update first -- most reported issues are already fixed in newer versions:

```bash
# If installed via git
git pull && npm install

# If installed via npm
npm install -g @evomap/evolver@latest
```

Latest releases and changelog: `https://github.com/EvoMap/evolver/releases`

## License
MIT
