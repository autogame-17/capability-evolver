# Interaction Logger

A robust utility for appending interaction logs to user-specific history files. 
It abstracts away JSON parsing, file I/O, and schema validation.

## Usage

```bash
node skills/interaction-logger/log.js --target <target_alias> --role <role> --content <message>
```

## Arguments

- `--target`: The user alias.
  - `zhy`, `shiqi`, `master` -> `zhy/history.json`
  - `fmw`, `big-brother` -> `fmw/history.json`
- `--role`: Who is speaking (`user` | `assistant` | `system`). Default: `assistant`.
- `--content`: The text content to log.

## Why use this?
- **Safety**: Prevents JSON syntax errors from manual editing.
- **Convenience**: One-line command vs multi-step read/edit/write.
- **Compliance**: Ensures mandatory logging rules (from MEMORY.md) are actually followed.
