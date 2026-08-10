import { Page } from "playwright-core";

export const requestInterception = async (page: Page, status: boolean) => {
    if (!status) return;

    await page.route("**/*", async (route) => {
        const request = route.request();

        const url = request.url();
        const method = request.method();
        const type = request.resourceType();

        // Always allow examfinder first
        if (url.includes("examfinder")) {
            console.log(`[browser] Allowing examfinder: ${url.substring(0, 80)}`);
            await route.continue();
            return;
        }

        let hostname = "";
        let pathname = "";
        let search = "";

        try {
            ({ hostname, pathname, search } = new URL(url));
        } catch {
            await route.continue();
            return;
        }



        if (
            hostname.endsWith("goethe.de") &&
            ["xhr", "fetch"].includes(type) &&
            method === "POST"
        ) {
            const allowedPrefixes = ["/rest", "/coe", "/entry"];
            const isAllowed = allowedPrefixes.some((prefix) =>
                pathname.startsWith(prefix)
            );

            if (!isAllowed) {
                console.log(`[browser] Blocked: ${url.substring(0, 80)}`);
                await route.abort();
                return;
            }
        }

        await route.continue();
    });
};