import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Page } from "puppeteer";
import dotenv from "dotenv";
import { handleBookingConflict } from "../fillers/handleBookingConflict";
import { selectAvailableModules } from "../fillers/selectAllModules";
import { proxyPool, USE_PROXIES } from "../proxyPool";
import { browserArgs } from "../utils/browserArgs";

dotenv.config();
puppeteer.use(StealthPlugin());

// ── Mock account ────────────────────────────────────────────────────────────

const MOCK_ACCOUNT = {
    email: "alisahar0726@gmail.com",
    password: "0565564284Aas!!",
    modules: {
        read: true,
        hear: true,
        write: false,
        speak: false,
    },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (message: string) => console.log(`[test] ${message}`);

const getBackoffDelay = (
    attempt: number,
    baseDelay = 5000,
    maxDelay = 300000
): number => {
    const exponentialDelay = baseDelay * Math.pow(2, Math.min(attempt - 1, 6));
    return Math.min(exponentialDelay, maxDelay);
};

const isRateLimited = async (page: Page): Promise<boolean> => {
    try {
        const title = (await page.title()).toLowerCase();
        const url = page.url().toLowerCase();
        return (
            title.includes("429") ||
            title.includes("too many requests") ||
            title.includes("rate limit") ||
            title.includes("forbidden") ||
            title.includes("access denied") ||
            url.includes("error") ||
            url.includes("blocked")
        );
    } catch {
        return false;
    }
};

const isBookingPageLoaded = async (page: Page): Promise<boolean> => {
    try {
        return (await page.title()).toLowerCase().includes("option");
    } catch {
        return false;
    }
};

const navigateWithTimeout = async (
    page: Page,
    url: string,
    outerAttempt: number,
    maxAttempts = 3
): Promise<{ success: boolean; rateLimited: boolean }> => {
    for (let i = 1; i <= maxAttempts; i++) {
        try {
            log(`🔄 Navigation attempt ${i}/${maxAttempts} (retry ${outerAttempt})`);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 5000 });

            if (await isRateLimited(page)) {
                log(`🚫 Rate limited detected`);
                return { success: false, rateLimited: true };
            }

            log(`✅ Page loaded within timeout`);
            return { success: true, rateLimited: false };
        } catch (error) {
            const err = error as Error;
            if (
                err.message.includes("timeout") ||
                err.message.includes("Navigation timeout")
            ) {
                log(`⏰ Timeout on inner attempt ${i}/${maxAttempts}`);
                if (i < maxAttempts) {
                    await delay(500);
                    continue;
                }
                log(`⚠️ All ${maxAttempts} inner attempts timed out — continuing`);
                return { success: false, rateLimited: false };
            }
            log(`❌ Navigation error: ${err.message}`);
            return { success: false, rateLimited: false };
        }
    }
    return { success: false, rateLimited: false };
};

// ── Main test ────────────────────────────────────────────────────────────────

const runTest = async (oid: string) => {
    log(`Launching browser on :2`);

    let proxy: any = null;
    let proxyUrl = "";
    if (USE_PROXIES) {
        proxy = proxyPool.getNextProxy();
        if (proxy) {
            proxyUrl = `${proxy.host}:${proxy.port}`;
        }
    }

    const args = browserArgs;

    if (proxy) {
        browserArgs.push(
            `--proxy-server=${proxy.type}://${proxy.host}:${proxy.port}`
        );
    }

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: "/usr/bin/google-chrome",
        userDataDir: "./profile",
        env: { DISPLAY: ":2" },
        args,
        defaultViewport: null,
    });


    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", (req) => {
        const type = req.resourceType();
        if (["image", "font", "media"].includes(type)) req.abort();
        else req.continue();
    });

    if (proxy && proxy.username && proxy.password) {
        await page.authenticate({
            username: proxy.username,
            password: proxy.password,
        });
    }

    // Cookie consent bypass
    await page.evaluateOnNewDocument(() => {
        localStorage.setItem(
            "uc_gcm",
            JSON.stringify({
                adsDataRedaction: true,
                adPersonalization: "denied",
                adStorage: "denied",
                adUserData: "denied",
                analyticsStorage: "denied",
            })
        );
        localStorage.setItem("uc_ui_version", "3.73.0");
        localStorage.setItem("uc_user_interaction", "true");
        localStorage.setItem(
            "uc_settings",
            JSON.stringify({
                controllerId:
                    "42e213448633d19d017343f77368ef4ab462b0ca1fb10607c313393260b08f21",
                id: "rTbKQ4Qc-",
                services: [],
            })
        );
    });

    const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;
    const startTime = Date.now();
    const timeoutMs = 5 * 60 * 60 * 1000;
    let consecutiveRateLimits = 0;
    let totalRateLimits = 0;
    let attempts = 0;
    let pageReady = false;

    log(`Navigating to: ${bookingUrl}`);

    // ── Initial navigation ─────────────────────────────────────────────────

    try {
        await page.goto(bookingUrl, { waitUntil: "domcontentloaded", timeout: 5000 });
    } catch {
        log(`Initial navigation timed out — entering retry loop`);
    }

    log(`Initial title: "${await page.title()}"`);

    if (await isBookingPageLoaded(page)) {
        log(`✅ Page already loaded on first attempt`);
        pageReady = true;
    } else if (await isRateLimited(page)) {
        consecutiveRateLimits++;
        totalRateLimits++;
        log(`🚫 Rate limited on initial load — entering retry loop`);
    } else {
        log(`⚠️ Page not loaded correctly (title: "${await page.title()}") — entering retry loop`);
    }

    // ── Retry loop ─────────────────────────────────────────────────────────

    while (!pageReady) {
        const elapsed = Date.now() - startTime;
        if (elapsed > timeoutMs) {
            log(`⏰ Retry timeout (5h) reached — total rate limits: ${totalRateLimits}`);
            await browser.close();
            return;
        }

        attempts++;

        const retryDelay = consecutiveRateLimits > 0
            ? getBackoffDelay(consecutiveRateLimits, 10000, 300000)
            : 5000;

        if (consecutiveRateLimits > 0) {
            log(`🕐 Rate limited ${consecutiveRateLimits}x — backing off ${Math.round(retryDelay / 1000)}s`);
        }

        await delay(retryDelay);

        const navResult = await navigateWithTimeout(page, bookingUrl, attempts);

        if (navResult.rateLimited) {
            consecutiveRateLimits++;
            totalRateLimits++;
            if (consecutiveRateLimits === 1 || consecutiveRateLimits % 3 === 0) {
                const backoff = getBackoffDelay(consecutiveRateLimits, 10000, 300000);
                log(
                    `🚫 Rate limited (${consecutiveRateLimits} consecutive, ${totalRateLimits} total) — next retry in ${Math.round(backoff / 1000)}s`
                );
            }
            continue;
        }

        if (consecutiveRateLimits > 0) {
            log(`✅ Rate limit cleared — resetting backoff`);
            consecutiveRateLimits = 0;
        }

        if (!await isBookingPageLoaded(page)) {
            if (attempts % 20 === 0) {
                log(
                    `⚠️ Still retrying — attempt ${attempts} | title: "${await page.title()}" | elapsed: ${Math.round(elapsed / 60000)} min`
                );
            }
            continue;
        }

        log(
            `✅ Page loaded after ${attempts} attempts (${Math.round(elapsed / 1000)}s) | rate limits: ${totalRateLimits}`
        );
        pageReady = true;
    }

    // ── Automated booking ──────────────────────────────────────────────────

    try {
        log(`Selecting modules...`);
        const availableModules = await selectAvailableModules(page, MOCK_ACCOUNT.modules);
        if (!availableModules) {
            log(`⚠️ Required modules not available — stopping`);
            log(`Keeping browser open 60s to inspect...`);
            await delay(60000);
            await browser.close();
            return;
        }
        log(`✅ Modules selected`);

        await page.waitForSelector("button.cs-button--arrow_next", { visible: true });
        await page.click("button.cs-button--arrow_next");
        log(`✅ Clicked next`);

        await page.waitForNavigation({ waitUntil: "domcontentloaded" });

        await page.waitForSelector("button.cs-layer__button--high", { visible: true });
        const bookForButtons = await page.$$("button.cs-layer__button--high");
        await bookForButtons[1]?.click();
        log(`✅ Clicked book for me`);

        await page.waitForNavigation({ waitUntil: "domcontentloaded" });

        // Login
        await page.waitForSelector("#username", { visible: true });
        await page.type("#username", MOCK_ACCOUNT.email);
        await page.type("#password", MOCK_ACCOUNT.password);
        await page.click('input[type="submit"][name="submit"]');
        log(`🔐 Login submitted`);

        try {
            await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 });
            log(`✅ Login successful`);
        } catch {
            log(`❌ Login failed or timed out — check credentials`);
            log(`Keeping browser open 60s to inspect...`);
            await delay(60000);
            await browser.close();
            return;
        }

        const bookingConflict = await handleBookingConflict(page);
        log(`Booking conflict detected: ${bookingConflict}`);

        await page.click("button.cs-button--arrow_next");
        try {
            await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 5000 });
        } catch {
            log(`ℹ️ No navigation after DOB step (skipped)`);
        }

        await page.click("button.cs-button--arrow_next");
        await page.waitForNavigation({ waitUntil: "networkidle2" });

        if (bookingConflict) {
            await page.click("button.cs-button--arrow_next");
            await page.waitForNavigation({ waitUntil: "networkidle2" });
        }

        log(`✅ Reached payment page — title: "${await page.title()}"`);
        log(`Keeping browser open 5 min to inspect payment page...`);
        await delay(300000);

    } catch (err) {
        log(`❌ Error: ${(err as Error).message}`);
        log(`Keeping browser open 60s to inspect...`);
        await delay(60000);
    }

    await browser.close();
    log(`Browser closed — test complete`);
};

// ── Entry point ──────────────────────────────────────────────────────────────



runTest("13b81c3f40dcf835f612f2c00ff1cf084893f5072e83c0e8c6d13d5ded236095").catch((err) => {
    console.error("Fatal:", err);
});