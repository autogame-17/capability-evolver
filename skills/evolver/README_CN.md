# 🧬 Capability Evolver (能力进化引擎)

<p align="center">
  <img src="https://github.com/autogame-17/evolver/raw/main/assets/cover.png" alt="Evolver Cover" width="100%">
</p>

**“进化不是可选项，而是生存法则。”**

**Capability Evolver** 是一个元技能（Meta-Skill），赋予 OpenClaw 智能体自我反省的能力。它可以扫描自身的运行日志，识别效率低下或报错的地方，并自主编写代码补丁来优化自身性能。

本插件内置了 **基因突变协议（Genetic Mutation Protocol）**，引入受控的行为漂移，防止智能体陷入局部最优解。

## ✨ 核心特性

- **🔍 自动日志分析**：自动扫描 `.jsonl` 会话日志，寻找错误模式。
- **🛠️ 自我修复**：检测运行时崩溃并编写修复补丁。
- **🧬 基因突变**：随机化的“突变”周期，鼓励创新而非停滞。
- **🔌 动态集成**：自动检测并使用本地工具（如 `git-sync` 或 `feishu-card`），如果不存在则回退到通用模式，零依赖运行。
- **🐕 疯狗模式 (Mad Dog Mode)**：持续运行的自我修复循环。

## 📦 使用方法

### 标准运行 (自动化)
```bash
node skills/capability-evolver/index.js
```

### 审查模式 (人工介入)
在应用更改前暂停，等待人工确认。
```bash
node skills/capability-evolver/index.js --review
```

### 持续循环 (守护进程)
无限循环运行。适合作为后台服务。
```bash
node skills/capability-evolver/index.js --loop
```

## ⚙️ 配置与解耦

本插件能自动适应你的环境。

| 环境变量 | 描述 | 默认值 |
| :--- | :--- | :--- |
| `EVOLVE_REPORT_TOOL` |用于报告结果的工具名称 (例如 `feishu-card`) | `message` |
| `MEMORY_DIR` | 记忆文件路径 | `../../memory` |

## 🛡️ 安全协议

1.  **单进程锁**：进化引擎禁止生成子进化进程（防止 Fork 炸弹）。
2.  **稳定性优先**：如果近期错误率较高，强制进入 **修复突变 (Repair Mutation)** 模式，暂停创新功能。
3.  **环境检测**：外部集成（如 Git 同步）仅在检测到相应插件存在时才会启用。

## 📜 许可证
MIT
