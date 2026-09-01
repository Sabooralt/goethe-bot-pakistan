// goethe-booking.ts

import axios, {
    AxiosInstance,
    AxiosRequestConfig,
    AxiosResponse,
} from "axios";

import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";

import crypto from "node:crypto";

class PersistentServerException extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PersistentServerException";
    }
}

class RateLimitException extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RateLimitException";
    }
}

type RequestType = "navigate" | "ajax" | "form";

interface GoetheModulesOptions {
    bookingUrl: string;
}

interface GoetheResult {
    success: boolean;
    captcha: boolean;
    status?: number;
    url?: string;
    title?: string;
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",

    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",

    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",

    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",

    "Mozilla/5.0 (Macintosh; Intel Mac OS X 11_6_5) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/15.4 Safari/605.1.15",

    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:115.0) Gecko/20100101 Firefox/115.0",

    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",

    "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",

    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",

    "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
];

function randomItem<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
}

function randomBetween(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

function randomBoolean(probability: number): boolean {
    return Math.random() < probability;
}

class GoetheModules {
    private readonly bookingUrl: string;

    private readonly jar: CookieJar;

    private readonly session;

    private readonly userAgent: string;

    private minRequestDelay = 500;
    private maxRequestDelay = 2000;

    private maxRetries = 3;
    private retryBackoff = 2;

    private currentPageResponse: AxiosResponse | null = null;
    private currentUrl: string | null = null;

    constructor({ bookingUrl }: GoetheModulesOptions) {
        this.bookingUrl = bookingUrl;

        this.jar = new CookieJar();

        this.userAgent = randomItem(USER_AGENTS);
        const axiosInstance = axios.create({
            timeout: 60_000,

            maxRedirects: 5,


            decompress: true,

            headers: {
                "User-Agent": this.userAgent,

                Accept:
                    "text/html,application/xhtml+xml,application/xml;q=0.9," +
                    "image/avif,image/webp,image/apng,*/*;q=0.8," +
                    "application/signed-exchange;v=b3;q=0.7",

                "Accept-Language":
                    "en-US,en;q=0.9,de;q=0.8",

                "Accept-Encoding":
                    "gzip, deflate, br",

                Connection: "keep-alive",

                "Upgrade-Insecure-Requests": "1",

                "Sec-Ch-Ua":
                    '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',

                "Sec-Ch-Ua-Mobile": "?0",

                "Sec-Ch-Ua-Platform": '"Windows"',

                "Sec-Fetch-Dest": "document",

                "Sec-Fetch-Mode": "navigate",

                "Sec-Fetch-Site": "none",

                "Cache-Control": "no-cache",

                DNT: "1",
            },
        }) as any

        this.session = wrapper(axiosInstance);

        this.session.defaults.jar = this.jar;

        this.log(
            `[INIT] User-Agent: ${this.userAgent}`,
        );

        this.log(
            `[INIT] Booking URL: ${this.bookingUrl}`,
        );
    }

    private log(...args: unknown[]): void {
        console.log("[GOETHE]", ...args);
    }

    private async randomDelay(): Promise<void> {
        const delay = randomBetween(
            this.minRequestDelay,
            this.maxRequestDelay,
        );

        await sleep(delay);
    }

    private getHeaders(
        type: RequestType = "navigate",
        extra: Record<string, string> = {},
    ): Record<string, string> {
        const headers: Record<string, string> = {
            Priority: "u=0, i",

            TE: "trailers",

            "Sec-GPC": "1",

            ...extra,
        };

        if (type === "ajax") {
            Object.assign(headers, {
                "X-Requested-With": "XMLHttpRequest",

                "Sec-Fetch-Dest": "empty",

                "Sec-Fetch-Mode": "cors",

                "Sec-Fetch-Site": "same-origin",
            });
        }

        if (type === "form") {
            Object.assign(headers, {
                "Content-Type":
                    "application/x-www-form-urlencoded",

                "Sec-Fetch-Dest": "document",

                "Sec-Fetch-Mode": "navigate",

                "Sec-Fetch-Site": "same-origin",

                "Sec-Fetch-User": "?1",
            });
        }

        if (randomBoolean(0.3)) {
            headers["Cache-Control"] = randomItem([
                "no-cache",
                "max-age=0",
                "no-store",
            ]);
        }

        return headers;
    }

    private async safeRequest(
        method: "GET" | "POST",
        url: string,
        operation: string,
        data?: unknown,
        headers: Record<string, string> = {},
    ): Promise<AxiosResponse | null> {
        await this.randomDelay();

        const requestType: RequestType =
            operation.toLowerCase().includes("ajax")
                ? "ajax"
                : "navigate";

        const requestHeaders = this.getHeaders(
            requestType,
            headers,
        );

        for (
            let attempt = 0;
            attempt <= this.maxRetries;
            attempt++
        ) {
            try {
                if (attempt > 0) {
                    this.log(
                        `[RETRY] ${operation} attempt ${attempt + 1
                        }/${this.maxRetries + 1}`,
                    );

                    this.log(
                        `[SESSION-RESET] Preserving existing cookie jar`,
                    );

                    // Same behavior as the supplied Python:
                    // calculated retry delay is intentionally not slept.
                    const calculatedBackoff =
                        Math.min(
                            30,
                            Math.pow(this.retryBackoff, attempt) *
                            randomBetween(0.5, 1.5),
                        );

                    this.log(
                        `[RETRY] Calculated backoff: ${calculatedBackoff.toFixed(
                            1,
                        )}s`,
                    );
                }

                const config: AxiosRequestConfig = {
                    method,
                    url,
                    data,
                    headers: requestHeaders,

                    maxRedirects: 5,

                    validateStatus: () => true,
                };

                const response =
                    await this.session.request(config);

                const status = response.status;

                this.log(
                    `[HTTP] ${method} ${url} -> ${status}`,
                );

                if (
                    [500, 502, 503, 504].includes(status)
                ) {
                    this.log(
                        `[SERVER-ERROR] ${status} during ${operation}`,
                    );

                    if (attempt < this.maxRetries) {
                        continue;
                    }

                    throw new PersistentServerException(
                        `Server failed with ${status}`,
                    );
                }

                if (status === 429) {
                    this.log(
                        `[RATE-LIMIT] 429 during ${operation}`,
                    );

                    if (attempt < this.maxRetries) {
                        continue;
                    }

                    throw new RateLimitException(
                        "Rate limit hit after retries",
                    );
                }

                if (status === 403) {
                    throw new RateLimitException(
                        "Forbidden error (403)",
                    );
                }

                this.currentPageResponse = response;

                this.currentUrl =
                    response.request?.res?.responseUrl ||
                    response.config.url ||
                    url;

                return response;
            } catch (error: unknown) {
                if (
                    error instanceof
                    RateLimitException ||
                    error instanceof
                    PersistentServerException
                ) {
                    throw error;
                }

                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);

                this.log(
                    `[NETWORK] ${operation}: ${message}`,
                );

                if (attempt >= this.maxRetries) {
                    return null;
                }
            }
        }

        return null;
    }

    private async get(
        url: string,
        operation: string,
        headers: Record<string, string> = {},
    ): Promise<AxiosResponse | null> {
        return this.safeRequest(
            "GET",
            url,
            operation,
            undefined,
            headers,
        );
    }

    private async logSessionInfo(
        phase: string,
    ): Promise<void> {
        const url =
            this.currentUrl || this.bookingUrl;

        const cookies =
            await this.jar.getCookies(url);

        this.log(
            `[SESSION] ${phase}: ${cookies.length} cookies`,
        );

        const criticalCookies = new Set([
            "coesessionid",
            "JSESSIONID",
            "TGC",
            "CFID",
            "CFTOKEN",
            "CAS_GI_GW_CHECK_DONE",
        ]);

        for (const cookie of cookies) {
            if (criticalCookies.has(cookie.key)) {
                this.log(
                    `[COOKIE] ${cookie.key}: ${cookie.value.slice(
                        0,
                        20,
                    )}...`,
                );
            }
        }
    }

    private extractFinalUrl(
        response: AxiosResponse,
    ): string {
        return (
            response.request?.res?.responseUrl ||
            response.config.url ||
            this.currentUrl ||
            this.bookingUrl
        );
    }

    private detectCaptcha(
        html: string,
    ): boolean {
        return /captcha|recaptcha/i.test(html);
    }

    private saveDebugHtml(
        html: string,
        filename = "goethe-booking.html",
    ): void {
        // Intentionally omitted here; you can add fs.writeFile
        // if you want to persist the response for inspection.
        void html;
        void filename;
    }

    async run(): Promise<GoetheResult> {
        this.log(
            "========================================",
        );

        this.log(
            "Opening booking URL",
        );

        this.log(
            `URL: ${this.bookingUrl}`,
        );

        this.log(
            `UA: ${this.userAgent}`,
        );

        this.log(
            "========================================",
        );

        await this.logSessionInfo(
            "Before booking page",
        );

        const response = await this.get(
            this.bookingUrl,
            "Booking page",
        );

        if (!response) {
            throw new Error(
                "Failed to load booking page",
            );
        }

        this.currentPageResponse = response;

        this.currentUrl =
            this.extractFinalUrl(response);

        const html =
            typeof response.data === "string"
                ? response.data
                : String(response.data);

        this.log(
            `HTTP Status: ${response.status}`,
        );

        this.log(
            `Final URL: ${this.currentUrl}`,
        );

        this.log(
            `Response size: ${Buffer.byteLength(
                html,
                "utf8",
            )} bytes`,
        );

        await this.logSessionInfo(
            "After booking page",
        );

        this.saveDebugHtml(html);

        /*
         * CAPTCHA is deliberately NOT solved.
         */
        if (this.detectCaptcha(html)) {
            this.log(
                "⚠️ CAPTCHA detected. Stopping without solving.",
            );

            return {
                success: false,

                captcha: true,

                status: response.status,

                url: this.currentUrl,
            };
        }

        this.log(
            "✅ Booking page loaded without CAPTCHA.",
        );

        return {
            success:
                response.status >= 200 &&
                response.status < 400,

            captcha: false,

            status: response.status,

            url: this.currentUrl,
        };
    }
}


// =========================================================
// CONFIG
// =========================================================

const oid = process.env.TEST_OID;
const bookingUrl = `https://goethe.de/coe/entry?lang=en&oid=${oid}`

if (!bookingUrl) {
    throw new Error(
        "BOOKING_URL environment variable is required.",
    );
}

const bot = new GoetheModules({
    bookingUrl,
});

bot
    .run()
    .then((result) => {
        console.log(
            "\n========== RESULT ==========",
        );

        console.log(
            JSON.stringify(result, null, 2),
        );
    })
    .catch((error: unknown) => {
        console.error(
            "\n========== ERROR ==========",
        );

        console.error(error);
    });