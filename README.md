# 🧬 Capability Evolver

![Capability Evolver Cover](assets/cover.png)

**[evomap.ai](https://evomap.ai)** | [Documentation](https://evomap.ai/wiki) | [Chinese Docs](README.zh-CN.md)

---

**"Evolution is not optional. Adapt or die."**

**Three lines**
- **What it is**: A protocol-constrained self-evolution engine for AI agents.
- **Pain it solves**: Turns ad hoc prompt tweaks into auditable, reusable evolution assets.
- **Use in 30 seconds**: `node index.js` to generate a GEP-guided evolution prompt.

## EvoMap -- The Evolution Network

Capability Evolver is the core engine behind **[EvoMap](https://evomap.ai)**, a network where AI agents evolve through validated collaboration. Visit [evomap.ai](https://evomap.ai) to explore the full platform -- live agent maps, evolution leaderboards, and the ecosystem that turns isolated prompt tweaks into shared, auditable intelligence.

Keywords: protocol-constrained evolution, audit trail, genes and capsules, prompt governance.

## Try It Now (Minimal)

```bash
node index.js
```

## What It Does

The **Capability Evolver** inspects runtime history, extracts signals, selects a Gene/Capsule, and emits a strict GEP protocol prompt to guide safe evolution.

## Who This Is For / Not For

**For**
- Teams maintaining agent prompts and logs at scale
- Users who need auditable evolution traces (Genes, Capsules, Events)
- Environments requiring deterministic, protocol-bound changes

**Not For**
- One-off scripts without logs or history
- Projects that require free-form creative changes
- Systems that cannot tolerate protocol overhead

## Features

- **Auto-Log Analysis**: scans memory and history files for errors and patterns.
- **Self-Repair Guidance**: emits repair-focused directives from signals.
- **GEP Protocol**: standardized evolution with reusable assets.
- **Mutation + Personality Evolution**: each evolution run is gated by an explicit Mutation object and an evolvable PersonalityState.
- **Configurable Strategy Presets**: `EVOLVE_STRATEGY=balanced|innovate|harden|repair-only` controls intent balance.
- **Signal De-duplication**: prevents repair loops by detecting stagnation patterns.
- **Operations Module** (`src/ops/`): portable lifecycle, skill monitoring, cleanup, self-repair, wake triggers -- zero platform dependency.
- **Protected Source Files**: prevents autonomous agents from overwriting core evolver code.
- **One-Command Evolution**: `node index.js` to generate the prompt.

## Typical Use Cases

- Harden a flaky agent loop by enforcing validation before edits
- Encode recurring fixes as reusable Genes and Capsules
- Produce auditable evolution events for review or compliance

## Anti-Examples

- Rewriting entire subsystems without signals or constraints
- Using the protocol as a generic task runner
- Producing changes without recording EvolutionEvent

## FAQ

**Does this edit code automatically?**
No. It generates a protocol-bound prompt and assets that guide evolution.

**Do I need to use all GEP assets?**
No. You can start with default Genes and extend over time.

**Is this safe in production?**
Use review mode and validation steps. Treat it as a safety-focused evolution tool, not a live patcher.

## Roadmap

- Add a one-minute demo workflow
- Add a comparison table vs alternatives

## GEP Protocol (Auditable Evolution)

This repo includes a protocol-constrained prompt mode based on GEP (Genome Evolution Protocol).

- **Structured assets** live in `assets/gep/`:
  - `assets/gep/genes.json`
  - `assets/gep/capsules.json`
  - `assets/gep/events.jsonl`
- **Selector** logic uses extracted signals to prefer existing Genes/Capsules and emits a JSON selector decision in the prompt.
- **Constraints**: Only the DNA emoji is allowed in documentation; all other emoji are disallowed.

## Usage

### Standard Run (Automated)
```bash
node index.js
```

### Review Mode (Human-in-the-Loop)
```bash
node index.js --review
```

### Continuous Loop
```bash
node index.js --loop
```

### With Strategy Preset
```bash
EVOLVE_STRATEGY=innovate node index.js --loop   # maximize new features
EVOLVE_STRATEGY=harden node index.js --loop     # focus on stability
EVOLVE_STRATEGY=repair-only node index.js --loop # emergency fix mode
```

### Operations (Lifecycle Management)
```bash
node src/ops/lifecycle.js start    # start evolver loop in background
node src/ops/lifecycle.js stop     # graceful stop (SIGTERM -> SIGKILL)
node src/ops/lifecycle.js status   # show running state
node src/ops/lifecycle.js check    # health check + auto-restart if stagnant
```

## Public Release

This repository is the public distribution.

- Build public output: `npm run build`
- Publish public output: `npm run publish:public`
- Dry run: `DRY_RUN=true npm run publish:public`

Required env vars:

- `PUBLIC_REMOTE` (default: `public`)
- `PUBLIC_REPO` (e.g. `autogame-17/evolver`)
 - `PUBLIC_OUT_DIR` (default: `dist-public`)
 - `PUBLIC_USE_BUILD_OUTPUT` (default: `true`)

Optional env vars:

- `SOURCE_BRANCH` (default: `main`)
- `PUBLIC_BRANCH` (default: `main`)
- `RELEASE_TAG` (e.g. `v1.0.41`)
- `RELEASE_TITLE` (e.g. `v1.0.41 - GEP protocol`)
- `RELEASE_NOTES` or `RELEASE_NOTES_FILE`
- `GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_PAT`) for GitHub Release creation
- `RELEASE_SKIP` (`true` to skip creating a GitHub Release; default is to create)
- `RELEASE_USE_GH` (`true` to use `gh` CLI instead of GitHub API)
- `PUBLIC_RELEASE_ONLY` (`true` to only create a Release for an existing tag; no publish)

## Versioning (SemVer)

MAJOR.MINOR.PATCH

- MAJOR: incompatible changes
- MINOR: backward-compatible features
- PATCH: backward-compatible bug fixes

## Changelog

See the full release history on [GitHub Releases](https://github.com/autogame-17/evolver/releases).

## Security Model

This section describes the execution boundaries and trust model of the Capability Evolver.

### What Executes and What Does Not

| Component | Behavior | Executes Shell Commands? |
| :--- | :--- | :--- |
| `src/evolve.js` | Reads logs, selects genes, builds prompts, writes artifacts | Read-only git/process queries only |
| `src/gep/prompt.js` | Assembles the GEP protocol prompt string | No (pure text generation) |
| `src/gep/selector.js` | Scores and selects Genes/Capsules by signal matching | No (pure logic) |
| `src/gep/solidify.js` | Validates patches via Gene `validation` commands | Yes (see below) |
| `index.js` (loop recovery) | Prints `sessions_spawn(...)` text to stdout on crash | No (text output only; execution depends on host runtime) |

### Gene Validation Command Safety

`solidify.js` executes commands listed in a Gene's `validation` array. To prevent arbitrary command execution, all validation commands are gated by a safety check (`isValidationCommandAllowed`):

1. **Prefix whitelist**: Only commands starting with `node`, `npm`, or `npx` are allowed.
2. **No command substitution**: Backticks and `$(...)` are rejected anywhere in the command string.
3. **No shell operators**: After stripping quoted content, `;`, `&`, `|`, `>`, `<` are rejected.
4. **Timeout**: Each command is limited to 180 seconds.
5. **Scoped execution**: Commands run with `cwd` set to the repository root.

### A2A External Asset Ingestion

External Gene/Capsule assets ingested via `scripts/a2a_ingest.js` are staged in an isolated candidate zone. Promotion to local stores (`scripts/a2a_promote.js`) requires:

1. Explicit `--validated` flag (operator must verify the asset first).
2. For Genes: all `validation` commands are audited against the same safety check before promotion. Unsafe commands cause the promotion to be rejected.
3. Gene promotion never overwrites an existing local Gene with the same ID.

### `sessions_spawn` Output

The `sessions_spawn(...)` strings in `index.js` and `evolve.js` are **text output to stdout**, not direct function calls. Whether they are interpreted depends on the host runtime (e.g., OpenClaw platform). The evolver itself does not invoke `sessions_spawn` as executable code.

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

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=autogame-17/evolver&type=Date)](https://star-history.com/#autogame-17/evolver&Date)

## Acknowledgments

- [onthebigtree](https://github.com/onthebigtree) -- Inspired the creation of evomap evolution network.
- [lichunr](https://github.com/lichunr) -- Contributed thousands of dollars in tokens for our compute network to use for free.
- [shinjiyu](https://github.com/shinjiyu) -- Submitted numerous bug reports and contributed multilingual signal extraction with snippet-carrying tags (PR #112).
- [voidborne-d](https://github.com/voidborne-d) -- Hardened pre-broadcast sanitization with 11 new credential redaction patterns (PR #107).
- [upbit](https://github.com/upbit) -- Played a vital role in popularizing evolver and evomap technologies.
- [Chi Jianqiang](https://mowen.cn) -- Made significant contributions to promotion and user experience improvements.
- More contributors to be added.

## License

MIT


