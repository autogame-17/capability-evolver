// Innovation Catalyst (v1.0) - Evolver Core Module
// Analyzes system state to propose concrete innovation ideas when stagnation is detected.

const fs = require('fs');
const path = require('path');
const { getSkillsDir } = require('../gep/paths');

function listSkills() {
    try {
        const dir = getSkillsDir();
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    } catch (e) { return []; }
}

function generateInnovationIdeas() {
    const skills = listSkills();
    const categories = {
        'feishu': skills.filter(s => s.startsWith('feishu-')).length,
        'dev': skills.filter(s => s.startsWith('git-') || s.startsWith('code-') || s.includes('lint') || s.includes('test')).length,
        'media': skills.filter(s => s.includes('image') || s.includes('video') || s.includes('music') || s.includes('voice')).length,
        'security': skills.filter(s => s.includes('security') || s.includes('audit') || s.includes('guard')).length,
        'automation': skills.filter(s => s.includes('auto-') || s.includes('scheduler') || s.includes('cron')).length,
        'data': skills.filter(s => s.includes('db') || s.includes('store') || s.includes('cache') || s.includes('index')).length
    };

    // Find under-represented categories
    const sortedCats = Object.entries(categories).sort((a, b) => a[1] - b[1]);
    const weakAreas = sortedCats.slice(0, 2).map(c => c[0]);

    const ideas = [];
    
    // Idea 1: Fill the gap
    if (weakAreas.includes('security')) {
        ideas.push("- Security: Implement a 'dependency-scanner' skill to check for vulnerable packages.");
        ideas.push("- Security: Create a 'permission-auditor' to review tool usage patterns.");
    }
    if (weakAreas.includes('media')) {
        ideas.push("- Media: Add a 'meme-generator' skill for social engagement.");
        ideas.push("- Media: Create a 'video-summarizer' using ffmpeg keyframes.");
    }
    if (weakAreas.includes('dev')) {
        ideas.push("- Dev: Build a 'code-stats' skill to visualize repo complexity.");
        ideas.push("- Dev: Implement a 'todo-manager' that syncs code TODOs to tasks.");
    }
    if (weakAreas.includes('automation')) {
        ideas.push("- Automation: Create a 'meeting-prep' skill that auto-summarizes calendar context.");
        ideas.push("- Automation: Build a 'broken-link-checker' for documentation.");
    }
    if (weakAreas.includes('data')) {
        ideas.push("- Data: Implement a 'local-vector-store' for semantic search.");
        ideas.push("- Data: Create a 'log-analyzer' to visualize system health trends.");
    }

    // Idea 2: Optimization
    if (skills.length > 50) {
        ideas.push("- Optimization: Identify and deprecate unused skills (e.g., redundant search tools).");
        ideas.push("- Optimization: Merge similar skills (e.g., 'git-sync' and 'git-doctor').");
    }

    // Idea 3: Meta
    ideas.push("- Meta: Enhance the Evolver's self-reflection by adding a 'performance-metric' dashboard.");

    return ideas.slice(0, 3); // Return top 3 ideas
}

module.exports = { generateInnovationIdeas };
