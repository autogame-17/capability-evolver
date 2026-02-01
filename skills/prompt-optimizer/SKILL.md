---
name: prompt-optimizer
description: Evaluate, optimize, and enhance prompts using 58 proven prompting techniques. Use when user asks to improve, optimize, or analyze a prompt; when a prompt needs better clarity, specificity, or structure; or when generating prompt variations for different use cases. Covers quality assessment, targeted improvements, and automatic optimization across techniques like CoT, few-shot learning, role-play, and 50+ more.
---

# Prompt Optimizer

## Overview

Evaluate prompt quality, provide targeted improvement suggestions, and generate optimized versions using 58 proven prompting techniques. This skill systematically analyzes prompts across multiple quality dimensions and applies evidence-based optimization patterns.

## Quick Start

For most optimization tasks, follow this workflow:

1. **Analyze the current prompt** - Read and understand what the user wants to achieve
2. **Evaluate quality** - Assess across clarity, specificity, structure, completeness
3. **Load relevant techniques** - Read [references/prompt-techniques.md](references/prompt-techniques.md) for applicable methods
4. **Generate suggestions** - Use evaluation results and techniques to propose improvements
5. **Create optimized version** - Apply chosen techniques to produce an enhanced prompt

## Evaluation Workflow

When a user asks to optimize or evaluate a prompt:

### Step 1: Load Quality Framework

Read [references/quality-framework.md](references/quality-framework.md) to understand evaluation dimensions:

- **Clarity** - Is the prompt unambiguous and easy to understand?
- **Specificity** - Are requirements and constraints clearly defined?
- **Structure** - Does it follow logical organization?
- **Completeness** - Does it include all necessary context and instructions?
- **Tone** - Is the voice appropriate for the task?
- **Constraints** - Are boundaries and limitations clear?

### Step 2: Perform Quality Assessment

Evaluate the prompt against each dimension:

```
For each quality dimension:
1. Identify strengths (what works well)
2. Identify weaknesses (what's missing or unclear)
3. Rate quality (Poor/Fair/Good/Excellent)
4. Note specific improvement opportunities
```

### Step 3: Identify Applicable Techniques

Load [references/prompt-techniques.md](references/prompt-techniques.md) and identify techniques that address the identified weaknesses.

**Example mapping:**
- Weak: "Be creative" → Apply: **Role-play** or **Creative Persona**
- Weak: "Write an essay" → Apply: **Chain of Thought** or **Step-by-Step**
- Weak: "Summarize this" → Apply: **Few-shot Learning** with examples

### Step 4: Generate Optimization Plan

Create a structured optimization plan:

1. **Priority improvements** - High-impact changes that address multiple weaknesses
2. **Optional enhancements** - Nice-to-have techniques that boost performance
3. **Technique combinations** - Suggest technique pairings for specific use cases

### Step 5: Generate Optimized Prompt

Apply the selected techniques to create an improved version:

- Preserve original intent and requirements
- Add structure and clarity where missing
- Embed examples, constraints, or guidance as needed
- Maintain appropriate tone and voice

## Optimization Patterns

For common optimization scenarios, use these proven patterns:

### Ambiguous Requests → Structured Breakdown
When prompt lacks clarity:
1. Add explicit task definition
2. Break into sub-tasks with numbered steps
3. Include output format specification
4. Add completion criteria

### Generic Tasks → Technique Enhancement
When prompt is too broad:
1. Apply relevant technique from [references/prompt-techniques.md](references/prompt-techniques.md)
2. Add examples (few-shot) or reasoning steps (CoT)
3. Include role or persona guidance
4. Specify evaluation criteria

### Missing Context → Scenario Framing
When prompt lacks background:
1. Add user intent/goal statement
2. Include target audience specification
3. Define success metrics
4. Add relevant constraints or boundaries

### Weak Instructions → Actionable Steps
When prompt provides vague guidance:
1. Convert abstract concepts to concrete actions
2. Add step-by-step instructions
3. Include quality checkpoints
4. Specify expected output format

## Script Usage

### Quality Evaluation

For consistent, repeatable evaluation:

```bash
python3 scripts/evaluate.py "Your prompt here"
```

This provides:
- Dimension scores (clarity, specificity, structure, completeness)
- Overall quality rating
- Detailed weakness analysis
- Suggested improvement areas

### Prompt Optimization

For automatic optimization generation:

```bash
python3 scripts/optimize.py "Your prompt here" --techniques "few-shot,coT"
```

This generates:
- Multiple optimized prompt versions
- Explanation of applied techniques
- Comparison with original prompt

**Note:** Scripts should be used for automation or when you need deterministic results. For complex optimization tasks, use the manual workflow for more nuanced analysis.

## Reference Files

### references/prompt-techniques.md
Complete catalog of 58 prompting techniques including:
- Reasoning techniques (CoT, Tree of Thoughts, Decomposition)
- Context techniques (Few-shot, Self-Consistency, Reflection)
- Creative techniques (Role-play, Scenario, Persona)
- Structural techniques (Template, Framework, Checklists)
- And 50+ more with usage examples

Load this when you need to identify applicable techniques for a specific optimization task.

### references/quality-framework.md
Detailed evaluation framework with:
- Dimension-specific criteria and rubrics
- Scoring guidelines
- Common anti-patterns to avoid
- Quality benchmarks for different prompt types

Load this before any evaluation task to ensure consistent assessment.

### references/optimization-patterns.md
Collection of proven optimization patterns including:
- Pattern → Technique mappings
- Before/after examples
- Technique combination guidelines
- Use-case specific templates

Load this when optimizing common prompt types (essays, code generation, analysis, etc.).

## Best Practices

1. **Preserve user intent** - Never change what the user wants, only how they ask for it
2. **Add incrementally** - Apply one technique at a time and evaluate impact
3. **Test iteratively** - After optimization, test the prompt and refine further if needed
4. **Document choices** - Explain which techniques you applied and why
5. **Provide options** - Offer multiple optimization versions when appropriate

## When This Skill Should Trigger

This skill should be activated when:
- User explicitly asks to "optimize," "improve," or "evaluate" a prompt
- User asks if a prompt is "good" or "clear"
- User wants to "fix" or "enhance" a prompt that isn't working well
- User requests "better versions" of a prompt
- User asks about prompt engineering techniques or best practices
- User wants to analyze why a prompt is producing poor results
