import { Page } from "playwright-core";

export async function getProxyIp(page: Page): Promise<string> {
    const response = await page.context().request.get("https://api.ipify.org?format=json");
    const data = await response.json();
    return data.ip ?? "unknown";
}