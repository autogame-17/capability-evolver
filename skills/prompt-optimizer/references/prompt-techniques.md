# Prompt Techniques Catalog

Complete catalog of 58 proven prompting techniques organized by category.

## Table of Contents

- [Reasoning Techniques](#reasoning-techniques)
- [Context Techniques](#context-techniques)
- [Creative Techniques](#creative-techniques)
- [Structural Techniques](#structural-techniques)
- [Control Techniques](#control-techniques)
- [Meta Techniques](#meta-techniques)

---

## Reasoning Techniques

### 1. Chain of Thought (CoT)
**Purpose:** Encourage step-by-step reasoning before final answer
**When to use:** Math problems, logic puzzles, complex analysis
**Template:**
```
[Task]

Let's think step by step:
1. [First step reasoning]
2. [Second step reasoning]
3. [Continue reasoning...]

Final answer: [Conclusion]
```
**Example:** "Solve: 2x + 5 = 13. Let's think step by step: 1. Subtract 5 from both sides: 2x = 8. 2. Divide by 2: x = 4."

---

### 2. Tree of Thoughts
**Purpose:** Explore multiple reasoning branches before conclusion
**When to use:** Complex decisions, strategic planning, creative problem solving
**Template:**
```
[Task]

Explore multiple possible approaches:

Approach 1: [Description]
- Reasoning: [Why this approach]
- Outcome: [Expected result]

Approach 2: [Description]
- Reasoning: [Why this approach]
- Outcome: [Expected result]

Compare approaches and select the best one.
```

---

### 3. Least-to-Most Prompting
**Purpose:** Break complex tasks into sub-problems solved sequentially
**When to use:** Multi-step reasoning, complex analysis
**Template:**
```
[Complex Task]

First, identify the sub-problems that need to be solved:
1. [Sub-problem 1]
2. [Sub-problem 2]
3. [Sub-problem 3]

Now solve them in order:
1. [Solve sub-problem 1]
2. [Solve sub-problem 2 using results from 1]
3. [Solve sub-problem 3 using results from 1-2]

Final solution: [Combine results]
```

---

### 4. Self-Consistency
**Purpose:** Generate multiple reasoning paths and select most consistent answer
**When to use:** Ambiguous problems, tasks requiring high confidence
**Template:**
```
[Task]

Generate 3 different approaches to solve this:

Approach 1:
[Reasoning 1]
Answer: [Answer 1]

Approach 2:
[Reasoning 2]
Answer: [Answer 2]

Approach 3:
[Reasoning 3]
Answer: [Answer 3]

Most common answer: [Select consistent answer]
```

---

### 5. Reasoning via Planning
**Purpose:** Explicitly plan execution before acting
**When to use:** Multi-stage tasks, projects, workflows
**Template:**
```
[Task]

Planning Phase:
1. What are the key milestones?
2. What resources are needed?
3. What are potential obstacles?

Execution Plan:
Step 1: [Description]
Step 2: [Description]
Step 3: [Description]

Now execute the plan:
[Detailed execution]
```

---

### 6. Decomposition
**Purpose:** Break down complex problems into manageable components
**When to use:** Large-scale analysis, system design
**Template:**
```
[Complex Problem]

Decompose into components:

Component 1: [Name]
- Definition: [What it includes]
- Considerations: [Key factors]

Component 2: [Name]
- Definition: [What it includes]
- Considerations: [Key factors]

Now analyze each component:
[Analysis for each]
```

---

### 7. Analogical Reasoning
**Purpose:** Use analogies to explain complex concepts
**When to use:** Technical explanations, teaching, making abstract ideas concrete
**Template:**
```
[Complex Concept]

Explain using an analogy:

Analogy: [Similar familiar situation]
- Similarities: [What's comparable]
- Differences: [What's different]
- Key insight: [What the analogy reveals]

Explanation: [Use analogy to explain]
```

---

## Context Techniques

### 8. Few-Shot Learning
**Purpose:** Provide examples to guide output format and style
**When to use:** Pattern recognition, format-specific tasks, style transfer
**Template:**
```
[Task description]

Example 1:
Input: [Example input]
Output: [Example output]

Example 2:
Input: [Example input]
Output: [Example output]

Example 3:
Input: [Example input]
Output: [Example output]

Now, new input: [Target input]
Output:
```

---

### 9. Zero-Shot Chain of Thought
**Purpose:** Combine CoT reasoning without examples
**When to use:** Quick reasoning tasks when examples aren't available
**Template:**
```
[Task]

Let's think step by step:

[Reasoning steps]

Therefore, the answer is:
```

---

### 10. Context Reframing
**Purpose:** Provide broader context to frame the task properly
**When to use:** Misaligned responses, when model misses the point
**Template:**
```
Context:
[Background information]
[Domain knowledge]
[Relevant constraints]

Task:
[Main request]
```

---

### 11. Knowledge Injection
**Purpose:** Provide specific domain knowledge not in training data
**When to use:** Specialized domains, recent events, proprietary information
**Template:**
```
Domain Knowledge:
[Specific facts/data]
[Technical details]
[Relevant information]

Task: [Apply this knowledge]
```

---

### 12. Scenario-Based
**Purpose:** Place task in realistic scenario for better context
**When to use:** Practical applications, training, real-world simulation
**Template:**
```
Scenario:
[Describe realistic situation]
[Set the scene]
[Establish context]

In this scenario, [task]:
[Specific request]
```

---

### 13. Reflection
**Purpose:** Ask model to reflect on its own output before finalizing
**When to use:** Quality-critical tasks, complex reasoning
**Template:**
```
[Task]

Initial response:
[Generate answer]

Now reflect:
- What assumptions did I make?
- Are there any weaknesses in this response?
- What could be improved?

Final refined response:
[Improved answer]
```

---

### 14. Self-Correction
**Purpose:** Explicitly ask model to identify and fix errors
**When to use:** Tasks prone to mistakes, debugging, quality assurance
**Template:**
```
[Task]

First attempt:
[Generate answer]

Critique:
[Identify any errors or issues]

Corrected attempt:
[Fix identified issues]
```

---

## Creative Techniques

### 15. Role-Play
**Purpose:** Assign a specific persona or role to the model
**When to use:** Specialized expertise, creative writing, specific perspectives
**Template:**
```
You are an expert [role] with [qualifications].

Role characteristics:
- Expertise in [specific areas]
- Typical tone: [professional, casual, academic, etc.]
- Key considerations: [what this role cares about]

Task: [Request in character]
```

---

### 16. Creative Persona
**Purpose:** Embody a creative identity for artistic or innovative output
**When to use:** Creative writing, art direction, innovative thinking
**Template:**
```
You are a [creative identity - e.g., visionary artist, innovative designer].

Style characteristics:
- Aesthetic: [description]
- Approach: [how you create]
- Inspirations: [who influences you]

Create: [Creative task]
```

---

### 17. Brainstorming Mode
**Purpose:** Generate quantity over quality, defer judgment
**When to use:** Idea generation, exploring possibilities
**Template:**
```
Task: [Brainstorming topic]

Generate 20+ ideas. Focus on quantity. Don't judge or filter.
Embrace wild and unconventional ideas.

Ideas:
[List ideas rapidly]
```

---

### 18. SCAMPER
**Purpose:** Use systematic creativity technique (Substitute, Combine, Adapt, Modify, Put to other uses, Eliminate, Reverse)
**When to use:** Innovation, improving existing ideas, creative problem solving
**Template:**
```
Idea to improve: [Current idea]

Apply SCAMPER:

Substitute: What can be replaced?
[Substitutions]

Combine: What can be merged?
[Combinations]

Adapt: What can be borrowed from elsewhere?
[Adaptations]

Modify: What can be changed?
[Modifications]

Put to other uses: How else can this be used?
[Alternative uses]

Eliminate: What's unnecessary?
[Eliminations]

Reverse: What can be reversed?
[Reversals]

Best new ideas:
[Select top ideas from SCAMPER]
```

---

### 19. Creative Constraints
**Purpose:** Use limitations to spur creativity
**When to use:** Artistic tasks, design, innovative problem solving
**Template:**
```
Create: [Creative task]

Constraints:
1. [Constraint 1 - e.g., exactly 100 words]
2. [Constraint 2 - e.g., cannot use the letter 'e']
3. [Constraint 3 - e.g., must use a specific metaphor]

Work:
[Creative output within constraints]
```

---

### 20. Storytelling Format
**Purpose:** Present information as a narrative
**When to use:** Making content engaging, teaching, presentations
**Template:**
```
Topic: [Information to convey]

Tell it as a story with:
- A compelling opening
- A clear conflict or challenge
- A journey or process
- A satisfying resolution

Story:
[Narrative format]
```

---

### 21. Metaphorical Thinking
**Purpose:** Use metaphors to explain or create
**When to use:** Explaining abstract concepts, creative writing
**Template:**
```
Concept: [To explain]

Use a powerful metaphor to explain this.

Metaphor: [The metaphor]
Explanation: [How the metaphor maps to the concept]
```

---

## Structural Techniques

### 22. Template-Based
**Purpose:** Use structured template for consistent output
**When to use:** Repeated tasks, standard formats, documentation
**Template:**
```
[Task]

Use this template:

## [Section 1]
[Content]

## [Section 2]
[Content]

## [Section 3]
[Content]

Fill in the template:
[Output following structure]
```

---

### 23. Framework Application
**Purpose:** Apply established frameworks (SWOT, STAR, etc.)
**When to use:** Business analysis, strategic planning, structured thinking
**Template:**
```
[Analysis task]

Apply the [Framework Name] framework:

[Framework component 1]: [Content]
[Framework component 2]: [Content]
[Framework component 3]: [Content]
[Framework component 4]: [Content]

Analysis:
[Interpretation of framework output]
```

---

### 24. Checklist-Driven
**Purpose:** Ensure all requirements are met with a checklist
**When to use:** Quality assurance, comprehensive tasks, validation
**Template:**
```
[Task]

Before finalizing, ensure:

☐ [Requirement 1]
☐ [Requirement 2]
☐ [Requirement 3]
☐ [Requirement 4]
☐ [Requirement 5]

Completed output:
[Only after checking all items]
```

---

### 25. Format Specification
**Purpose:** Explicitly define output format
**When to use:** Data extraction, specific document types, structured output
**Template:**
```
[Task]

Output format:
- JSON with keys: [key1], [key2], [key3]
- Or Markdown table with columns: [col1], [col2], [col3]
- Or bulleted list
- Or numbered list

Specify which format and provide:
[Formatted output]
```

---

### 26. Progressive Disclosure
**Purpose:** Reveal information gradually
**When to use:** Teaching, complex explanations, tutorials
**Template:**
```
[Topic]

First, start with the basics:
[Simple overview]

Now build on that with intermediate concepts:
[Add complexity]

Finally, advanced details:
[Deep dive]

Summary:
[Tie it all together]
```

---

### 27. Modular Breakdown
**Purpose:** Divide task into independent, reusable modules
**When to use:** Complex systems, code generation, curriculum design
**Template:**
```
[Complex Task]

Break into modules:

Module A: [Name and purpose]
- Input: [What it needs]
- Output: [What it produces]
- Dependencies: [What it needs from other modules]

Module B: [Name and purpose]
[Same structure]

Module C: [Name and purpose]
[Same structure]

Now implement each module:
[Detailed implementation]
```

---

## Control Techniques

### 28. Negative Constraints
**Purpose:** Specify what NOT to do
**When to use:** Avoiding specific errors, filtering out unwanted content
**Template:**
```
[Task]

Do NOT:
- [Prohibition 1]
- [Prohibition 2]
- [Prohibition 3]

Allowed approach:
[Positive guidance]
```

---

### 29. Output Constraints
**Purpose:** Limit output length, complexity, or format
**When to use:** Conciseness requirements, token limits, specific formats
**Template:**
```
[Task]

Constraints:
- Maximum length: [e.g., 200 words]
- Must include: [Required elements]
- Must exclude: [Forbidden elements]
- Format: [e.g., bullet list]

Output:
[Constrained result]
```

---

### 30. Tone Specification
**Purpose:** Define the voice and attitude of the output
**When to use:** Brand alignment, audience targeting, appropriate communication
**Template:**
```
[Task]

Tone: [Professional / Friendly / Academic / Casual / etc.]
Voice: [First person / Third person / etc.]
Style: [Formal / Conversational / Technical / etc.]

Output:
[Content matching specified tone]
```

---

### 31. Quality Criteria
**Purpose:** Define standards the output must meet
**When to use:** Quality-critical work, evaluation tasks, deliverables
**Template:**
```
[Task]

Quality criteria:
☐ [Criterion 1 - e.g., "All claims must be supported by evidence"]
☐ [Criterion 2]
☐ [Criterion 3]

Self-evaluation after output:
[Check against criteria]
```

---

### 32. Step-by-Step Instructions
**Purpose:** Provide explicit procedural guidance
**When to use:** How-to tasks, tutorials, process documentation
**Template:**
```
[Task]

Follow these steps:

Step 1: [Action]
[Detail on how to do it]

Step 2: [Action]
[Detail on how to do it]

Step 3: [Action]
[Detail on how to do it]

Continue to completion.
```

---

### 33. Guided Exploration
**Purpose:** Direct exploration while allowing discovery
**When to use:** Learning, research, open-ended investigation
**Template:**
```
[Exploration topic]

Start by exploring:
[Initial direction to look]

Then investigate:
[Next area to explore]

Finally, examine:
[Final area to check]

Synthesize findings:
[Summary of discoveries]
```

---

### 34. Controlled Generation
**Purpose:** Use specific constraints to guide output
**When to use:** Specific vocabulary, terminology, style requirements
**Template:**
```
[Task]

Must use these terms:
- [Term 1]
- [Term 2]
- [Term 3]

Must avoid these terms:
- [Term 1]
- [Term 2]

Output:
[Content respecting constraints]
```

---

## Meta Techniques

### 35. Prompt Chaining
**Purpose:** Chain multiple prompts together for complex tasks
**When to use:** Multi-stage workflows, complex processing
**Template:**
```
Stage 1: [First task]
[Generate intermediate output]

Stage 2: [Use stage 1 output]
[Process further]

Stage 3: [Use stage 2 output]
[Final result]
```

---

### 36. Multi-Persona Debate
**Purpose:** Use different personas to debate and reach consensus
**When to use:** Complex decisions, exploring multiple perspectives
**Template:**
```
[Decision/Question]

Persona A: [Expert 1 perspective]
[Their argument]

Persona B: [Expert 2 perspective]
[Their argument]

Persona C: [Expert 3 perspective]
[Their argument]

Synthesis:
[Weigh arguments and provide balanced conclusion]
```

---

### 37. Self-Evaluation
**Purpose:** Ask model to rate and improve its own output
**When to use:** Quality improvement, iterative refinement
**Template:**
```
[Task]

Initial output:
[Generate answer]

Now evaluate:
- Quality rating (1-10): [Score]
- What's good: [Strengths]
- What needs improvement: [Weaknesses]

Improved version:
[Address weaknesses]
```

---

### 38. Verification Steps
**Purpose:** Include explicit verification in the process
**When to use:** Critical tasks, fact-checking, validation
**Template:**
```
[Task]

Step 1: [Initial generation]

Step 2: Verify:
- Check [validation criteria]
- Cross-reference [sources/data]
- Identify potential errors

Step 3: Correct and finalize:
[Address any issues found]
```

---

### 39. Meta-Cognitive Prompting
**Purpose:** Explicitly reason about the reasoning process
**When to use:** Complex problem solving, teaching reasoning
**Template:**
```
[Task]

Before answering, think about:
1. What approach will I use?
2. What are the key challenges?
3. How will I structure my reasoning?

Approach: [Selected method]
Challenges: [Anticipated difficulties]
Structure: [Organization plan]

Now solve:
[Detailed reasoning and solution]

Reflection on process:
[What worked well, what didn't]
```

---

### 40. Temperature Control
**Purpose:** Adjust creativity vs. precision through prompt instruction
**When to use:** Need more creative or more deterministic output
**Template:**
```
[Task]

Be very creative and explore diverse ideas: [For high creativity]
OR

Be precise and stick to the most likely answer: [For high precision]
```

---

### 41. Iterative Refinement
**Purpose:** Generate, evaluate, and refine multiple times
**When to use:** Quality-critical work, complex creative tasks
**Template:**
```
[Task]

Draft 1:
[Initial attempt]

Critique 1:
[What to improve]

Draft 2:
[Second attempt incorporating feedback]

Critique 2:
[Further improvements]

Final version:
[Polished result]
```

---

### 42. Perspective Taking
**Purpose:** Explicitly consider different viewpoints
**When to use:** Sensitive topics, diverse audiences, balanced analysis
**Template:**
```
[Topic]

Consider from these perspectives:

Perspective 1: [Group/Stakeholder]
- Their view: [Position]
- Key concerns: [What matters to them]

Perspective 2: [Group/Stakeholder]
- Their view: [Position]
- Key concerns: [What matters to them]

Perspective 3: [Group/Stakeholder]
- Their view: [Position]
- Key concerns: [What matters to them]

Balanced analysis:
[Synthesis of perspectives]
```

---

## Additional Techniques (43-58)

### 43. Compare and Contrast
**Purpose:** Systematically compare multiple items
**Template:** "Compare X and Y on: criteria 1, criteria 2, criteria 3. Highlight similarities and differences."

### 44. Pros and Cons
**Purpose:** Weigh advantages and disadvantages
**Template:** "List pros and cons of [decision/topic]. Provide balanced analysis."

### 45. Root Cause Analysis
**Purpose:** Identify underlying causes, not just symptoms
**Template:** "For [problem], apply 5 Whys to find root cause. 1. Why? [Answer]. 2. Why? [Answer]. Continue 5 times."

### 46. First Principles
**Purpose:** Break down to fundamental truths and build up
**Template:** "Analyze [topic] from first principles. What are the fundamental truths? What can be concluded from them?"

### 47. Worst-Case Scenario
**Purpose:** Plan for potential failures
**Template:** "Consider worst-case scenarios for [plan]. What could go wrong? How to mitigate?"

### 48. Best-Case Scenario
**Purpose:** Plan for optimal outcomes
**Template:** "What's the best possible outcome for [initiative]? What conditions would enable this?"

### 49. Devil's Advocate
**Purpose:** Challenge assumptions and arguments
**Template:** "Play devil's advocate for [position]. Argue against it strongly, then rebut those arguments."

### 50. Reverse Engineering
**Purpose:** Work backwards from desired outcome
**Template:** "To achieve [goal], work backwards. What must happen right before that? And before that?"

### 51. Gap Analysis
**Purpose:** Identify difference between current and desired state
**Template:** "Current state: [now]. Desired state: [goal]. Gap analysis: What's missing? How to bridge?"

### 52. Risk Assessment
**Purpose:** Identify and evaluate risks
**Template:** "For [project/situation], identify risks. Rate by likelihood (Low/Med/High) and impact (Low/Med/High). Suggest mitigations."

### 53. Value Proposition
**Purpose:** Articulate value and benefits clearly
**Template:** "What's the value proposition of [product/idea]? For [target audience], what problem does it solve and what benefit does it provide?"

### 54. Elevator Pitch
**Purpose:** Convince quickly in short format
**Template:** "Create a 30-second elevator pitch for [idea/product]. Hook: [Grab attention]. Value: [What's offered]. Call to action: [Next step]."

### 55. Before-After-Bridge
**Purpose:** Persuasive copywriting framework
**Template:** "Before: [Current painful situation]. After: [Desired future state]. Bridge: [How to get from before to after with your solution]."

### 56. Problem-Agitation-Solution
**Purpose:** Persuasive marketing framework
**Template:** "Problem: [Identify pain]. Agitation: [Make it worse/emotional]. Solution: [Your answer to the problem]."

### 57. Feature-Benefit-Proof
**Purpose:** Sales and marketing framework
**Template:** "For each feature: 1) What it does (Feature), 2) What it delivers (Benefit), 3) Evidence (Proof)."

### 58. Situational Analysis
**Purpose:** Comprehensive context assessment
**Template:** "Analyze situation: Internal factors (strengths, weaknesses). External factors (opportunities, threats). Recommendations based on analysis."

---

## Technique Selection Guide

Use this guide to choose the right technique:

| Need | Best Technique(s) |
|------|------------------|
| Complex reasoning | CoT, Tree of Thoughts, Decomposition |
| Format consistency | Few-Shot, Template-Based |
| Creative output | Role-Play, Brainstorming, Creative Persona |
| Quality assurance | Self-Correction, Verification, Reflection |
| Teaching/explaining | Progressive Disclosure, Analogical Reasoning |
| Structured output | Format Specification, Checklist-Driven |
| Multiple perspectives | Multi-Persona Debate, Perspective Taking |
| Decision making | Compare/Contrast, Pros/Cons, Risk Assessment |

---

**Note:** Many techniques work well in combination. For example, Role-Play + CoT provides expert reasoning with step-by-step structure. Experiment with combinations for optimal results.
