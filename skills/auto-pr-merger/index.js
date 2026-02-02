#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const minimist = require('minimist');
const path = require('path');

const args = minimist(process.argv.slice(2));

const pr = args.pr;
const testCommand = args.test;
const maxRetries = args.retries || 3;

if (!pr || !testCommand) {
  console.error('Usage: node skills/auto-pr-merger/index.js --pr <PR_NUMBER> --test "<TEST_COMMAND>" [--retries <NUMBER>]');
  process.exit(1);
}

// Helper to run shell commands
function run(command, ignoreError = false) {
  console.log(`> ${command}`);
  try {
    const output = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    return { success: true, output };
  } catch (error) {
    if (!ignoreError) {
      console.error(`Command failed: ${command}`);
    }
    return { success: false, output: error.stdout + '\n' + error.stderr };
  }
}

async function callLLM(prompt) {
    let apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        // Try to load from .env in workspace root
        const possiblePaths = [
            path.resolve(process.cwd(), '.env'),
            path.resolve(process.cwd(), '..', '.env'),
            path.resolve(__dirname, '../../..', '.env')
        ];
        
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                try {
                    const envContent = fs.readFileSync(p, 'utf8');
                    const match = envContent.match(/^GEMINI_API_KEY=(.*)$/m);
                    if (match) {
                        apiKey = match[1].trim();
                        // Remove quotes if present
                        if ((apiKey.startsWith('"') && apiKey.endsWith('"')) || (apiKey.startsWith("'") && apiKey.endsWith("'"))) {
                            apiKey = apiKey.slice(1, -1);
                        }
                        console.log(`Loaded GEMINI_API_KEY from ${p}`);
                        break;
                    }
                } catch (e) {
                    // ignore read errors
                }
            }
        }
    }

    if (!apiKey) {
        console.warn("GEMINI_API_KEY not found in environment or .env files.");
        return null;
    }
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });
        
        if (!response.ok) {
            console.error(`Gemini API Error: ${response.statusText}`);
            console.error(await response.text());
            return null;
        }
        
        const data = await response.json();
        let text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!text) return null;
        
        // cleanup markdown code blocks if present
        text = text.replace(/^```[a-z]*\n?/im, '').replace(/\n?```$/im, '');
        return text.trim();
    } catch (e) {
        console.error("Failed to call LLM:", e);
        return null;
    }
}

function findFailingFile(output) {
    // Look for common file patterns in error output
    // Prioritize lines with "FAIL" or "Error"
    const lines = output.split('\n');
    const fileRegex = /([a-zA-Z0-9_\-\./]+\.(?:ts|js|tsx|jsx))/;
    
    // Strategy 1: Look for explicit FAIL lines
    for (const line of lines) {
        if (line.includes('FAIL') || line.includes('Error:')) {
            const match = line.match(fileRegex);
            if (match && fs.existsSync(match[1])) {
                return match[1];
            }
        }
    }
    
    // Strategy 2: Just find the first file path that exists in the output
    for (const line of lines) {
         const match = line.match(fileRegex);
         if (match && fs.existsSync(match[1])) {
             return match[1];
         }
    }
    
    return null;
}

async function main() {
  console.log(`Starting Auto PR Merger for PR: ${pr}`);
  console.log(`Test Command: ${testCommand}`);
  console.log(`Max Retries: ${maxRetries}`);

  // 1. Checkout PR
  console.log('\n--- Step 1: Checking out PR ---');
  const checkoutRes = run(`gh pr checkout ${pr}`);
  if (!checkoutRes.success) {
    console.error('Failed to checkout PR. Ensure gh CLI is authenticated and repo is valid.');
    console.error(checkoutRes.output);
    process.exit(1);
  }

  let attempt = 0;
  let testsPassed = false;

  // Loop: Test -> Fix -> Retry
  while (attempt <= maxRetries) {
    console.log(`\n--- Step 2: Running Tests (Attempt ${attempt + 1}/${maxRetries + 1}) ---`);
    const testRes = run(testCommand, true);

    if (testRes.success) {
      console.log('✅ Tests passed!');
      testsPassed = true;
      break;
    } else {
      console.log('❌ Tests failed.');
      console.log('--- Test Output (Tail) ---');
      const outputTail = testRes.output.slice(-2000);
      console.log(outputTail);

      if (attempt < maxRetries) {
        console.log(`\n--- Step 3: Attempting Fix (Attempt ${attempt + 1}) ---`);
        
        const failingFile = findFailingFile(testRes.output);
        
        if (failingFile) {
            console.log(`Found failing file: ${failingFile}`);
            const fileContent = fs.readFileSync(failingFile, 'utf8');
            
            const prompt = `You are an expert developer. The tests failed with this error:\n${outputTail}\n\nHere is the content of ${failingFile}:\n${fileContent}\n\nReturn the fixed code for the entire file. Do not wrap in markdown code blocks, just raw code.`;
            
            console.log("Calling LLM for fix...");
            const fixedCode = await callLLM(prompt);
            
            if (fixedCode) {
                console.log("Received fix from LLM. Applying...");
                fs.writeFileSync(failingFile, fixedCode);
                
                run('git add .');
                const commitRes = run('git commit -m "Auto-fix applied by auto-pr-merger"');
                if (commitRes.success) {
                     run('git push');
                     console.log("Fix pushed to branch.");
                } else {
                    console.log("Nothing to commit (LLM output matched existing file?) or error.");
                }
            } else {
                console.log("LLM failed to return a fix or API key missing.");
            }
        } else {
            console.log("Could not identify failing file from output. Cannot apply AI fix.");
        }

        attempt++;
      } else {
        console.error('\n❌ Max retries reached. Tests still failing.');
        break;
      }
    }
  }

  // 4. Merge if successful
  if (testsPassed) {
    console.log('\n--- Step 4: Merging PR ---');
    // Using --merge --auto to enable auto-merge or merge immediately
    const mergeRes = run(`gh pr merge ${pr} --merge --auto --delete-branch`);
    if (mergeRes.success) {
      console.log('🎉 PR merged successfully!');
    } else {
      console.error('Failed to merge PR.');
      console.error(mergeRes.output);
      process.exit(1);
    }
  } else {
    console.log('\n⛔ Workflow failed. PR not merged.');
    process.exit(1);
  }
}

main();
