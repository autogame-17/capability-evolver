# Prompt Quality Evaluation Framework

Systematic framework for evaluating prompt quality across multiple dimensions.

## Table of Contents

- [Evaluation Dimensions](#evaluation-dimensions)
- [Scoring Rubric](#scoring-rubric)
- [Quality Assessment Process](#quality-assessment-process)
- [Common Anti-Patterns](#common-anti-patterns)
- [Quality Benchmarks](#quality-benchmarks)

---

## Evaluation Dimensions

### 1. Clarity (清晰度)

**Definition:** How unambiguous and easy to understand the prompt is.

**Key Questions:**
- Can the task be understood on first read?
- Are there multiple possible interpretations?
- Is the language precise and specific?
- Are technical terms defined if needed?

**Indicators of Good Clarity:**
✓ Clear, unambiguous language
✓ Specific task description
✓ Defined technical terms
✓ Single interpretation

**Indicators of Poor Clarity:**
✗ Vague or ambiguous phrasing
✗ Multiple possible interpretations
✗ Undefined jargon
✗ Unclear what's being asked

**Examples:**
- Poor: "Write something about AI"
- Good: "Write a 500-word article about the impact of AI on healthcare"
- Excellent: "Write a 500-word article for healthcare professionals about three specific ways AI is transforming patient care, including one real-world example for each"

---

### 2. Specificity (具体性)

**Definition:** How well the prompt defines requirements, constraints, and expectations.

**Key Questions:**
- Are the deliverables clearly defined?
- Are constraints (length, format, style) specified?
- Is the scope clearly bounded?
- Are success criteria explicit?

**Indicators of Good Specificity:**
✓ Clear deliverable definition
✓ Explicit constraints
✓ Bounded scope
✓ Defined success criteria

**Indicators of Poor Specificity:**
✗ Open-ended without boundaries
✗ No format or length guidance
✗ Unclear what "good" looks like
✗ Missing context about audience/purpose

**Examples:**
- Poor: "Write an essay about climate change"
- Good: "Write a 1,200-word persuasive essay about climate change for high school students, arguing for renewable energy investment"
- Excellent: "Write a 1,200-word persuasive essay for high school students arguing that governments should increase renewable energy investment by 50% over the next 5 years. Include: 1) three specific benefits, 2) address two counterarguments, 3) end with a call to action for students"

---

### 3. Structure (结构)

**Definition:** How well-organized and logical the prompt is.

**Key Questions:**
- Is information organized logically?
- Are related concepts grouped together?
- Is there a clear flow from context to task?
- Are complex tasks broken down?

**Indicators of Good Structure:**
✓ Logical organization
✓ Clear sections or components
✓ Appropriate ordering of information
✓ Complex tasks broken into steps

**Indicators of Poor Structure:**
✗ Disorganized information
✓ Jumping between topics
✓ Important details buried
✓ No clear flow or progression

**Examples:**
- Poor: "Here are some things: the deadline is Friday, it's for marketing, we need a blog post, the topic is product launch, keep it casual"

- Good:
```
Context: Marketing blog post
Topic: Product launch
Audience: Current customers
Tone: Casual and friendly

Requirements:
- Deadline: Friday
- Length: 800-1000 words
- Include: 3 key features, customer testimonial
```

- Excellent:
```
# Marketing Blog Post

**Topic:** Product Launch Announcement

**Target Audience:** Existing customers

**Tone:** Casual, friendly, exciting

**Content Requirements:**
1. Introduction: Hook readers with the main benefit
2. Feature highlights: 3 key features with use cases
3. Social proof: Include 1-2 customer quotes
4. Call to action: Clear next step

**Technical Requirements:**
- Length: 800-1000 words
- Format: Blog post with H2 headers
- Deadline: Friday, 5 PM
```

---

### 4. Completeness (完整性)

**Definition:** Whether all necessary context, background, and information is provided.

**Key Questions:**
- Does the model have enough context to understand the task?
- Is background information included?
- Are relevant constraints or preferences mentioned?
- Is the audience and purpose clear?

**Indicators of Good Completeness:**
✓ Sufficient context provided
✓ Background information included
✓ Constraints and preferences specified
✓ Audience and purpose clear

**Indicators of Poor Completeness:**
✗ Missing key context
✗ No background on topic
✗ Important constraints omitted
✗ Unclear who it's for or why

**Examples:**
- Poor: "Write a proposal"

- Good: "Write a proposal for a $50,000 budget to implement a new CRM system for our 50-person sales team"

- Excellent:
```
**Task:** Write a project proposal for CRM implementation

**Context:**
- Company size: 50 employees (30 in sales)
- Current process: Manual spreadsheet tracking
- Pain points: Lost leads, missed follow-ups, no reporting
- Goal: Improve lead conversion by 20% in 6 months

**Proposal Requirements:**
- Budget: $50,000 maximum
- Timeline: 6-month implementation
- Include: Software recommendation, implementation plan, training approach, ROI projection
- Target audience: CFO for approval
```

---

### 5. Tone (语气)

**Definition:** How well the prompt defines the desired voice, style, and attitude.

**Key Questions:**
- Is the expected tone specified?
- Does it match the intended audience?
- Is the style appropriate for the task?
- Are there constraints on formality?

**Indicators of Good Tone:**
✓ Clear tone specification
✓ Appropriate for audience
✓ Matches task purpose
✓ Style constraints defined

**Indicators of Poor Tone:**
✗ No tone guidance
✓ Tone mismatches audience
✓ Inconsistent style
✓ No formality level

**Examples:**
- Poor: "Write an email to customers"

- Good: "Write an email to customers about a product update. Keep it professional and informative."

- Excellent:
```
**Task:** Write an email announcing a product update

**Tone:** Professional, friendly, not overly formal

**Style Guidelines:**
- Use clear, direct language
- Avoid jargon and technical terms
- Be enthusiastic but not salesy
- Include a personal touch (e.g., "We're excited because...")

**Audience:** Existing customers who have used the product for 6+ months

**Key Messages:**
1. What's new
2. Why it matters to them
3. How to get it
4. Support available
```

---

### 6. Constraints (约束)

**Definition:** How well boundaries, limitations, and requirements are specified.

**Key Questions:**
- Are length or format constraints clear?
- Are there things to avoid?
- Are there specific elements that must be included?
- Are boundaries on scope defined?

**Indicators of Good Constraints:**
✓ Clear constraints specified
✓ What to include defined
✓ What to avoid defined
✓ Scope boundaries clear

**Indicators of Poor Constraints:**
✗ No guidance on limits
✓ Unclear what to include/exclude
✓ Open-ended scope
✗ No quality criteria

**Examples:**
- Poor: "Write a story"

- Good: "Write a 500-word mystery story with a surprise ending"

- Excellent:
```
**Task:** Write a mystery story

**Constraints:**
- Length: Exactly 500 words
- Genre: Classic whodunit
- Setting: Single location (a train)
- Characters: 3-5 passengers

**Requirements:**
- Include: Clues (at least 3), red herring (at least 1), detective character
- Avoid: supernatural elements, time travel
- Ending: Surprise reveal that recontextualizes earlier clues

**Style:** Noir, atmospheric, first-person detective narration
```

---

## Scoring Rubric

### Quality Levels

| Level | Score | Description |
|-------|-------|-------------|
| Excellent | 9-10 | Exceeds expectations, minimal improvements possible |
| Good | 7-8 | Solid quality, minor optimizations would help |
| Fair | 5-6 | Functional but has clear weaknesses |
| Poor | 1-4 | Significant issues, needs major revision |

### Dimension Scoring

For each dimension, rate based on these criteria:

**Excellent (9-10):**
- Clear, specific, well-structured, complete
- Examples, constraints, and success criteria provided
- Little to no ambiguity
- Model has everything needed

**Good (7-8):**
- Mostly clear and specific
- Structure is logical
- Most context is provided
- Minor improvements would help

**Fair (5-6):**
- Some ambiguity present
- Structure could be improved
- Missing some context
- Functional but not optimal

**Poor (1-4):**
- Multiple interpretations possible
- Poorly organized
- Missing key information
- Model will struggle

### Overall Quality Calculation

**Weighted Average:**
- Clarity: 20%
- Specificity: 20%
- Structure: 15%
- Completeness: 20%
- Tone: 10%
- Constraints: 15%

**Example Calculation:**
```
Clarity: 8/10 × 0.20 = 1.6
Specificity: 7/10 × 0.20 = 1.4
Structure: 9/10 × 0.15 = 1.35
Completeness: 6/10 × 0.20 = 1.2
Tone: 7/10 × 0.10 = 0.7
Constraints: 5/10 × 0.15 = 0.75

Total: 7.0/10 = Good
```

---

## Quality Assessment Process

### Step 1: Initial Scan
Read the prompt quickly and note:
- First impression of clarity
- Obvious missing information
- Immediate red flags

### Step 2: Dimension-by-Dimension Evaluation
For each dimension:
1. Identify strengths (what works well)
2. Identify weaknesses (what's missing or unclear)
3. Provide specific score (1-10)
4. Note specific improvement opportunities

### Step 3: Calculate Overall Score
Apply weighted average formula.

### Step 4: Generate Recommendations
Based on dimensions with lowest scores:
1. Identify applicable techniques from prompt-techniques.md
2. Prioritize high-impact improvements
3. Provide concrete suggestions

### Step 5: Create Optimization Plan
Organize recommendations into:
- **Must fix** (critical weaknesses)
- **Should fix** (important improvements)
- **Nice to have** (enhancements)

---

## Common Anti-Patterns

### 1. The Ambiguous Ask
**Problem:** Vague language without clear expectations
**Example:** "Make it better" or "Fix this"
**Fix:** Specify what "better" means and what aspects to improve

### 2. The Overload
**Problem:** Too much information, poor organization
**Example:** Long paragraphs mixing context, constraints, and tasks
**Fix:** Use structure, sections, and logical grouping

### 3. The Missing Context
**Problem:** Insufficient background or audience information
**Example:** "Write a blog post" (no topic, audience, or goal)
**Fix:** Provide context about topic, audience, purpose, and constraints

### 4. The Moving Target
**Problem:** Contradictory or evolving requirements
**Example:** "Be creative but follow strict guidelines" without clarification
**Fix:** Resolve contradictions or make them explicit as trade-offs

### 5. The Assumption
**Problem:** Assuming model knows domain-specific context
**Example:** Using technical jargon without explanation
**Fix:** Define terms or provide background knowledge

### 6. The Kitchen Sink
**Problem:** Including irrelevant information
**Example:** 10 paragraphs of background when 2 would suffice
**Fix:** Focus on what's necessary for the task

### 7. The No-Output
**Problem:** Unclear what the final deliverable should be
**Example:** "Think about X" without specifying what to produce
**Fix:** Specify output format, length, and structure

### 8. The Too-Rigid
**Problem:** Over-constraining to the point of impossibility
**Example:** 20 constraints that conflict with each other
**Fix:** Focus on essential constraints, remove non-critical ones

---

## Quality Benchmarks

### By Prompt Type

#### Code Generation
**Excellent:**
```
Write a Python function to sort a list of dictionaries by a specific key.

Requirements:
- Function signature: def sort_dicts(list_of_dicts, key, reverse=False)
- Handle edge cases: empty list, key not found
- Return: New sorted list (don't modify original)
- Include docstring with examples
- Use stable sort (maintain order for equal keys)
```
**Score:** 9.5/10

#### Content Creation
**Excellent:**
```
Write a LinkedIn post announcing our new feature.

Context:
- Feature name: Smart Scheduling
- Main benefit: Saves 2 hours/week for users
- Launch date: Next Monday
- Target: Existing customers (productivity enthusiasts)

Format:
- Length: 150-200 words
- Tone: Professional but excited
- Include: One hook, two bullet points on benefits, CTA
- Emoji: Use sparingly (2-3 max)
```
**Score:** 9/10

#### Analysis
**Excellent:**
```
Analyze the competitive landscape for AI-powered email tools.

Scope:
- Top 5 competitors: [Company A, B, C, D, E]
- Focus on: Pricing, key features, target market, unique positioning

Output format:
- Comparison table with rows for each competitor
- Columns: Pricing, Key Features (3), Target Market, Differentiation
- Summary paragraph: Key insights and gaps
- Bullet list: Opportunities for our product
```
**Score**: 9/10

#### Problem Solving
**Excellent:**
```
Our customer support response time is 48 hours (target: 12 hours).

Analyze the problem and provide a 3-step solution plan.

Consider:
- Current bottlenecks (we suspect manual triage)
- Team size: 5 support agents, 500 tickets/week
- Budget: Can invest up to $10K in tools/training

Provide:
- Root cause diagnosis
- 3 prioritized solutions with:
  * What it is
  * Expected impact (hours saved)
  * Cost (time + money)
  * Implementation timeline
```
**Score**: 8.5/10

### Improvement Targets

| Current Score | Target Score | Priority Improvements |
|---------------|--------------|----------------------|
| 1-4 (Poor) | 7+ (Good) | Add context, clarify task, structure information |
| 5-6 (Fair) | 8+ (Very Good) | Specific constraints, examples, refine tone |
| 7-8 (Good) | 9-10 (Excellent) | Add examples, edge cases, success criteria |

---

## Quick Assessment Checklist

Use this for rapid prompt evaluation:

☐ **Clarity:** Can I understand what's being asked?
☐ **Specificity:** Are deliverables and constraints clear?
☐ **Structure:** Is information organized logically?
☐ **Completeness:** Is there enough context?
☐ **Tone:** Is the expected voice/style specified?
☐ **Constraints:** Are boundaries and requirements defined?

**If 5-6 items checked:** Good quality
**If 3-4 items checked:** Needs improvement
**If 0-2 items checked:** Major revision needed

---

**Note:** Quality is relative to task complexity and requirements. A simple task may need less detail than a complex one. Adjust expectations accordingly.
