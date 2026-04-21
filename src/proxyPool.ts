import dotenv from "dotenv";

dotenv.config();

export const USE_PROXIES = process.env.USE_PROXIES === "true" || false;

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
     * Get proxy for specific browser number
     * Automatically distributes browsers across available rotating proxies
     * 
     * Examples:
     * - 1 proxy: All 20 browsers use proxy 1
     * - 2 proxies: Browsers 1-10 use proxy 1, 11-20 use proxy 2
     * - 3 proxies: Browsers 1-10 use proxy 1, 11-20 use proxy 2, 21-30 use proxy 3
     */
    getProxyForBrowser(browserNumber: number): ProxyConfig | null {
        if (this.rotatingProxies.length === 0) {
            console.warn(`⚠️ No proxies configured for browser ${browserNumber}`);
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