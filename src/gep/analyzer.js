const fs = require('fs');
const path = require('path');

// Innovation: Self-Correction Analyzer
// Analyze past failures to suggest better future mutations
// Pattern: Meta-learning

function analyzeFailures() {
  const memoryPath = path.join(process.cwd(), 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) return { status: 'skipped', reason: 'no_memory' };
  
  const content = fs.readFileSync(memoryPath, 'utf8');
  const failureRegex = /\|\s*\*\*F\d+\*\*\s*\|\s*Fix\s*\|\s*(.*?)\s*\|\s*\*\*(.*?)\*\*\s*\((.*?)\)\s*\|/g;
  
  const failures = [];
  let match;
  while ((match = failureRegex.exec(content)) !== null) {
    failures.push({
      summary: match[1].trim(),
      detail: match[2].trim()
    });
  }
  
  return {
    status: 'success',
    count: failures.length,
    failures: failures.slice(0, 3) // Return top 3 for prompt context
  };
}

if (require.main === module) {
  console.log(JSON.stringify(analyzeFailures(), null, 2));
}

module.exports = { analyzeFailures };
