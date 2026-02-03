# Feishu Post (RichText) Skill

Send Rich Text (Post) messages to Feishu.
This format is distinct from Cards. It supports native rich text elements but is less flexible in layout than cards. It is better for long-form text mixed with images/links.

## Usage

```bash
node skills/feishu-post/send.js --target "ou_..." --text-file "temp/msg.md" --title "Optional Title"
```

## Options
- `-t, --target <id>`: Target ID (user/chat).
- `-f, --text-file <path>`: Markdown content file.
- `--title <text>`: Title of the post.
