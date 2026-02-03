# Capability Tree (CT) - v1.0.0

**Root**: OpenClaw AI Agent (Main)

## 🌳 Branch 1: Communication
- **Node 1.1: Rich Messaging** (Output)
    - Tool: `feishu-card`
    - Input: Text (Markdown), Title (Optional), Color
    - Constraint: No Title/Footer by default (Clean Mode)
- **Node 1.2: Expressive Reaction** (Output)
    - Tool: `feishu-sticker`
    - Input: Emotion/Intent -> Image File
    - Logic: Auto-cache `image_key`
- **Node 1.3: Persona Management** (Internal)
    - Input: User ID
    - Logic: Switch `SOUL.md` rules based on context

## 🌳 Branch 2: Knowledge & Memory
- **Node 2.1: Atomic Update** (Write)
    - Tool: `memory-manager`
    - Input: Target File, Operation (Replace/Append), Content
    - Guarantee: No `edit` conflicts, normalization
- **Node 2.2: Context Logging** (Write)
    - Method: `logger.js` (Ad-hoc -> Candidate for promotion)
    - Input: Persona, Interaction
- **Node 2.3: Knowledge Retrieval** (Read)
    - Tool: `byterover` / `memory_search`

## 🌳 Branch 3: Intelligence & Analysis
- **Node 3.1: Visual Analysis** (Input)
    - Tool: `sticker-analyzer`
    - Engine: Gemini 2.5 Flash
    - Purpose: Filter junk images, classify stickers
- **Node 3.2: Information Retrieval** (Input)
    - Tool: `web-search-plus`
    - Logic: Auto-route (Serper/Tavily/Exa) based on intent

## 🌳 Branch 4: System Evolution
- **Node 4.1: Self-Improvement** (Meta)
    - Protocol: **PCEC** (Periodic Cognitive Expansion Cycle)
    - Trigger: Cron (3h) / Ad-hoc
    - Output: New Capability Candidates
- **Node 4.2: Stability Control** (Meta)
    - Protocol: **ADL** (Anti-Degeneration Lock)
    - Constraint: Stability > Novelty

---
*Status: Initialized. Ready for growth.*
