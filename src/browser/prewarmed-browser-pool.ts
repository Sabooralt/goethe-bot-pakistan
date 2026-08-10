import { Browser, BrowserContext, Page, chromium } from "playwright-core";
import { proxyPool, USE_PROXIES } from "../proxyPool";
import { Camoufox, LaunchOptions } from "camoufox-js";
import { LaunchOptions as LaunchOptions2 } from "playwright-core";
import { CookieConsentBypass } from "./cookieConsentBypass";

const BROWSER_COUNT = parseInt(process.env.BROWSER_COUNT || "20", 10);

interface PrewarmedBrowser {
    browser: Browser;
    context: BrowserContext;
    page: Page;
    display: string;
    browserNumber: number;
    isReady: boolean;
    createdAt: Date;
    proxyUsed?: string;
}

const activeDisplays = new Set<string>();
const displayPool: string[] = Array.from({ length: BROWSER_COUNT }, (_, i) => `:${i + 1}`);

class PrewarmedBrowserPool {
    private browsers: Map<number, PrewarmedBrowser> = new Map();
    private warmingUp: Set<number> = new Set();
    private displayAllocationLock = Promise.resolve();
    private preNavigated = false;



    private async allocateDisplay(): Promise<string | null> {
        return new Promise((resolve) => {
            this.displayAllocationLock = this.displayAllocationLock.then(async () => {
                for (const display of displayPool) {
                    if (!activeDisplays.has(display)) {
                        activeDisplays.add(display);
                        console.log(
                            `[preWarm] Allocated ${display} (${activeDisplays.size}/${displayPool.length})`
                        );
                        resolve(display);
                        return;
                    }
                }
                console.warn(`⚠️ All displays busy`);
                resolve(null);
            });
        });
    }

    private releaseDisplay(display: string): void {
        if (activeDisplays.has(display)) {
            activeDisplays.delete(display);
            console.log(`♻️ Released ${display}`);
        }
    }

    private async prewarmBrowser(
        browserNumber: number,
        display: string
    ): Promise<PrewarmedBrowser | null> {
        try {
            console.log(`[preWarm] Pre-warming browser ${browserNumber} on ${display}...`);
            function pickOS(): LaunchOptions["os"] {
                const r = Math.random();

                if (r < 0.7) return "windows";
                if (r < 0.9) return "macos";
                return "linux";
            }



            const args: LaunchOptions = {
                os: pickOS(),
                geoip: true,
                humanize: 1.5,
                block_images: false,
                block_webrtc: true,
                screen: {
                    minWidth: 1024,
                    maxWidth: 1920,
                    minHeight: 768,
                    maxHeight: 1080
                },
                headless: false,
                fonts: ['Arial', 'Times New Roman'],
                env: {
                    ...process.env,
                    DISPLAY: display,
                }
            };

            let proxy: any = null;
            let proxyUrl = "";
            if (USE_PROXIES) {
                proxy = proxyPool.getNextProxy();
                if (proxy) {
                    proxyUrl = `${proxy.host}:${proxy.port}`;
                    console.log(`[proxy] Proxy ${proxyUrl} → Browser ${browserNumber}`);
                }
            }

            if (proxy) {
                args.proxy = {
                    server: proxyUrl,
                    username: proxy.username,
                    password: proxy.password
                };
            }

            /*  const browser = await chromium.launch(args2) */
            const browser = await Camoufox(args);

            const context = await browser.newContext({
                extraHTTPHeaders: {
                    'Connection': 'close'
                }
            }
            );

            const page = await context.newPage();
            await page.setDefaultNavigationTimeout(180000);
            await page.setDefaultTimeout(20000);
            await CookieConsentBypass(page, true);
            console.log(`[preWarm] Pre-warmed browser ${browserNumber}`);



            return {
                browser,
                context,
                page,
                display,
                browserNumber,
                isReady: true,
                createdAt: new Date(),
                proxyUsed: proxyUrl,
            };
        } catch (error) {
            console.error(`[preWarm] Pre-warm failed browser ${browserNumber}:`, error);
            this.releaseDisplay(display);
            return null;
        }
    }



    async warmupBrowsers(): Promise<void> {
        try {
            const warmupStart = performance.now();
            console.log(`🔥 Warming up ${BROWSER_COUNT} browsers...`);

            const warmupPromises = [];

            for (let i = 1; i <= BROWSER_COUNT; i++) {
                if (this.warmingUp.has(i) || this.browsers.has(i)) {
                    continue;
                }

                this.warmingUp.add(i);

                const warmupPromise = (async (browserNumber: number) => {
                    try {
                        const display = await this.allocateDisplay();
                        if (!display) {
                            console.warn(`⚠️ No display for browser ${browserNumber}`);
                            this.warmingUp.delete(browserNumber);
                            return;
                        }

                        const prewarmed = await this.prewarmBrowser(browserNumber, display);

                        if (prewarmed) {
                            this.browsers.set(browserNumber, prewarmed);
                            console.log(
                                `✅ Browser ${browserNumber} warmed (${this.browsers.size}/${BROWSER_COUNT})`
                            );
                        } else {
                            this.releaseDisplay(display);
                        }
                    } catch (error) {
                        console.error(`❌ Browser ${browserNumber} warmup failed:`, error);
                    } finally {
                        this.warmingUp.delete(browserNumber);
                    }
                })(i);

                warmupPromises.push(warmupPromise);
            }

            await Promise.all(warmupPromises);

            const totalWarmupTime = performance.now() - warmupStart;

            console.log(
                `🎉 Warmup complete! ` +
                `${this.browsers.size}/${BROWSER_COUNT} ready ` +
                `in ${totalWarmupTime.toFixed(2)} ms ` +
                `(${(totalWarmupTime / 1000).toFixed(3)} s)`
            );
        } catch (error) {
            console.error(`❌ Warmup error:`, error);
        }
    }

    // Get all ready browsers for simultaneous launch
    getAllReadyBrowsers(): PrewarmedBrowser[] {
        return Array.from(this.browsers.values()).filter((b) => b.isReady);
    }

    getPrewarmedBrowser(browserNumber: number): PrewarmedBrowser | null {
        const browser = this.browsers.get(browserNumber);

        if (browser && browser.isReady) {
            console.log(`⚡ INSTANT: Got pre-warmed browser ${browserNumber}`);
            return browser;
        }

        return null;
    }

    removeBrowser(browserNumber: number): void {
        this.browsers.delete(browserNumber);
    }

    async closeBrowser(browserNumber: number): Promise<void> {
        const browser = this.browsers.get(browserNumber);

        if (browser) {
            try {
                await browser.browser.close();
                this.releaseDisplay(browser.display);
                this.browsers.delete(browserNumber);
                console.log(`🔄 Closed browser ${browserNumber}`);
            } catch (error) {
                console.error(`❌ Close error browser ${browserNumber}:`, error);
            }
        }
    }

    async closeAllBrowsers(): Promise<void> {
        console.log(`🔄 Closing ${this.browsers.size} browsers...`);

        const closePromises = Array.from(this.browsers.keys()).map((num) =>
            this.closeBrowser(num)
        );

        await Promise.allSettled(closePromises);

        this.browsers.clear();
        activeDisplays.clear();
        this.preNavigated = false;

        console.log(`✅ All browsers closed`);
    }

    getStatus(): any {
        return {
            totalBrowsers: this.browsers.size,
            readyBrowsers: Array.from(this.browsers.values()).filter((b) => b.isReady)
                .length,
            warmingBrowsers: this.warmingUp.size,
            displays: Array.from(this.browsers.values()).map((b) => b.display),
            browserNumbers: Array.from(this.browsers.keys()),
            preNavigated: this.preNavigated,
        };
    }

    allBrowsersReady(): boolean {
        return this.warmingUp.size === 0 && this.browsers.size > 0;
    }

    getReadyCount(): number {
        return this.browsers.size;
    }
}

export const browserPool = new PrewarmedBrowserPool();
export { PrewarmedBrowserPool, PrewarmedBrowser };
