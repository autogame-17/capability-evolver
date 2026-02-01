---
name: feishu-card
description: Send rich interactive cards to Feishu (Lark) users or groups. Supports Markdown (code blocks, tables), titles, color headers, and buttons.
tags: [feishu, lark, card, message, interactive, markdown]
---

# Feishu Card Skill

Send rich interactive cards via Feishu Open API.

## ⚠️ CRITICAL FORMATTING RULES (READ BEFORE USING)

1.  **Escape Newlines**: If using `--text` via CLI, you MUST escape newlines as `\\n`.
    - ❌ Wrong: `--text "Line 1\nLine 2"` (Shell eats the backslash)
    - ✅ Right: `--text "Line 1\\nLine 2"`
2.  **Prefer File Input**: For any content longer than one line, **ALWAYS** use `--text-file`.
    - ⚠️ **IMPORTANT**: When creating files in shell, use quoted heredoc `<<'EOF'` to prevent variable expansion (e.g., losing `$100` or `$VAR`).
    - ✅ Best: `cat <<'EOF' > msg.md ... EOF`
3.  **Markdown Support**: Supports **Bold**, *Italic*, [Links](url).
    - ⚠️ **Code Blocks**: Support is limited. Use single backticks \`code\` for safety.

## Usage

```bash
# Via argument (Simple)
node skills/feishu-card/send.js --target "ou_..." --text "Hello **World**"

# Via file (Recommended for Reports/Long Text)
# NOTE: Use 'EOF' (quoted) to prevent shell from eating $variables
cat <<'EOF' > msg.md
**Status**: Ready
**Details**:
- Cost: $100 (Safe from expansion)
- Path: $HOME (Literal text, not expanded)
EOF
node skills/feishu-card/send.js --target "ou_..." --title "Report" --text-file msg.md
rm msg.md
```

## Options
- `-t, --target`: User Open ID (`ou_...`) or Group Chat ID (`oc_...`).
- `-x, --text`: Markdown content.
- `-f, --text-file`: Read markdown from file.
- `--title`: Card header title.
- `--color`: Header color. Allowed: `blue` (default), `wathet`, `turquoise`, `green`, `yellow`, `orange`, `red`, `carmine`, `violet`, `purple`, `indigo`, `grey`.
- `--button-text`: Add a bottom button.
- `--button-url`: Button URL.
