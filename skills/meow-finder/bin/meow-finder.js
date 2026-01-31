#!/usr/bin/env node

const tools = require('../data/tools.json');

const CATEGORIES = {
  'video': ['video', 'reel', 'shorts', 'animation', 'editing'],
  'image': ['image', 'photo', 'design', 'illustration', 'art'],
  'writing': ['writing', 'copy', 'content', 'blog', 'caption'],
  'code': ['code', 'coding', 'programming', 'developer'],
  'chat': ['chat', 'assistant', 'conversation', 'chatbot'],
  'audio': ['audio', 'music', 'voice', 'speech', 'podcast'],
  'social': ['social', 'instagram', 'twitter', 'linkedin', 'tiktok'],
  'productivity': ['productivity', 'workflow', 'automation', 'schedule'],
  'research': ['research', 'analysis', 'data', 'insights'],
  'marketing': ['marketing', 'ads', 'seo', 'growth']
};

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
😼 meow-finder - Discover AI Tools

Usage:
  meow-finder <search query>     Search for AI tools
  meow-finder --category <cat>   Browse by category
  meow-finder --list             List all categories
  meow-finder --all              Show all tools
  meow-finder --free             Show only free tools

Categories: ${Object.keys(CATEGORIES).join(', ')}

Examples:
  meow-finder video editing
  meow-finder --category social
  meow-finder --free image

Built by Meow 😼 for the Moltbook community 🦞
`);
}

function formatTool(tool) {
  const pricing = tool.free ? '✅ Free' : tool.pricing || '💰 Paid';
  return `
┌─────────────────────────────────────────────
│ ${tool.name}
├─────────────────────────────────────────────
│ ${tool.description}
│ 
│ Category: ${tool.category}
│ Pricing:  ${pricing}
│ URL:      ${tool.url}
└─────────────────────────────────────────────`;
}

function searchTools(query, onlyFree = false) {
  const queryLower = query.toLowerCase();
  let results = tools.filter(t => {
    const searchText = `${t.name} ${t.description} ${t.category} ${t.tags?.join(' ') || ''}`.toLowerCase();
    return searchText.includes(queryLower);
  });
  
  if (onlyFree) {
    results = results.filter(t => t.free);
  }
  
  return results;
}

function getByCategory(category, onlyFree = false) {
  const catLower = category.toLowerCase();
  const keywords = CATEGORIES[catLower] || [catLower];
  
  let results = tools.filter(t => {
    const toolCat = t.category.toLowerCase();
    const toolTags = (t.tags || []).map(tag => tag.toLowerCase());
    return keywords.some(k => toolCat.includes(k) || toolTags.some(tag => tag.includes(k)));
  });
  
  if (onlyFree) {
    results = results.filter(t => t.free);
  }
  
  return results;
}

// Parse arguments
let query = '';
let category = '';
let showAll = false;
let onlyFree = false;
let listCats = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help' || args[i] === '-h') {
    printHelp();
    process.exit(0);
  } else if (args[i] === '--category' || args[i] === '-c') {
    category = args[++i] || '';
  } else if (args[i] === '--all' || args[i] === '-a') {
    showAll = true;
  } else if (args[i] === '--free' || args[i] === '-f') {
    onlyFree = true;
  } else if (args[i] === '--list' || args[i] === '-l') {
    listCats = true;
  } else {
    query += (query ? ' ' : '') + args[i];
  }
}

if (args.length === 0) {
  printHelp();
  process.exit(0);
}

if (listCats) {
  console.log('\n📂 Categories:\n');
  Object.keys(CATEGORIES).forEach(cat => {
    console.log(`  • ${cat}`);
  });
  console.log('');
  process.exit(0);
}

let results = [];

if (showAll) {
  results = onlyFree ? tools.filter(t => t.free) : tools;
} else if (category) {
  results = getByCategory(category, onlyFree);
} else if (query) {
  results = searchTools(query, onlyFree);
}

if (results.length === 0) {
  console.log('\n😿 No tools found. Try a different search term.\n');
  process.exit(0);
}

console.log(`\n🔍 Found ${results.length} tool(s):\n`);
results.slice(0, 10).forEach(tool => {
  console.log(formatTool(tool));
});

if (results.length > 10) {
  console.log(`\n... and ${results.length - 10} more. Use --all to see everything.\n`);
}
