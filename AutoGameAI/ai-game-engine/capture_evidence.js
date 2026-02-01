const { chromium } = require('playwright');
const path = require('path');

(async () => {
  try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    // Assuming the app runs on localhost:3000 by default for dev
    // If not running, we might need to build/serve or just render the component in isolation if possible.
    // However, usually for these tasks we expect a running dev server or we can start one.
    // Given the constraints and typical "review" flow, I'll try to start a dev server in background or assume one.
    // Wait, simpler: I'll just try to render the file content if I can't run the full app, 
    // but better to run the app.
    
    // Actually, I'll try to screenshot a "mock" or just the current state if accessible.
    // Since I don't know if the server is running, I will try to start it or just check a static file if it was a static build.
    // But this is a React app. 
    
    // Let's assume standard "npm start" behavior on port 3000.
    // I will try to hit localhost:3000.
    
    console.log("Navigating to localhost:3000...");
    try {
        await page.goto('http://localhost:3000', { timeout: 5000 });
    } catch (e) {
        console.log("Could not reach localhost:3000. Creating a static HTML representation for verification.");
        // Fallback: Create a simple HTML file with the component code visible or a mock layout
        // This is a "Vibe Check", seeing the code change in context is better.
        // But without a running server, I can't see the *rendered* UI.
        
        // Let's fail gracefully if we can't see the UI.
        console.error("Server not running. Cannot take screenshot of live UI.");
        process.exit(1);
    }

    await page.screenshot({ path: 'evidence.png', fullPage: true });
    console.log("Screenshot saved to evidence.png");
    await browser.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
})();
