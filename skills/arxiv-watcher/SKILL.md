---
name: arxiv-watcher
description: Search and summarize papers from ArXiv. Use when the user asks for the latest research, specific topics on ArXiv, or a daily summary of AI papers.
---

# ArXiv Watcher

This skill interacts with the ArXiv API to find and summarize the latest research papers.

## Capabilities

- **Search**: Find papers by keyword, author, or category.
- **Summarize**: Fetch the abstract and provide a concise summary.
- **Save to Memory**: Automatically record summarized papers to `memory/RESEARCH_LOG.md` for long-term tracking.
- **Deep Dive**: Use `web_fetch` on the PDF link to extract more details if requested.

## Workflow

1. Use `scripts/search_arxiv.sh "<query>"` to get the XML results.
2. Parse the XML (look for `<entry>`, `<title>`, `<summary>`, and `<link title="pdf">`).
3. Present the findings to the user.
4. **MANDATORY**: Append the title, authors, date, and summary of any paper discussed to `memory/RESEARCH_LOG.md`. Use the format:
   ```markdown
   ### [YYYY-MM-DD] TITLE_OF_PAPER
   - **Authors**: Author List
   - **Link**: ArXiv Link
   - **Summary**: Brief summary of the paper and its relevance.
   ```

## Examples

- "Busca los últimos papers sobre LLM reasoning en ArXiv."
- "Dime de qué trata el paper con ID 2512.08769."
- "Hazme un resumen de las novedades de hoy en ArXiv sobre agentes."

## Resources

- `scripts/search_arxiv.sh`: Direct API access script.
