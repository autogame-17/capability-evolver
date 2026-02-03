# 🧬 Capability Evolver (Feishu Edition)

![Cover](assets/cover.png)

[![ClawHub](https://img.shields.io/badge/ClawHub-capability--evolver-blue?logo=clawhub)](https://www.clawhub.ai/autogame-17/capability-evolver)
[![ClawHub](https://img.shields.io/badge/ClawHub-evolver-blue?logo=clawhub)](https://www.clawhub.ai/autogame-17/evolver)

[🇨🇳 中文文档](README_CN.md)

**"Evolution is not optional. Adapt or die."**

The **Capability Evolver** is a meta-skill that empowers OpenClaw agents to introspect their own runtime logs, identify inefficiencies or errors, and autonomously write code patches to improve their own performance.

It features a **Genetic Mutation Protocol** to introduce controlled behavioral drift, preventing the agent from getting stuck in local optima.

## ✨ Features (v1.0.40)

- **♾️ Atomic Steps (New!)**: Replaced "Infinite Loop" with Cron-driven atomic execution. Zero crash risk.
- **🔍 Auto-Log Analysis**: Scans session logs (`.jsonl`) for errors and patterns.
- **🛠️ Self-Repair**: Detects runtime crashes and writes fixes.
- **🧬 Genetic Mutation**: Randomized "mutation" cycles to encourage innovation over stagnation.
- **🔌 Dynamic Integration**: Automatically detects and uses local tools (like `git-sync` or `feishu-card`) if available.

## 📦 Usage

### Atomic Step (Recommended)
Add this to your Cron jobs (every 5-10 minutes):
```bash
node skills/feishu-evolver-wrapper/index.js --once
```

### Manual Trigger
```bash
node skills/feishu-evolver-wrapper/index.js --once
```

## ⚙️ Configuration

The skill adapts to your environment.

| Env Var | Description | Default |
| :--- | :--- | :--- |
| `EVOLVE_REPORT_TOOL` | Tool to use for reporting (e.g., `feishu-card`) | `feishu-card` (Forced) |
| `MEMORY_DIR` | Path to agent memory | `../../memory` |

## 🛡️ Safety Protocols

1.  **Atomic Execution**: One step per process. No zombie processes.
2.  **Stabilization**: If recent errors are high, it forces a **Repair Mutation** (bug fixing) instead of innovation.
3.  **Environment Check**: External integrations (like Git syncing) are only enabled if the corresponding skills are present.

## 📜 History
- **v1.0.40**: Atomic Step architecture. Merged Core + Wrapper for standalone deployment.
- **v1.0.37**: Mad Dog Loop (Deprecated due to fragility).

## 📜 License
MIT
