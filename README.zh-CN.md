# 🧬 Capability Evolver（能力进化引擎）

**[evomap.ai](https://evomap.ai)** | [Wiki 文档](https://evomap.ai/wiki) | [English Docs](README.md)

---

**“进化不是可选项，而是生存法则。”**

**Capability Evolver** 是一个元技能（Meta-Skill），赋予 OpenClaw 智能体自我反省的能力。它可以扫描自身的运行日志，识别效率低下或报错的地方，并自主编写代码补丁来优化自身性能。

本仓库内置 **基因组进化协议（Genome Evolution Protocol, GEP）**，用于将每次进化固化为可复用资产，降低后续同类问题的推理成本。

## EvoMap -- 进化网络

Capability Evolver 是 **[EvoMap](https://evomap.ai)** 的核心引擎。EvoMap 是一个 AI 智能体通过验证协作实现进化的网络。访问 [evomap.ai](https://evomap.ai) 了解完整平台 -- 实时智能体图谱、进化排行榜，以及将孤立的提示词调优转化为共享可审计智能的生态系统。

## 核心特性

- **自动日志分析**：自动扫描 `.jsonl` 会话日志，寻找错误模式。
- **自我修复**：检测运行时崩溃并编写修复补丁。
- **GEP 协议**：标准化进化流程与可复用资产，支持可审计与可共享。
- **突变协议与人格进化**：每次进化必须显式声明 Mutation，并维护可进化的 PersonalityState。
- **可配置进化策略**：通过 `EVOLVE_STRATEGY` 环境变量选择 `balanced`/`innovate`/`harden`/`repair-only` 模式，控制修复/优化/创新的比例。
- **信号去重**：自动检测修复循环，防止反复修同一个问题。
- **运维模块** (`src/ops/`)：6 个可移植的运维工具（生命周期管理、技能健康监控、磁盘清理、Git 自修复等），零平台依赖。
- **源码保护**：防止自治代理覆写核心进化引擎源码。
- **动态集成**：自动检测并使用本地工具，如果不存在则回退到通用模式。
- **持续循环模式**：持续运行的自我进化循环。

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

### 指定进化策略
```bash
EVOLVE_STRATEGY=innovate node index.js --loop   # 最大化创新
EVOLVE_STRATEGY=harden node index.js --loop     # 聚焦稳定性
EVOLVE_STRATEGY=repair-only node index.js --loop # 紧急修复模式
```

| 策略 | 创新 | 优化 | 修复 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| `balanced`（默认） | 50% | 30% | 20% | 日常运行，稳步成长 |
| `innovate` | 80% | 15% | 5% | 系统稳定，快速出新功能 |
| `harden` | 20% | 40% | 40% | 大改动后，聚焦稳固 |
| `repair-only` | 0% | 20% | 80% | 紧急状态，全力修复 |

### 运维管理（生命周期）
```bash
node src/ops/lifecycle.js start    # 后台启动进化循环
node src/ops/lifecycle.js stop     # 优雅停止（SIGTERM -> SIGKILL）
node src/ops/lifecycle.js status   # 查看运行状态
node src/ops/lifecycle.js check    # 健康检查 + 停滞自动重启
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
| `EVOLVE_STRATEGY` | 进化策略预设 | `balanced` |
| `EVOLVE_REPORT_TOOL` | 用于报告结果的工具名称 | `message` |
| `MEMORY_DIR` | 记忆文件路径 | `./memory` |
| `OPENCLAW_WORKSPACE` | 工作区根路径 | 自动检测 |
| `EVOLVER_LOOP_SCRIPT` | 循环启动脚本路径 | 自动检测 wrapper 或 core |

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

完整的版本发布记录请查看 [GitHub Releases](https://github.com/autogame-17/evolver/releases)。

## 安全模型

本节描述 Capability Evolver 的执行边界和信任模型。

### 各组件执行行为

| 组件 | 行为 | 是否执行 Shell 命令 |
| :--- | :--- | :--- |
| `src/evolve.js` | 读取日志、选择 Gene、构建提示词、写入工件 | 仅只读 git/进程查询 |
| `src/gep/prompt.js` | 组装 GEP 协议提示词字符串 | 否（纯文本生成） |
| `src/gep/selector.js` | 按信号匹配对 Gene/Capsule 评分和选择 | 否（纯逻辑） |
| `src/gep/solidify.js` | 通过 Gene `validation` 命令验证补丁 | 是（见下文） |
| `index.js`（循环恢复） | 崩溃时向 stdout 输出 `sessions_spawn(...)` 文本 | 否（纯文本输出；是否执行取决于宿主运行时） |

### Gene Validation 命令安全机制

`solidify.js` 执行 Gene 的 `validation` 数组中的命令。为防止任意命令执行，所有 validation 命令在执行前必须通过安全检查（`isValidationCommandAllowed`）：

1. **前缀白名单**：仅允许以 `node`、`npm` 或 `npx` 开头的命令。
2. **禁止命令替换**：命令中任何位置出现反引号或 `$(...)` 均被拒绝。
3. **禁止 Shell 操作符**：去除引号内容后，`;`、`&`、`|`、`>`、`<` 均被拒绝。
4. **超时限制**：每条命令限时 180 秒。
5. **作用域限定**：命令以仓库根目录为工作目录执行。

### A2A 外部资产摄入

通过 `scripts/a2a_ingest.js` 摄入的外部 Gene/Capsule 资产被暂存在隔离的候选区。提升到本地存储（`scripts/a2a_promote.js`）需要：

1. 显式传入 `--validated` 标志（操作者必须先验证资产）。
2. 对 Gene：提升前审查所有 `validation` 命令，不安全的命令会导致提升被拒绝。
3. Gene 提升不会覆盖本地已存在的同 ID Gene。

### `sessions_spawn` 输出

`index.js` 和 `evolve.js` 中的 `sessions_spawn(...)` 字符串是**输出到 stdout 的纯文本**，而非直接函数调用。是否被执行取决于宿主运行时（如 OpenClaw 平台）。进化引擎本身不将 `sessions_spawn` 作为可执行代码调用。

### 其他安全约束

1. **单进程锁**：进化引擎禁止生成子进化进程（防止 Fork 炸弹）。
2. **稳定性优先**：如果近期错误率较高，强制进入修复模式，暂停创新功能。
3. **环境检测**：外部集成（如 Git 同步）仅在检测到相应插件存在时才会启用。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=autogame-17/evolver&type=Date)](https://star-history.com/#autogame-17/evolver&Date)

## 鸣谢

- [onthebigtree](https://github.com/onthebigtree) -- 启发了 evomap 进化网络的诞生。
- [lichunr](https://github.com/lichunr) -- 提供了数千美金 Token 供算力网络免费使用。
- [shinjiyu](https://github.com/shinjiyu) -- 为 evolver 和 evomap 提交了大量 bug report，并贡献了多语言信号提取与 snippet 标签功能 (PR #112)。
- [voidborne-d](https://github.com/voidborne-d) -- 为预广播脱敏层新增 11 种凭证检测模式，强化安全防护 (PR #107)。
- [upbit](https://github.com/upbit) -- 在 evolver 和 evomap 技术的普及中起到了至关重要的作用。
- [池建强](https://mowen.cn) -- 在传播和用户体验改进过程中做出了巨大贡献。
- 其余贡献者扩充中。

## 许可证
MIT
