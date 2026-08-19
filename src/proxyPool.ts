import dotenv from "dotenv";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

dotenv.config();

export const USE_PROXIES = process.env.USE_PROXIES === "true" || false;

const HEALTH_CHECK_URL = "https://api.ipify.org?format=json";
const HEALTH_CHECK_TIMEOUT_MS = 8000; // per-proxy timeout; checks run in parallel

export interface ProxyConfig {
    host: string;
    port: number;
    username?: string;
    password?: string;
    type: "http" | "https" | "socks5";
}

class ProxyPool {
    private rotatingProxies: ProxyConfig[] = [];
    private browsersPerProxy = 10; // Each proxy handles 10 browsers
    private proxyUsage = new Map<number, number>();
    private validated = false;

    constructor() {
        this.loadProxiesFromEnv();
    }

    private loadProxiesFromEnv(): void {
        // Load rotating proxies dynamically (ROTATING_PROXY_1, ROTATING_PROXY_2, etc.)
        let proxyIndex = 1;

        while (true) {
            const host = process.env[`ROTATING_PROXY_${proxyIndex}_HOST`];
            const port = process.env[`ROTATING_PROXY_${proxyIndex}_PORT`];
            const username = process.env[`ROTATING_PROXY_${proxyIndex}_USERNAME`];
            const password = process.env[`ROTATING_PROXY_${proxyIndex}_PASSWORD`];
            const type = (process.env[`ROTATING_PROXY_${proxyIndex}_TYPE`] || "http") as
                | "http"
                | "https"
                | "socks5";

            // Stop when no more proxies are found
            if (!host || !port) {
                break;
            }

            this.rotatingProxies.push({
                host,
                port: parseInt(port),
                username,
                password,
                type,
            });

            this.proxyUsage.set(proxyIndex - 1, 0);

            console.log(
                `✅ Loaded rotating proxy ${proxyIndex}: ${host}:${port} (browsers ${(proxyIndex - 1) * 10 + 1}-${proxyIndex * 10})`
            );

            proxyIndex++;
        }

        if (this.rotatingProxies.length === 0) {
            console.warn("⚠️ No rotating proxies configured in environment variables");
        } else {
            console.log(
                `📊 Loaded ${this.rotatingProxies.length} rotating proxies (${this.rotatingProxies.length * 10} browsers max)`
            );
        }
    }

    /**
     * Builds a proxy URL string like http://user:pass@host:port
     */
    private buildProxyUrl(proxy: ProxyConfig): string {
        const auth = proxy.username && proxy.password
            ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
            : "";
        return `${proxy.type === "socks5" ? "socks5" : "http"}://${auth}${proxy.host}:${proxy.port}`;
    }

    /**
     * Checks whether a single proxy is actually working by making a real
     * request through it. Returns false on any error or timeout — never throws.
     */
    private async checkProxyHealth(proxy: ProxyConfig): Promise<boolean> {
        const proxyUrl = this.buildProxyUrl(proxy);
        const label = `${proxy.host}:${proxy.port}`;

        try {
            const agent = proxy.type === "socks5"
                ? new SocksProxyAgent(proxyUrl)
                : new HttpsProxyAgent(proxyUrl);

            const response = await axios.get(HEALTH_CHECK_URL, {
                httpAgent: agent,
                httpsAgent: agent,
                timeout: HEALTH_CHECK_TIMEOUT_MS,
                proxy: false, // disable axios' own proxy handling — we're using the agent directly
                validateStatus: (status) => status === 200,
            });

            console.log(`✅ Proxy healthy: ${label} → ${JSON.stringify(response.data)}`);
            return true;
        } catch (error) {
            const message = (error as Error).message;
            console.warn(`❌ Proxy failed health check: ${label} — ${message}`);
            return false;
        }
    }

    /**
     * Validates ALL configured proxies in PARALLEL and removes any that
     * fail. Call this once at startup before browsers are warmed up.
     * With an 8s per-proxy timeout and parallel execution, this takes
     * roughly 8s total regardless of how many proxies are configured
     * (not 8s × proxy count).
     */
    async validateProxies(): Promise<{ working: number; failed: number; total: number }> {
        if (this.rotatingProxies.length === 0) {
            console.warn("⚠️ No proxies to validate");
            this.validated = true;
            return { working: 0, failed: 0, total: 0 };
        }

        console.log(`🔍 Validating ${this.rotatingProxies.length} proxies in parallel...`);
        const startTime = Date.now();

        const results = await Promise.all(
            this.rotatingProxies.map(async (proxy) => ({
                proxy,
                healthy: await this.checkProxyHealth(proxy),
            }))
        );

        const elapsed = Date.now() - startTime;

        const workingProxies = results.filter((r) => r.healthy).map((r) => r.proxy);
        const failedCount = results.length - workingProxies.length;

        this.rotatingProxies = workingProxies;

        // Rebuild usage map to match the new (filtered) index positions
        this.proxyUsage.clear();
        for (let i = 0; i < this.rotatingProxies.length; i++) {
            this.proxyUsage.set(i, 0);
        }

        this.validated = true;

        console.log(
            `📊 Proxy validation complete in ${elapsed}ms: ${workingProxies.length} working, ${failedCount} failed`
        );

        if (workingProxies.length === 0) {
            console.error("🚨 NO WORKING PROXIES — proxy-dependent browsers will get none");
        }

        return { working: workingProxies.length, failed: failedCount, total: results.length };
    }

    /**
     * Get proxy for specific browser number
     * Automatically distributes browsers across available rotating proxies
     * 
     * Examples:
     * - 1 proxy: All 20 browsers use proxy 1
     * - 2 proxies: Browsers 1-10 use proxy 1, 11-20 use proxy 2
     * - 3 proxies: Browsers 1-10 use proxy 1, 11-20 use proxy 2, 21-30 use proxy 3
     */
    getProxyForBrowser(browserNumber: number): ProxyConfig | null {
        if (!this.validated) {
            console.warn("⚠️ getProxyForBrowser called before validateProxies() — returning unvalidated proxy");
        }

        if (this.rotatingProxies.length === 0) {
            console.warn(`⚠️ No working proxies available for browser ${browserNumber}`);
            return null;
        }

        // If only 1 proxy, all browsers use it
        if (this.rotatingProxies.length === 1) {
            const proxy = this.rotatingProxies[0];
            console.log(
                `🔄 Browser ${browserNumber} → Rotating Proxy 1: ${proxy.host}:${proxy.port}`
            );
            return proxy;
        }

        // Multiple proxies: distribute evenly
        // Browser 1-10 → Proxy 1, Browser 11-20 → Proxy 2, etc.
        const proxyIndex = Math.floor((browserNumber - 1) / this.browsersPerProxy);

        // If browser number exceeds available proxies, wrap around
        const actualProxyIndex = proxyIndex % this.rotatingProxies.length;
        const proxy = this.rotatingProxies[actualProxyIndex];

        const usage = this.proxyUsage.get(actualProxyIndex) || 0;
        this.proxyUsage.set(actualProxyIndex, usage + 1);

        console.log(
            `🔄 Browser ${browserNumber} → Rotating Proxy ${actualProxyIndex + 1}: ${proxy.host}:${proxy.port}`
        );

        return proxy;
    }

    /**
     * Get next proxy from pool (round-robin) - for backwards compatibility
     */
    getNextProxy(): ProxyConfig | null {
        if (this.rotatingProxies.length === 0) {
            return null;
        }

        const proxyIndex = Math.floor(Math.random() * this.rotatingProxies.length);
        return this.rotatingProxies[proxyIndex];
    }

    getStatus(): {
        enabled: boolean;
        validated: boolean;
        totalRotatingProxies: number;
        browsersPerProxy: number;
        maxBrowsers: number;
        usage: Array<{ proxyNumber: number; proxy: string; timesUsed: number; browsers: string }>;
    } {
        const usage = this.rotatingProxies.map((proxy, index) => ({
            proxyNumber: index + 1,
            proxy: `${proxy.host}:${proxy.port}`,
            timesUsed: this.proxyUsage.get(index) || 0,
            browsers: `${index * 10 + 1}-${(index + 1) * 10}`,
        }));

        return {
            enabled: USE_PROXIES,
            validated: this.validated,
            totalRotatingProxies: this.rotatingProxies.length,
            browsersPerProxy: this.browsersPerProxy,
            maxBrowsers: this.rotatingProxies.length * this.browsersPerProxy,
            usage,
        };
    }

    resetUsage(): void {
        this.proxyUsage.clear();
        for (let i = 0; i < this.rotatingProxies.length; i++) {
            this.proxyUsage.set(i, 0);
        }
        console.log("🔄 Reset proxy usage counters");
    }

    getProxyCount(): number {
        return this.rotatingProxies.length;
    }

    getTotalBrowserCapacity(): number {
        return this.rotatingProxies.length * this.browsersPerProxy;
    }
}

export const proxyPool = new ProxyPool();