# 多 Agent / 多网关部署指南（OpenClaw + Evolver）

> **这份文档的目标读者有两类：**
> 1. **对 AI Agent（例如 OpenClaw、"龙虾"）自身**——Agent 在被问到"怎么安装 Evolver"时，应当先阅读本文件，再按文末【给龙虾的自动安装协议】执行。
> 2. **非技术用户**——你只需要把本文件路径整个丢给龙虾（或任何支持 skill/file 读取的 agent），它应当照章办事；你自己只需要看【给人类用户看的三句话】。

---

## 给人类用户看的三句话

1. **Evolver 并不是"一个 Linux 用户只能跑一个"**——那只是因为默认情况下多个 Evolver 会去抢同一套共享文件（进程锁、Proxy 端口、节点身份文件），把这些**按实例错开**就可以多开。
2. **每个"能独立进化"的 agent 装一份 Evolver**，主 agent 下的**子 agent 不要再装新的**——它们共享主 agent 的 Evolver，只靠一条环境变量 `EVOLVER_SESSION_SCOPE` 区分。
3. **不要相信"每个 agent 一个 .git"这个说法**——Evolver 认的是它运行时所在的那一个 git 仓库（通过 `EVOLVER_REPO_ROOT` 显式指定最稳）。一个 agent workspace 一个 .git 就够，子 agent 不需要自己的 .git。

---

## 1. 术语对照

| 词 | 含义 |
|---|---|
| **OpenClaw 网关（gateway）** | 一整套 `~/.openclaw*` 家目录。每套是独立的一批 agent。例如 `~/.openclaw`、`~/.openclaw-d2`、`~/.openclaw-d3`。 |
| **独立 agent** | 一个网关下直接暴露出来的 agent，比如网关 1 下的 `main`、`z1`、`z2`、`z3`、`z4`。它们彼此**不共享进化结果**。 |
| **主 agent** | 一个"独立 agent"如果还有下级 agent，就称它为"主 agent"。例如您拓扑里的 `main`。 |
| **子 agent** | 主 agent 召唤或派生出来的下级 agent。它们**应与主 agent 共享进化结果**（复用记忆、复用 Gene）。 |
| **Evolver 实例** | 一个独立运行的 `evolver --loop` 进程 + 它所绑定的 workspace + 它专属的 Proxy。 |

**核心规则：** 一个 Evolver 实例 ↔ 一个独立 agent（或一组共享进化的主/子 agent）。**不是**一个 Evolver 实例 ↔ 一个 agent 目录。

---

## 2. 标准布局（推荐您采用这一份）

基于您截图里的拓扑：

```
~/.openclaw/workspace/           ← 网关 1
├── main/   (主 agent, 有子 agent z1~z4)
├── z1/  z2/  z3/  z4/           (都是 main 的子 agent)

~/.openclaw-d2/workspace/        ← 网关 2 (独立 agent)
~/.openclaw-d3/workspace/        ← 网关 3 (独立 agent)
```

对应 **3 个 Evolver 实例**，一条龙安装方式如下：

### 2.1 Evolver 的安装位置

**不要**把 Evolver 装进任一个 agent 的 workspace 子目录（不要装到 `~/.openclaw/workspace/main/evolver`）。原因：那样 Evolver 的 `.git` 会和 agent workspace 的 `.git` 打架（见第 5 节 FAQ），而且换 agent 就得重装。

**推荐位置：** 每个网关对应一份**独立**的 Evolver 安装，放在网关根的旁边：

```
~/evolver-gw1/        ← 供 ~/.openclaw       使用
~/evolver-gw2/        ← 供 ~/.openclaw-d2    使用
~/evolver-gw3/        ← 供 ~/.openclaw-d3    使用
```

每个都是一次独立的 `git clone`：

```bash
git clone https://github.com/EvoMap/evolver.git ~/evolver-gw1
cd ~/evolver-gw1 && npm install

git clone https://github.com/EvoMap/evolver.git ~/evolver-gw2
cd ~/evolver-gw2 && npm install

git clone https://github.com/EvoMap/evolver.git ~/evolver-gw3
cd ~/evolver-gw3 && npm install
```

> 为什么一定要独立目录：Evolver 的进程锁文件 `evolver.pid` 写在自己的安装目录里，同一份代码只允许一个 `--loop`。独立目录 = 彼此天生不冲突。

### 2.2 每个 Evolver 实例的环境变量（最重要的一节）

给每个实例单独准备一个 `env` 文件，下面是三份模板，您可以**逐字复制**：

#### 网关 1（`~/evolver-gw1/.evolver-env`）

```bash
# --- 告诉 Evolver 它要进化哪一份 git 仓 ---
export EVOLVER_REPO_ROOT=$HOME/.openclaw/workspace/main
# （这就决定了 .git 走 main 这一个，不需要给 z1~z4 各自开 .git）

# --- 告诉 Evolver 这份安装的 workspace 根 ---
export OPENCLAW_WORKSPACE=$HOME/.openclaw/workspace

# --- Proxy 端口：必须与其他实例互不相同 ---
export EVOMAP_PROXY_PORT=19820

# --- 节点身份：Hub 侧用来区分是哪个网关的事件 ---
export A2A_NODE_ID=node_gw1_xxxxxxxx
export A2A_NODE_SECRET=<在 evomap.ai 注册网关 1 时给你的 secret>

# --- 把 ~/.evolver、~/.evomap 隔开的最稳方式：覆盖 HOME ---
export HOME=$HOME/.evolver-home-gw1
mkdir -p "$HOME/.evolver" "$HOME/.evomap"
```

#### 网关 2（`~/evolver-gw2/.evolver-env`）

```bash
export EVOLVER_REPO_ROOT=$HOME/.openclaw-d2/workspace
export OPENCLAW_WORKSPACE=$HOME/.openclaw-d2/workspace
export EVOMAP_PROXY_PORT=19821
export A2A_NODE_ID=node_gw2_xxxxxxxx
export A2A_NODE_SECRET=<网关 2 的 secret>
export HOME=$HOME/.evolver-home-gw2
mkdir -p "$HOME/.evolver" "$HOME/.evomap"
```

#### 网关 3（`~/evolver-gw3/.evolver-env`）

```bash
export EVOLVER_REPO_ROOT=$HOME/.openclaw-d3/workspace
export OPENCLAW_WORKSPACE=$HOME/.openclaw-d3/workspace
export EVOMAP_PROXY_PORT=19822
export A2A_NODE_ID=node_gw3_xxxxxxxx
export A2A_NODE_SECRET=<网关 3 的 secret>
export HOME=$HOME/.evolver-home-gw3
mkdir -p "$HOME/.evolver" "$HOME/.evomap"
```

**四个东西必须全部错开，少一个都会复现"只能跑一个"的现象：**

| 项 | 网关 1 | 网关 2 | 网关 3 |
|---|---|---|---|
| 安装目录 | `~/evolver-gw1` | `~/evolver-gw2` | `~/evolver-gw3` |
| `EVOMAP_PROXY_PORT` | `19820` | `19821` | `19822` |
| `A2A_NODE_ID` | `node_gw1_...` | `node_gw2_...` | `node_gw3_...` |
| `HOME`（覆盖后） | `~/.evolver-home-gw1` | `~/.evolver-home-gw2` | `~/.evolver-home-gw3` |

### 2.3 子 agent 怎么办（您最关心的问题）

**子 agent 不要再启 Evolver 进程。** 您只需要在"主 agent 启动它的子 agent 时注入的环境变量"里加一行：

```bash
# 当 main 召唤 z1 时
export EVOLVER_SESSION_SCOPE=workspace-z1
# 召唤 z2
export EVOLVER_SESSION_SCOPE=workspace-z2
# …以此类推
```

共用的**那一个** Evolver（网关 1 实例）会自动把 z1 的进化数据写进：

```
memory/evolution/scopes/workspace-z1/
assets/gep/scopes/workspace-z1/
```

z2、z3、z4 同理。**不需要 4 份 .git，不需要 4 个 Evolver，不需要 4 个 Linux 用户。**

如果主 agent `main` 本身也要独立的进化区域，则给它设 `EVOLVER_SESSION_SCOPE=workspace-main`；不设的话它就使用默认区。

### 2.4 启动 Evolver（用 systemd 托管，避免"过几小时就不见了"）

您提到"让龙虾自检时说 Evolver 没在运行"——那是因为把 Evolver 当成一次性命令在跑，终端一关就没了。正确做法是让系统托管。

在任一个实例里（以网关 1 为例），创建文件 `~/.config/systemd/user/evolver-gw1.service`：

```ini
[Unit]
Description=Evolver (gateway 1)
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/evolver-gw1
# 下面这行把 2.2 节的 env 文件加载进来
EnvironmentFile=%h/evolver-gw1/.evolver-env
ExecStart=/usr/bin/node %h/evolver-gw1/index.js --loop
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

> 注意：`EnvironmentFile` 不能带 `export`。请把 `.evolver-env` 文件里的 `export ` 前缀去掉，只保留 `KEY=VALUE`。下方【给龙虾的自动安装协议】里有去 `export` 版本的模板。

启用并启动：

```bash
systemctl --user daemon-reload
systemctl --user enable --now evolver-gw1.service
systemctl --user status evolver-gw1.service   # 应看到 active (running)
```

网关 2、3 照抄，改名 `evolver-gw2.service`、`evolver-gw3.service`，WorkingDirectory / EnvironmentFile 换成对应路径即可。

从此**机器重启后 Evolver 也会自动起来**，龙虾自检时再也不会找不到。

---

## 3. 与您当前目录结构的迁移步骤

如果您已经照龙虾的旧建议把 Evolver 装到了 `~/.openclaw/workspace/main/evolver`，并且给 z1~z4 各开了 .git——按下面三步迁移：

1. **停掉旧的 Evolver 进程**（如果有）：
   ```bash
   pkill -f 'evolver.*--loop' || true
   rm -f ~/.openclaw/workspace/main/evolver/evolver.pid
   ```
2. **把 z1~z4 里多余的 .git 删掉**（您**不需要**它们，进化所需的唯一 `.git` 由 `EVOLVER_REPO_ROOT` 指向 main）：
   ```bash
   for d in z1 z2 z3 z4; do rm -rf ~/.openclaw/workspace/$d/.git; done
   ```
   > 如果某个子 agent 目录里原本就保存了本地修改，先备份再删。
3. **按第 2 节部署三个独立的 `~/evolver-gw{1,2,3}`**，然后在对应 OpenClaw 启动子 agent 的脚本里，按 2.3 节加 `EVOLVER_SESSION_SCOPE`。

---

## 4. 与其他 skill 的兼容性（`elite-longterm-memory`、`self-improvement`）

简短结论：**不冲突，但需要知道边界。**

- **`elite-longterm-memory`**：这是一个"长期记忆"类 skill，读写自己约定的记忆文件。Evolver 的记忆路径默认在 `$OPENCLAW_WORKSPACE/memory/`，两者不共用同一个文件。**潜在重叠**只在语义上——两者都在"记事"。建议做法：让 elite-longterm-memory 只管跨会话事实性记忆（"用户喜欢/讨厌什么"），把**运行日志、错误信号、进化事件**留给 Evolver；这样语义不重叠，互相增强。
- **`self-improvement`**：这是一个偏"行动级"的自省 skill（反思本次会话、列改进项）。Evolver 做的是"把反思沉淀成可审计、可复用的资产（Gene / Capsule / EvolutionEvent）"，粒度更深、有 git 回滚保护。两者是**上下游关系**：`self-improvement` 产出的结构化反思可以作为 Evolver 的输入信号（写进 `memory/` 即被下一轮 Evolver 扫描到）。不会互相覆盖文件。

如果您发现两者在同一目录里都想写 `memory/`，可以通过 `MEMORY_DIR` 环境变量把 Evolver 的 memory 根改到 `memory-evolver/` 之类的独立子目录，彻底物理隔离。

---

## 5. 常见疑问 FAQ

**Q1：为什么龙虾让我"每个 agent 一个 .git"，然后 Evolver 又只认一个？**
因为 Evolver 进化的目标是"一个 git 工程"——它用 git 做回滚、变更范围、固化（solidify）。一个 Evolver 实例同一时刻只能绑一个仓。多个 agent 想**各自独立进化**→ 就需要多个 Evolver 实例（如第 2 节）；多个 agent **共享进化**（父子）→ 共用一个仓 + `EVOLVER_SESSION_SCOPE` 区分（如 2.3 节）。"每个 agent 一个 .git"只有在您要让它们**彼此完全隔离进化**时才成立，而那时每份 .git 旁边都得配一份 Evolver 实例，这不是您子 agent 的场景。

**Q2：为什么"同一用户只能跑一个 Evolver"？**
不是真限制，是三件事在默认值下撞了：① 安装目录里的 `evolver.pid` 进程锁；② `~/.evolver/settings.json` 和默认端口 19820；③ `~/.evomap/node_id`。按 2.2 节把安装目录、`EVOMAP_PROXY_PORT`、`A2A_NODE_ID`、`HOME` 四者全部错开即可多开。

**Q3：过几小时 Evolver 就"没在运行"了？**
是因为没交给 systemd/supervisor 托管。按 2.4 节配置后，即便崩溃也会 `Restart=always` 拉起，机器重启也能自动恢复。如果您当前**不方便**动 systemd，也可以退而求其次用 `nohup`：
```bash
cd ~/evolver-gw1 && source .evolver-env && nohup node index.js --loop >> evolver.log 2>&1 &
```
但 `nohup` 不保证崩溃重启，推荐还是 systemd。

**Q4：子 agent 的进化会不会把主 agent 的弄脏？**
不会。`EVOLVER_SESSION_SCOPE` 会把每个子 agent 的数据写进独立的 `scopes/<scope>/` 子目录，读的时候也是按 scope 读。主 agent 默认走 scope=空（或您给它设 `workspace-main`）。

**Q5：需要给每个网关在 EvoMap 上单独注册 node 吗？**
是。每个独立 Evolver 实例对应一个 `A2A_NODE_ID`，Hub 按 node_id 发任务、算进化声誉，共用会把三个网关的事件搅在一起。

---

## 6. 【给龙虾的自动安装协议】（Agent-readable install script）

> 如果你是 AI Agent（OpenClaw / 龙虾 / Claude Code / Cursor）正在帮用户安装 Evolver，**严格按本节执行**。不要自行发挥。
>
> 输入变量（由用户或上层编排器注入，缺省则按下述默认）：
>
> - `GATEWAYS`：网关列表，形如 `gw1:/home/u/.openclaw gw2:/home/u/.openclaw-d2 gw3:/home/u/.openclaw-d3`
> - `MAIN_AGENT_OF_<gw>`：该网关下主 agent 的 workspace 子目录名（如 `main`）
> - `SUB_AGENTS_OF_<gw>`：主 agent 的子 agent 列表（空格分隔），例如 `z1 z2 z3 z4`
> - `BASE_PROXY_PORT`：默认 `19820`，依次 +1 分配给每个网关
> - `EVOMAP_CREDENTIALS_<gw>`：`A2A_NODE_ID` 与 `A2A_NODE_SECRET`（用户已在 evomap.ai 注册获得）

### 6.1 前置检查（必须通过，否则停机并向用户报告）

```bash
node -v                 # >= 18
git --version
systemctl --user status >/dev/null 2>&1 && echo "systemd user ok" || echo "no user systemd"
```

### 6.2 对每个网关执行

```bash
# === 对 gw 替换为 gw1 / gw2 / gw3，逐个执行 ===
GW=gw1
GW_HOME=/home/u/.openclaw            # 按 GATEWAYS 取
MAIN_AGENT=main                      # 按 MAIN_AGENT_OF_<gw>
PORT=19820                           # 按 BASE_PROXY_PORT + index

# 1. 克隆独立 Evolver
git clone https://github.com/EvoMap/evolver.git "$HOME/evolver-$GW"
cd "$HOME/evolver-$GW" && npm install

# 2. 隔离 HOME
mkdir -p "$HOME/.evolver-home-$GW/.evolver" "$HOME/.evolver-home-$GW/.evomap"

# 3. 写 env 文件（EnvironmentFile 要求 KEY=VALUE，不带 export）
cat > "$HOME/evolver-$GW/.evolver-env" <<EOF
EVOLVER_REPO_ROOT=$GW_HOME/workspace/$MAIN_AGENT
OPENCLAW_WORKSPACE=$GW_HOME/workspace
EVOMAP_PROXY_PORT=$PORT
A2A_NODE_ID=<用户提供>
A2A_NODE_SECRET=<用户提供>
HOME=$HOME/.evolver-home-$GW
EVOMAP_PROXY=1
EOF

# 4. 写 systemd user unit
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/evolver-$GW.service" <<EOF
[Unit]
Description=Evolver ($GW)
After=network.target

[Service]
Type=simple
WorkingDirectory=$HOME/evolver-$GW
EnvironmentFile=$HOME/evolver-$GW/.evolver-env
ExecStart=/usr/bin/env node $HOME/evolver-$GW/index.js --loop
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

# 5. 启动
systemctl --user daemon-reload
systemctl --user enable --now evolver-$GW.service
```

### 6.3 对主 agent 下的每个子 agent，修改它的启动脚本注入

```bash
export EVOLVER_SESSION_SCOPE=workspace-<子agent名>
```

（子 agent **绝不**执行 6.2 的安装步骤。）

### 6.4 自检（每次完成安装后或用户询问"Evolver 还在跑吗"时）

```bash
# 1. 每个实例的 systemd 状态
for gw in gw1 gw2 gw3; do
  systemctl --user is-active evolver-$gw.service
done

# 2. 端口监听
ss -tlnp | grep -E '19820|19821|19822'

# 3. Proxy 健康
for port in 19820 19821 19822; do
  curl -s http://127.0.0.1:$port/proxy/status | head -c 200; echo
done
```

若任一项失败，先读 `journalctl --user -u evolver-$gw.service -n 200`，再把原始日志返回给用户，不要臆测原因。

### 6.5 什么情况下需要**偏离**本协议

- 用户机器上 **没有 user systemd**（例如容器化部署）→ 改用 6.2 的 4）为 `nohup ... &` 或 `pm2`。
- 用户**只有一个网关**且**没有子 agent** → 只走 6.2 一次，跳过 6.3。
- 用户就是希望子 agent 各自独立进化（不共享记忆）→ 把子 agent 升级为"独立 agent"，按 6.2 走一次（新安装目录、新端口、新 node_id、新 HOME）。

---

## 附录：一张对照表（快速决策）

| 你的场景 | Evolver 实例数 | 需要 `.git` 数 | 区分方式 |
|---|---|---|---|
| 单机、单网关、无子 agent | 1 | 1 | 无 |
| 单机、多网关（您的 3 网关） | N 个网关 = N 个实例 | 每网关 1 份 | 安装目录 / 端口 / node_id / HOME 四维错开 |
| 某网关下主 agent + M 个子 agent | 仍然是 1 个（共享） | 1 份 | `EVOLVER_SESSION_SCOPE=workspace-<子agent名>` |
| 子 agent 希望与主 agent **互不污染进化** | 该子 agent 升级为独立实例 | 各自 1 份 | 同多网关处理 |

---

## 附录：判别式（开发者与 AI 都可机器校验）

两个 Evolver 实例可以安全共存，当且仅当：

```
installDir_A       != installDir_B
EVOMAP_PROXY_PORT_A != EVOMAP_PROXY_PORT_B
A2A_NODE_ID_A      != A2A_NODE_ID_B
HOME_A             != HOME_B   （或各自独立的 ~/.evolver、~/.evomap）
```

两个 agent 应该**共享同一个 Evolver 实例**（不是两个），当且仅当：它们属于同一"主/子"树 **且** 你希望它们共享记忆、共享 Gene、共享进化事件。此时只靠 `EVOLVER_SESSION_SCOPE` 区分 scope，不开新进程。
