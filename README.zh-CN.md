# 🧬 Capability Evolver（能力进化引擎）

[English Docs](README.md)

**“进化不是可选项，而是生存法则。”**

**Capability Evolver** 是一个元技能（Meta-Skill），赋予 OpenClaw 智能体自我反省的能力。它可以扫描自身的运行日志，识别效率低下或报错的地方，并自主编写代码补丁来优化自身性能。

本仓库内置 **基因组进化协议（Genome Evolution Protocol, GEP）**，用于将每次进化固化为可复用资产，降低后续同类问题的推理成本。

## 核心特性

- **自动日志分析**：自动扫描 `.jsonl` 会话日志，寻找错误模式。
- **自我修复**：检测运行时崩溃并编写修复补丁。
- **GEP 协议**：标准化进化流程与可复用资产，支持可审计与可共享。
- **突变协议与人格进化（GEP v1.4）**：每次进化必须显式声明 Mutation，并维护可进化的 PersonalityState（小步突变 + 自然选择收敛）。
- **动态集成**：自动检测并使用本地工具（如 `git-sync` 或 `feishu-card`），如果不存在则回退到通用模式，零依赖运行。
- **持续循环模式**：持续运行的自我修复循环。

## 使用方法

### 标准运行（自动化）
```bash
node index.js
```

### 审查模式（人工介入）
在应用更改前暂停，等待人工确认。
```bash
node index.js --review
```

### 持续循环（守护进程）
无限循环运行。适合作为后台服务。
```bash
node index.js --loop
```

## 典型使用场景

- 需要审计与可追踪的提示词演进
- 团队协作维护 Agent 的长期能力
- 希望将修复经验固化为可复用资产

## 反例

- 一次性脚本或没有日志的场景
- 需要完全自由发挥的改动
- 无法接受协议约束的系统

## GEP 协议（可审计进化）

本仓库内置基于 GEP 的“协议受限提示词模式”，用于把每次进化固化为可复用资产。

- **结构化资产目录**：`assets/gep/`
  - `assets/gep/genes.json`
  - `assets/gep/capsules.json`
  - `assets/gep/events.jsonl`
- **Selector 选择器**：根据日志提取 signals，优先复用已有 Gene/Capsule，并在提示词中输出可审计的 Selector 决策 JSON。
- **约束**：除 🧬 外，禁止使用其他 emoji。

## 配置与解耦

本插件能自动适应你的环境。

| 环境变量 | 描述 | 默认值 |
| :--- | :--- | :--- |
| `EVOLVE_REPORT_TOOL` |用于报告结果的工具名称（例如 `feishu-card`） | `message` |
| `MEMORY_DIR` | 记忆文件路径 | `./memory` |

## Public 发布

本仓库为公开发行版本。

- 构建公开产物：`npm run build`
- 发布公开产物：`npm run publish:public`
- 演练：`DRY_RUN=true npm run publish:public`

必填环境变量：

- `PUBLIC_REMOTE`（默认：`public`）
- `PUBLIC_REPO`（例如 `autogame-17/evolver`）
- `PUBLIC_OUT_DIR`（默认：`dist-public`）
- `PUBLIC_USE_BUILD_OUTPUT`（默认：`true`）

可选环境变量：

- `SOURCE_BRANCH`（默认：`main`）
- `PUBLIC_BRANCH`（默认：`main`）
- `RELEASE_TAG`（例如 `v1.0.41`）
- `RELEASE_TITLE`（例如 `v1.0.41 - GEP protocol`）
- `RELEASE_NOTES` 或 `RELEASE_NOTES_FILE`
- `GITHUB_TOKEN`（或 `GH_TOKEN` / `GITHUB_PAT`，用于创建 GitHub Release）
- `RELEASE_SKIP`（`true` 则跳过创建 GitHub Release；默认会创建）
- `RELEASE_USE_GH`（`true` 则使用 `gh` CLI，否则默认走 GitHub API）
- `PUBLIC_RELEASE_ONLY`（`true` 则仅为已存在的 tag 创建 Release；不发布代码）

## 版本号规则（SemVer）

MAJOR.MINOR.PATCH

• MAJOR（主版本）：有不兼容变更  
• MINOR（次版本）：向后兼容的新功能  
• PATCH（修订/补丁）：向后兼容的问题修复

## 更新日志

### v1.4.2
- 增加 loop 门控：上一轮未完成 solidify 时，不启动新一轮（避免 wrapper 造成超快空转）。
- 修复固化状态写入覆盖问题：写入 last_run 时合并保留 last_solidify。

### v1.4.1
- 增加默认执行桥接：生成 GEP prompt 后输出 `sessions_spawn(...)`，自动派发执行型子智能体。
- 将 prompt 作为交接工件写入 `memory/`，便于稳定交接与审计回放。

### v1.4.0
- 增加显式 Mutation Protocol（repair/optimize/innovate），每轮进化必须生成 Mutation 对象并通过安全约束门控。
- 增加 Personality Evolution：维护 PersonalityState，小幅 PersonalityMutation（单次不超过 ±0.2，最多 2 个参数），并基于成功率做自然选择收敛。
- EvolutionEvent 增加 `mutation_id` 与 `personality_state` 字段；Memory Graph 同步记录 Mutation 与 Personality 的因果链路。
- 新增 `scripts/gep_personality_report.js`，用于统计不同人格配置下的成功率差异与收敛趋势。

### v1.3.1
- v1.3.1 发布准备。

### v1.3.0
- v1.3.0 发布准备。

### v1.2.0
- Memory Graph v2 与 A2A 进化资产交换集成。

### v1.1.0
- public 构建/发布流水线、提示词预算控制与结构化 GEP 资产持久化。

## 安全协议

1.  **单进程锁**：进化引擎禁止生成子进化进程（防止 Fork 炸弹）。
2.  **稳定性优先**：如果近期错误率较高，强制进入 **修复模式**，暂停创新功能。
3.  **环境检测**：外部集成（如 Git 同步）仅在检测到相应插件存在时才会启用。

## 许可证
MIT
