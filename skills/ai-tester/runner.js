import { chromium } from 'playwright';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

// Try to load .env from CWD and from one level up (workspace root)
dotenv.config();
dotenv.config({ path: '../../.env' }); 

/**
 * AI Tester - A visual testing agent that uses LLMs to navigate and verify UI.
 */
export class AITester {
    constructor(options = {}) {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.debug = options.debug || false;
        
        // Provider setup
        this.provider = 'openai'; // default
        this.modelName = options.model || 'gpt-4o';
        
        if (process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
            this.provider = 'gemini';
            this.apiKey = process.env.GEMINI_API_KEY;
            this.genAI = new GoogleGenerativeAI(this.apiKey);
            this.modelName = options.model || 'gemini-2.0-flash';
        } else if (process.env.OPENAI_API_KEY) {
            this.provider = 'openai';
            this.openai = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
                baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            });
        } else {
            throw new Error("No valid API Key found (OPENAI_API_KEY or GEMINI_API_KEY).");
        }
        
        this.log(`Initialized with provider: ${this.provider}, model: ${this.modelName}`);
    }

    log(msg) {
        if (this.debug) console.log(`[AITester] ${msg}`);
    }

    async start(url) {
        this.log('Launching browser...');
        this.browser = await chromium.launch({ headless: true }); 
        this.context = await this.browser.newContext({
            viewport: { width: 1280, height: 720 }
        });
        this.page = await this.context.newPage();
        
        if (url) {
            this.log(`Navigating to ${url}...`);
            await this.page.goto(url);
            await this.page.waitForLoadState('domcontentloaded');
        }
    }

    async stop() {
        this.log('Closing browser...');
        if (this.browser) await this.browser.close();
    }

    /**
     * Capture current page state as base64 JPEG
     */
    async snapshot() {
        const buffer = await this.page.screenshot({ type: 'jpeg', quality: 60 }); // Lower quality for speed/tokens
        return buffer.toString('base64');
    }

    /**
     * Helper to retry async functions with exponential backoff
     */
    async _retry(fn, retries = 3, delay = 1000) {
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (e) {
                // Don't retry on auth errors or if we ran out of retries
                if (i === retries - 1 || e.message?.includes('401') || e.message?.includes('INVALID_ARGUMENT')) throw e;
                
                this.log(`Attempt ${i + 1} failed: ${e.message}. Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                delay *= 2; 
            }
        }
    }

    /**
     * Ask the LLM to analyze the current screen with a prompt.
     */
    async ask(prompt, systemPrompt = "You are a web automation assistant.") {
        const base64Image = await this.snapshot();
        
        if (this.provider === 'openai') {
            return this._askOpenAI(prompt, systemPrompt, base64Image);
        } else {
            return this._askGemini(prompt, systemPrompt, base64Image);
        }
    }

    async _askOpenAI(prompt, systemPrompt, base64Image) {
        const messages = [
            { role: "system", content: systemPrompt },
            {
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                ]
            }
        ];

        try {
            const response = await this._retry(async () => {
                return await this.openai.chat.completions.create({
                    model: this.modelName,
                    messages: messages,
                    max_tokens: 500,
                    temperature: 0.1,
                    response_format: { type: "json_object" }
                });
            });

            const content = response.choices[0].message.content;
            return this._parseJSON(content);
        } catch (e) {
            this.log(`OpenAI API Error: ${e.message}`);
            return { error: "API Error", details: e.message };
        }
    }

    async _askGemini(prompt, systemPrompt, base64Image) {
        const model = this.genAI.getGenerativeModel({ 
            model: this.modelName
        });

        const fullPrompt = `${systemPrompt}\n\n${prompt}\n\nIMPORTANT: Output ONLY valid JSON. No Markdown code blocks.`;
        const imagePart = {
            inlineData: {
                data: base64Image,
                mimeType: "image/jpeg",
            },
        };

        try {
            const result = await this._retry(async () => {
                return await model.generateContent([fullPrompt, imagePart]);
            });
            const text = result.response.text();
            return this._parseJSON(text);
        } catch (e) {
            this.log(`Gemini API Error: ${e.message}`);
            return { error: "API Error", details: e.message };
        }
    }

    _parseJSON(text) {
        try {
            // 1. Try direct parse
            return JSON.parse(text);
        } catch (e1) {
            try {
                // 2. Clean markdown code blocks
                const cleanText = text.replace(/```json\n?|\n?```/g, "").trim();
                return JSON.parse(cleanText);
            } catch (e2) {
                try {
                    // 3. Extract JSON object from substring
                    const firstOpen = text.indexOf('{');
                    const lastClose = text.lastIndexOf('}');
                    if (firstOpen !== -1 && lastClose !== -1) {
                        const jsonSub = text.substring(firstOpen, lastClose + 1);
                        return JSON.parse(jsonSub);
                    }
                    throw new Error("No JSON found");
                } catch (e3) {
                    this.log(`Failed to parse JSON: ${text}`);
                    return { error: "JSON Parse Error", raw: text };
                }
            }
        }
    }

    async act(intent) {
        this.log(`Action requested: "${intent}"`);
        
        const systemPrompt = `
You are a browser automation agent. 
Analyze the screenshot and the user's intent.
Output a JSON object describing the single best action to take next.

Supported actions:
- { "type": "click", "x": 100, "y": 200, "description": "reason" } 
- { "type": "type", "text": "hello", "description": "reason" } (Assume focus is correct or click first)
- { "type": "wait", "description": "waiting for load" }
- { "type": "finish", "description": "task complete" }

For clicks, estimate the CENTER (x, y) coordinates of the target element based on the screenshot.
The viewport is 1280x720.
`;

        const result = await this.ask(`Goal: ${intent}`, systemPrompt);

        // Safety checks
        if (!result || result.error) {
            this.log(`Action failed due to error: ${result?.error || 'Unknown error'}`);
            return result;
        }

        // Handle the action
        if (result.type === 'click') {
            const x = Math.max(0, Math.min(1280, result.x || 0));
            const y = Math.max(0, Math.min(720, result.y || 0));
            
            this.log(`Clicking at (${x}, ${y}) - ${result.description}`);
            await this.page.mouse.click(x, y);
            await this.page.waitForTimeout(1000); 
        } else if (result.type === 'type') {
            this.log(`Typing "${result.text}" - ${result.description}`);
            await this.page.keyboard.type(result.text || '');
            await this.page.keyboard.press('Enter'); 
            await this.page.waitForTimeout(1000);
        } else {
            this.log(`Action type ${result.type}: ${result.description}`);
        }
        
        return result;
    }

    async verify(assertion) {
        this.log(`Verifying: "${assertion}"`);
        
        const systemPrompt = `
You are a QA testing assistant.
Look at the screenshot and evaluate the assertion.
Output JSON: { "pass": boolean, "reason": "explanation of what you see" }
`;

        const result = await this.ask(`Assertion: ${assertion}`, systemPrompt);
        
        if (result.pass) {
            this.log(`✅ VERIFIED: ${result.reason}`);
        } else {
            this.log(`❌ FAILED: ${result.reason}`);
        }

        return result;
    }
}
