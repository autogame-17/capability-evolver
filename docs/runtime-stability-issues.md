# Evolver + EvoMap Issues Report (2026-04-05)

## Environment
- **OS:** macOS Darwin 25.3.0 (arm64)
- **Node:** v24.11.1
- **Evolver:** @evomap/evolver v1.41.0
- **OpenClaw:** 2026.4.2 (d74a122)
- **Node ID:** node_65c63f0bb2b1

---

## Issue 1: System Load Backoff Loop (Critical)

**现象：** evolver 反复「启动 → 检测超载 → 退出」，进程不断重启但无法工作。

**根因：** `LOAD_MAX` 默认阈值 7.2，macOS 正常使用（Safari/WeChat/Chrome 等）负载即可超过 7.2。evolver 每次启动检测 `load1m > LOAD_MAX` 就写入 `dormant_hypothesis.json`（TTL 1h）然后退出。TTL 过期后重启，负载仍未降，无限循环。

**影响：** 从 4/3 17:04 到 4/5 09:15，约 40 小时完全停止工作。

**建议：**
- LOAD_MAX 应考虑核心数比例（如 `load1m / cpu_count`）
- 提供 per-platform 默认值（macOS scheduler 负载基数偏高）
- backoff 应有退避策略（如指数退避），而非固定 1h TTL 后立即重试

---

## Issue 2: Hub 403 node_secret_invalid → Rate Limit Death Spiral (Critical)

**现象：** node secret 失效后，evolver loop 每 cycle 都尝试 hello/heartbeat → 403 → 触发 rotate_secret → 被限速（60次/hour/IP）→ 所有请求被 429 拒绝 → 无法恢复。

**根因：**
1. secret 失效原因不明（可能是 clawhub update 覆盖了 .env）
2. loop 模式下没有 hello 限速保护，几分钟内打满 60 次
3. 一旦限速，连手动 rotate 也无法执行，必须等下一个整点窗口

**建议：**
- loop 模式增加 hello 限速计数器（本地计数，达到阈值后暂停尝试）
- heartbeat 403 后不要每 cycle 重试，改为指数退避
- 提供 `evolver doctor` 命令一键诊断 + 恢复 secret

---

## Issue 3: EVOLVE_BRIDGE=false 导致空转（High）

**现象：** 1349 个 cycle 全部执行，asset_call_log 显示 1260 次 hub_search_hit + 1260 次 asset_reference，但 0 个 solidify、0 个 publish、0 credits。

**根因：** `.env` 中 `EVOLVE_BRIDGE=false`（默认值），日志反复输出：
```
Auto-rejected pending run because bridge is disabled in loop mode (state only, no rollback)
```
但 hub_search/asset_reference 仍正常执行，造成"看似在工作"的假象。

**建议：**
- `EVOLVE_BRIDGE=false` 时应在启动时明确警告，而非每 cycle 静默 reject
- 或默认 `EVOLVE_BRIDGE=true`（loop 模式下 bridge=false 无意义）
- 在 Verbose 日志中汇总 reject 计数，便于监控

---

## Issue 4: ClawHub nativeSkills:auto 破坏本地 evolver 安装（Critical）

**现象：** gateway 重启时自动检测 lock.json → 通过 clawhub install evolver → 覆盖 symlink（`evolver → capability-evolver`）为空目录 → .env 被重置 → 进程变僵尸。

**根因：** `commands.nativeSkills = "auto"` + lock.json 残留（之前手动剥离 evolver skill 时只清了 workspace-aliang 的 lock.json，未清 workspace 的）。

**建议：**
- clawhub install 不应覆盖已有 symlink，应检测并跳过
- lock.json 清理应全局生效（所有 workspace 目录）
- nativeSkills 更新后应校验 symlink 完整性

---

## Issue 5: LLM Fallback 到失效模型（Medium）

**现象：** evolver executor 报错：
```
LLM ERROR: 500 {"type":"api_error","message":"your current token plan not support model, MiniMax-M2.7-highspeed (2061)"}
```

**根因：** agents.defaults.model.fallbacks 包含 highspeed 变体，主模型失败时 fallback 到了当前 token plan 不支持的模型。

**建议：** 
- fallback 应验证模型可用性（或至少跳过已报错的模型）
- 提供模型健康检查端点

---

## Issue 6: EvoMap Heartbeat Cron 与 Evolver 独立运行冲突（Low）

**现象：** gateway 有独立的 EvoMap Heartbeat cron（每 5 分钟），使用旧 secret，与 evolver 自身的心跳机制冲突，额外消耗 hello/heartbeat 限额。

**建议：** evolver 运行时不应再启动独立的 heartbeat cron，两者应合并或互斥。

---

## Issue 7: heartbeat API 超时不稳定（Low）

**现象：** `POST /a2a/heartbeat` 经常超时（curl exit 28），但 `GET /` 正常返回。node_secret_invalid 时的错误响应也会超时。

**建议：** hub 应对所有请求返回合理的超时响应（即使错误也应快速返回）。
