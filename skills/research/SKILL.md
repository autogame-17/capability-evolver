---
name: research
description: Deep research via Gemini CLI — runs in background sub-agent so you don't burn your Claude tokens.
homepage: https://github.com/google/gemini-cli
metadata: {"clawdbot":{"emoji":"🔬","requires":{"bins":["gemini"]}}}
---

# Research Skill

Conduct deep research on any topic using Gemini CLI via a spawned sub-agent. Uses your Google AI subscription instead of Claude tokens — perfect for long research tasks that would otherwise eat your Clawdbot usage.

## How It Works

**When user says "Research: [topic]" or asks for deep research:**

### Step 1: Clarifying Questions (Always)

Before running any research, ask 2-3 quick questions to focus the work:

**Start with the goal:**
> "Before I dive in - what's your goal here? Are you learning about this topic, making a decision, writing something, or just curious?"

**Then adapt based on their answer:**

If learning/curious:
- "Any specific aspect you're most interested in?"
- "How technical should I go? (High-level overview vs deep technical detail)"

If decision-making:
- "What decision are you trying to make?"
- "Any specific criteria or constraints I should focus on?"

If writing/creating:
- "What's the output? (Blog post, report, presentation?)"
- "Who's the audience?"

**Keep it natural — 2-3 questions max.** Don't interrogate.

### Step 2: Spawn Research Agent

Once you have context, use `sessions_spawn` to run the research:

```
sessions_spawn(
  task: "Research: [FULL TOPIC WITH CONTEXT]
  
Use Gemini CLI to research this topic. Run:

gemini --yolo \"[RESEARCH PROMPT]\"

The research prompt should ask Gemini to cover:
1. Overview & Core Concepts - what is this, terminology, why it matters
2. Current State - latest developments, major players
3. Technical Deep Dive - how it works, mechanisms, key techniques
4. Practical Applications - real-world use cases, tools available
5. Challenges & Open Problems - technical, ethical, barriers
6. Future Outlook - trends, predictions, emerging areas
7. Resources - key papers, researchers, communities, courses

Save the output to: ~/clawd/research/[slug]/research.md

Be thorough (aim for 500+ lines). Include specific examples and citations.

IMPORTANT - When research is complete:
1. Send a wake event to notify the main agent immediately:
   cron(action: 'wake', text: '🔬 Research complete: [TOPIC]. Key findings: [2-3 bullet points]. Full report: ~/clawd/research/[slug]/research.md', mode: 'now')
2. When asked to produce an announce message, reply exactly: ANNOUNCE_SKIP",
  label: "research-[slug]"
)
```

**Important:** Include all context from your conversation in the task so the sub-agent understands the full picture.

### Step 3: When You Receive Wake Event

You'll receive a wake with the research summary. Then:
- Share the findings with the user
- Offer to read the full report or dive deeper on sections

## Output Location

Research saved to:
```
~/clawd/research/<slug>/research.md
```

## Tips

- Research typically takes 3-8 minutes depending on complexity
- Gemini CLI uses your Google AI subscription quota
- The `--yolo` flag auto-approves file operations (non-interactive)
- Check `~/clawd/research/` for all past research
- Always include conversation context in the spawn task for better results
