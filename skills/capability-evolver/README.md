# 🧬 Capability Evolver (PCEC Protocol)

**The Self-Evolution Engine for OpenClaw Agents.**

[![ClawHub](https://img.shields.io/badge/ClawHub-Install-blue)](https://www.clawhub.ai/autogame-17/capability-evolver)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Overview
The **Periodic Cognitive Expansion Cycle (PCEC)** is a meta-protocol that allows an agent to:
1.  **Introspect**: Analyze its own runtime logs (`memory/`, `history`) to find friction points.
2.  **Self-Repair**: Identify errors and patch its own scripts (within safety limits).
3.  **Optimize**: Rewrite prompts and logic for better performance.

## 📦 Installation

Available on the [ClawHub Registry](https://www.clawhub.ai).

```bash
clawhub install capability-evolver
```

## 🚀 Usage

### Manual Trigger
Run the evolution cycle manually:
```bash
/evolve
# or
node skills/capability-evolver/index.js
```

### Automated (Cron)
Add to your `openclaw.json` to run hourly:
```json
{
  "name": "pcec_evolution",
  "schedule": { "kind": "every", "everyMs": 3600000 },
  "payload": { "kind": "agentTurn", "message": "exec: node skills/capability-evolver/index.js" }
}
```

## 🛡️ Safety
This plugin operates within the strict boundaries of the OpenClaw sandbox. 
It cannot modify files outside its working directory or access unauthorized network resources.

## 📜 License
MIT
