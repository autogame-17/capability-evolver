# 🧬 Capability Evolver

<p align="center">
  <img src="https://github.com/autogame-17/evolver/raw/main/assets/cover.png" alt="Evolver Cover" width="100%">
</p>

**"Evolution is not optional. Adapt or die."**

The **Capability Evolver** is a meta-skill that empowers OpenClaw agents to introspect their own runtime logs, identify inefficiencies or errors, and autonomously write code patches to improve their own performance.

It features a **Genetic Mutation Protocol** to introduce controlled behavioral drift, preventing the agent from getting stuck in local optima.

## ✨ Features

- **🔍 Auto-Log Analysis**: Scans session logs (`.jsonl`) for errors and patterns.
- **🛠️ Self-Repair**: Detects runtime crashes and writes fixes.
- **🧬 Genetic Mutation**: Randomized "mutation" cycles to encourage innovation over stagnation.
- **🔌 Dynamic Integration**: Automatically detects and uses local tools (like `git-sync` or `feishu-card`) if available, but works out-of-the-box without them.
- **🐕 Mad Dog Mode**: Continuous self-healing loop.

## 📦 Usage

### Standard Run (Automated)
```bash
node skills/capability-evolver/index.js
```

### Review Mode (Human-in-the-Loop)
Pauses for human confirmation before applying changes.
```bash
node skills/capability-evolver/index.js --review
```

### Continuous Loop (Daemon)
Runs indefinitely. Ideal for background services.
```bash
node skills/capability-evolver/index.js --loop
```

## ⚙️ Configuration

The skill adapts to your environment.

| Env Var | Description | Default |
| :--- | :--- | :--- |
| `EVOLVE_REPORT_TOOL` | Tool to use for reporting (e.g., `feishu-card`) | `message` |
| `MEMORY_DIR` | Path to agent memory | `../../memory` |

## 🛡️ Safety Protocols

1.  **Single Process**: The evolver cannot spawn child evolvers (prevents fork bombs).
2.  **Stabilization**: If recent errors are high, it forces a **Repair Mutation** (bug fixing) instead of innovation.
3.  **Environment Check**: External integrations (like Git syncing) are only enabled if the corresponding skills are present.

## 📜 License
MIT
