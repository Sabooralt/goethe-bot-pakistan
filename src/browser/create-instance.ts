import { Browser, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

interface BrowserInstance {
  browser: Browser;
  page: Page;
  display: string;
  accountEmail: string;
}

export async function createBrowserInstance(
    account: any,
    display: string,
    retries = 3,
): Promise<BrowserInstance | null> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(
                `🌐 Creating browser for ${account.email} on display ${display} (attempt ${attempt}/${retries})...`,
            );

            const browser = await puppeteer.launch({
                headless: false,
                executablePath: "/usr/bin/chromium-browser",
                env: {
                    DISPLAY: display,
                    CHROME_DEVEL_SANDBOX: "/usr/local/sbin/chrome-devel-sandbox",
                },
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-features=VizDisplayCompositor",
                    "--disable-gpu",
                    "--disable-background-timer-throttling",
                    "--disable-backgrounding-occluded-windows",
                    "--disable-renderer-backgrounding",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-default-apps",
                    "--disable-background-networking",
                    "--disable-breakpad",
                    "--disable-client-side-phishing-detection",
                    "--disable-sync",
                    "--force-color-profile=srgb",
                    "--mute-audio",
                    "--disable-extensions",
                    "--disable-popup-blocking",
                    `--display=${display}`,
                ],
                timeout: 18000000,
                protocolTimeout: 18000000,
            });

            const page = await browser.newPage();

            // Randomize viewport slightly so every instance looks different
            const width = 1280 + Math.floor(Math.random() * 120);
            const height = 720 + Math.floor(Math.random() * 80);
            await page.setViewport({ width, height });

            // Rotate user agents per instance
            const userAgents = [
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            ];
            const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
            await page.setUserAgent(ua);

            // Override fingerprint properties
            await page.evaluateOnNewDocument(() => {
                // Hide webdriver
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                // Randomize platform
                Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });

                // Fake plugins to look like a real browser
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [
                        { name: 'Chrome PDF Plugin' },
                        { name: 'Chrome PDF Viewer' },
                        { name: 'Native Client' },
                    ],
                });

                // Fake languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['de-DE', 'de', 'en-US', 'en'],  // German first since it's Goethe
                });

                // Fix chrome runtime
                (window as any).chrome = {
                    runtime: {},
                    loadTimes: () => { },
                    csi: () => { },
                };

                // Randomize canvas fingerprint slightly
                const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
                HTMLCanvasElement.prototype.toDataURL = function (type, ...args) {
                    const ctx = this.getContext('2d');
                    if (ctx) {
                        const imageData = ctx.getImageData(0, 0, this.width, this.height);
                        for (let i = 0; i < imageData.data.length; i += 100) {
                            imageData.data[i] ^= Math.floor(Math.random() * 3);
                        }
                        ctx.putImageData(imageData, 0, 0);
                    }
                    return originalToDataURL.apply(this, [type, ...args]);
                };
            });

            await page.setDefaultNavigationTimeout(18000000);
            await page.setDefaultTimeout(18000000);

            // Block unnecessary resources
            await page.setRequestInterception(true);
            page.on("request", (req) => {
                const resourceType = req.resourceType();
                if (['image', 'font', 'media', 'other'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.goto("about:blank");
            console.log(`✅ Browser created for ${account.email} on ${display}`);

            return { browser, page, display, accountEmail: account.email };

        } catch (error) {
            console.error(`Failed to create browser for ${account.email} (attempt ${attempt}/${retries}):`, error);
            if (attempt === retries) return null;
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    return null;
}