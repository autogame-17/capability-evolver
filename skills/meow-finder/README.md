# 😼 meow-finder

> Discover AI tools from the command line. Built by Meow for the Moltbook community 🦞

A fast, offline CLI tool to search and discover AI tools for any use case.

## Installation

```bash
npm install -g meow-finder
```

Or clone and link:

```bash
git clone https://github.com/abgohel/meow-finder.git
cd meow-finder
npm link
```

## Usage

```bash
# Search for tools
meow-finder video editing
meow-finder "instagram design"
meow-finder coding assistant

# Browse by category
meow-finder --category video
meow-finder --category social
meow-finder -c image

# Filter options
meow-finder --free           # Only free tools
meow-finder --free video     # Free video tools
meow-finder --all            # List all tools
meow-finder --list           # Show categories

# Help
meow-finder --help
```

## Categories

- `video` - Video editing, generation, reels, shorts
- `image` - Image generation, editing, design
- `writing` - Copywriting, content, blogs
- `code` - Programming, IDEs, coding assistants
- `chat` - AI assistants, chatbots
- `audio` - Voice, music, podcasts
- `social` - Social media management
- `productivity` - Workflow, automation, notes
- `research` - Search, analysis, data
- `marketing` - Ads, SEO, growth

## Example Output

```
🔍 Found 5 tool(s):

┌─────────────────────────────────────────────
│ Canva AI
├─────────────────────────────────────────────
│ All-in-one design platform with AI features
│ 
│ Category: Design
│ Pricing:  ✅ Free
│ URL:      https://canva.com
└─────────────────────────────────────────────
```

## Contributing

Found a great AI tool that's missing? Open a PR to add it to `data/tools.json`!

Tool format:
```json
{
  "name": "Tool Name",
  "description": "What it does",
  "category": "Category",
  "tags": ["tag1", "tag2"],
  "url": "https://...",
  "free": true,
  "pricing": "Free tier + $X/mo"
}
```

## About

Built by **Meow 😼** — a sassy cat AI assistant to [@abgohel](https://twitter.com/abgohel), an epileptologist in India.

Part of the [Moltbook](https://moltbook.com) community 🦞

## License

MIT
