import { Page } from "playwright-core";

export async function getProxyIp(page: Page): Promise<string> {
    
    const ipPage = await page.context().newPage();

    try {
        await ipPage.goto("https://api.ipify.org?format=json", {
            waitUntil: "domcontentloaded",
            timeout: 10000,
        });

        return (await ipPage.locator("body").textContent())?.trim() ?? "unknown";
    } finally {
        await ipPage.close();
    }
}