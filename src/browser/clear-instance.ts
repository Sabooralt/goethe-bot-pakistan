import { Browser, Page } from "puppeteer";


interface BrowserInstance {
    browser: Browser;
    page: Page;
    display: string;
    accountEmail: string;
}

export async function closeBrowserInstance(
    browserInstance: BrowserInstance,
): Promise<void> {
    try {
        console.log(`🔄 Closing browser for ${browserInstance.accountEmail}...`);

        // Set a timeout for browser close operation
        await Promise.race([
            browserInstance.browser.close(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Browser close timeout")), 5000),
            ),
        ]);

        console.log(`Browser closed for ${browserInstance.accountEmail}`);
    } catch (error) {
        console.error(
            `⚠️ Error closing browser for ${browserInstance.accountEmail}:`,
            error,
        );

        // Force kill if normal close fails
        try {
            const pages = await browserInstance.browser.pages();
            await Promise.all(pages.map((page) => page.close().catch(() => { })));
            await browserInstance.browser.close().catch(() => { });
        } catch {
            // Ignore errors in force close
        }
    }
}