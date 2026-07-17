import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import { proxyPool, USE_PROXIES } from "../proxyPool";
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { browserArgs } from "../utils/browserArgs";
import path from "path";
import os from "os";

puppeteer.use(StealthPlugin());
const BROWSER_COUNT = parseInt(process.env.BROWSER_COUNT || "20", 10);

interface PrewarmedBrowser {
    browser: Browser;
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

            let proxy: any = null;
            let proxyUrl = "";
            if (USE_PROXIES) {
                proxy = proxyPool.getNextProxy();
                if (proxy) {
                    proxyUrl = `${proxy.host}:${proxy.port}`;
                    console.log(`[proxy] Proxy ${proxyUrl} → Browser ${browserNumber}`);
                }
            }

            const args = [...browserArgs];

            if (proxy) {
                args.push(
                    `--proxy-server=${proxy.type}://${proxy.host}:${proxy.port}`
                );
            }
            const userDataDir = path.join(os.tmpdir(), `profile-${browserNumber}-${Date.now()}`);

            const browser = await puppeteer.launch({
                headless: false,
                executablePath: "/usr/bin/google-chrome",
                userDataDir,
                env: {
                    DISPLAY: display,
                },
                args,
                timeout: 10000,
                protocolTimeout: 180000,
                defaultViewport: null,
            });

            const page = await browser.newPage();

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');



            const client = await page.target().createCDPSession();
            await client.send('Page.addScriptToEvaluateOnNewDocument', {
                source: `
    const getParameterProxyHandler = {
      apply(target, thisArg, args) {
        const param = args[0];
        if (param === 37445) return 'Google Inc. (Intel)';
        if (param === 37446) return 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return Reflect.apply(target, thisArg, args);
      }
    };
    WebGLRenderingContext.prototype.getParameter = new Proxy(WebGLRenderingContext.prototype.getParameter, getParameterProxyHandler);
    WebGL2RenderingContext.prototype.getParameter = new Proxy(WebGL2RenderingContext.prototype.getParameter, getParameterProxyHandler);
  `
            });

            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            });

            await page.setViewport({ width: 1280, height: 720 });



            if (proxy && proxy.username && proxy.password) {
                await page.authenticate({
                    username: proxy.username,
                    password: proxy.password,
                });
            }

            await page.setRequestInterception(true);
            page.on("request", (req: any) => {
                const url = req.url();
                const type = req.resourceType();
                if (url.includes("qsC0Q1SRs") || url.includes("VS0kRERZ") || url.includes("EBFUJX") || url.includes("28M7sj") || url.includes("akam")) {
                    console.log(`[browserRequest] Blocked Akamai sensor: ${url.substring(0, 80)}`);
                    req.abort();
                    return;
                }
                req.continue();
            });

            await page.setDefaultNavigationTimeout(180000);
            await page.setDefaultTimeout(180000);




            console.log(`[preWarm] Pre-warmed browser ${browserNumber}`);

            return {
                browser,
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
            console.log(`[preWarm] Warming up ${BROWSER_COUNT} browsers...`);

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

            console.log(`[preWarm] Warming complete! ${this.browsers.size}/${BROWSER_COUNT} ready`);
        } catch (error) {
            console.error(`[preWarm] Warmup error:`, error);
        }
    }

    // Get all ready browsers for simultaneous launch
    getAllReadyBrowsers(): PrewarmedBrowser[] {
        return Array.from(this.browsers.values()).filter((b) => b.isReady);
    }

    getPrewarmedBrowser(browserNumber: number): PrewarmedBrowser | null {
        const browser = this.browsers.get(browserNumber);

        if (browser && browser.isReady) {
            console.log(`[preWarm] Got pre-warmed browser ${browserNumber}`);
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
