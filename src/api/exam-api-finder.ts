import { Browser, BrowserContext, LaunchOptions, Page } from "playwright-core";
import { USE_PROXIES } from "../proxyPool";
import { Camoufox } from "camoufox";



const TARGET_URL =
  process.env.TARGET_URL || "https://www.goethe.de/ins/in/en/spr/prf/gzb2.cfm";

const MOCK_API_URL = "http://localhost:3001/api/mock-exam";

interface ExamModule {
  date: string;
  startTime: string;
}

export interface ExamData {
  oid?: string;
  moduleId?: string;
  bookFrom?: string;
  bookFromTime?: string;
  bookFromTimeFormatted?: string;
  bookFromStamp?: string;
  bookToStamp?: string;
  startDate?: string;
  eventName?: string;
  locationName?: string;
  modules?: ExamModule[];
  [key: string]: any;
}

interface ApiResponse {
  DATA?: ExamData[];
  [key: string]: any;
}

interface PollingOptions {
  interval?: number;
  onExamFound?: (exam: ExamData) => void;
  onExamWithOid?: (exam: ExamData) => Promise<void>;
  onTimeout?: () => void;
  stopOnFirstOid?: boolean;
  maxDurationMs?: number;
}

interface LockedExam {
  locationName: string;
  startDate: string;
  moduleId: string;
  bookFrom: string;
  bookFromTime: string;
}

class ExamMonitor {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private timeoutInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private shouldStopPolling = false;
  private processingOid = false;
  private processedOids = new Set<string>();
  private lastSuccessfulPoll: Date | null = null;
  private rapidOidHandler: ((exam: ExamData) => Promise<void>) | null = null;
  private lockedExam: LockedExam | null = null;
  private pollCount = 0;
  private startTime: Date | null = null;
  private lastApiCallDuration = 0;
  private pollsOnCurrentIp = 0;
  private readonly MAX_POLLS_PER_IP = 2;

  private buildLaunchArgs(): LaunchOptions {
    let proxyHost: string | undefined = undefined;
    let username: string | undefined = undefined;
    let password: string | undefined = undefined;

    if (USE_PROXIES) {
      proxyHost = process.env.GERMANY_PROXY_HOST;
      username = process.env.GERMANY_PROXY_USERNAME;
      password = process.env.GERMANY_PROXY_PASSWORD;
    }

    const args: LaunchOptions = {
      headless: true,
    }

    if (USE_PROXIES && proxyHost && username && password) {
      args.proxy = {
        server: proxyHost,
        username: username,
        password: password
      }
    }

    return args;
  }

  /**
   * Launches the browser and navigates to TARGET_URL once. No API URL is
   * captured — browserApiCall() intercepts the "examfinder" response
   * generically by substring match, triggered via page.reload(), so the
   * literal URL string was never actually needed.
   */
  private async launchBrowser(): Promise<boolean> {
    try {
      console.log("[browser] Launching browser");
      const args = this.buildLaunchArgs();

      console.log({
        useProxies: USE_PROXIES,
        argsProxy: args.proxy,
      });

      this.browser = await Camoufox(args);
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();

      await this.page.goto(TARGET_URL, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      console.log("[browser] Browser launched and ready");
      return true;
    } catch (error) {
      console.error("[browser] Failed to launch browser:", error);
      return false;
    }
  }

  /**
   * Fast path used for IP rotation: keeps the underlying Camoufox browser
   * process alive and just closes + reopens the context. Since the proxy
   * is a rotating endpoint, each new context gets a fresh exit IP without
   * paying for a full browser relaunch.
   */
  private async reopenContext(): Promise<boolean> {
    try {
      if (!this.browser) {
        console.warn("[browser] No browser instance yet — launching fresh");
        return await this.launchBrowser();
      }

      if (this.context) {
        await this.context.close().catch(() => { });
        this.context = null;
        this.page = null;
      }

      console.log("[browser] Opening new context (IP rotation)");
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();

      await this.page.goto(TARGET_URL, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      console.log("[browser] New context ready");
      return true;
    } catch (error) {
      console.error("[browser] Failed to reopen context:", error);
      return false;
    }
  }

  private async closeBrowser(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close().catch(() => { });
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
        console.log("[browser] Browser closed");
      }
    } catch (error) {
      console.error("[browser] Error closing browser:", error);
    }
  }

  private async browserApiCall(): Promise<ApiResponse | null> {
    if (process.env.TEST_MODE === "true") {
      try {
        const res = await fetch(MOCK_API_URL);
        if (!res.ok) return null;
        const data = await res.json();
        this.lastSuccessfulPoll = new Date();
        return data;
      } catch (error) {
        console.error("[api] Direct fetch error:", error);
        return null;
      }
    }

    if (!this.page) return null;

    const startTime = Date.now();

    return new Promise(async (resolve) => {
      let resolved = false;

      const done = (data: ApiResponse | null) => {
        if (resolved) return;
        resolved = true;
        this.page!.off("response", handler);
        this.lastApiCallDuration = Date.now() - startTime;
        if (data) {
          this.lastSuccessfulPoll = new Date();
        }
        resolve(data);
      };

      const handler = async (response: any) => {
        const url = response.url();
        if (url.includes("examfinder")) {
          const status = response.status();
          console.log(`[api] Intercepted examfinder — status: ${status}`);
          if (status !== 200) {
            console.warn(`[api] Non-200 status (${status}) — will rotate instantly`);
            done(null);
            return;
          }
          try {
            const data = await response.json();
            done(data);
          } catch {
            done(null);
          }
        }
      };

      this.page!.on("response", handler);

      setTimeout(() => {
        console.warn("[api] Intercept timeout — examfinder never fired");
        done(null);
      }, 3000);

      try {
        await this.page!.reload({
          waitUntil: "domcontentloaded",
          timeout: 10000,
        });
      } catch {
        // timeout ok — examfinder fires before domcontentloaded
      }
    });
  }

  async startPolling(targetDate: Date, options: PollingOptions = {}) {
    const {
      interval = 1000,
      onExamFound,
      onExamWithOid,
      onTimeout,
      stopOnFirstOid = true,
      maxDurationMs = 30 * 60 * 1000,
    } = options;

    this.rapidOidHandler = onExamWithOid || null;
    this.shouldStopPolling = false;
    this.processingOid = false;
    this.processedOids.clear();
    this.lockedExam = null;
    this.pollCount = 0;
    this.pollsOnCurrentIp = 0; // reset
    this.startTime = new Date();

    if (process.env.TEST_MODE !== "true" && !this.page) {
      console.log("[startPolling] Launching browser");
      const launched = await this.launchBrowser();

      if (!launched) {
        console.error("[startPolling] Could not launch browser");
        if (onTimeout) await onTimeout();
        return;
      }
    }

    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
    const targetDatePKT = new Date(targetDate.getTime() + PKT_OFFSET_MS);
    const [year, month, day] = targetDatePKT.toISOString().split("T")[0].split("-");
    const targetBookFromDate = `${day}.${month}.${year}`;

    this.isPolling = true;

    this.timeoutInterval = setTimeout(async () => {
      console.log(`[startPolling] Max duration reached (${maxDurationMs}ms)`);
      this.shouldStopPolling = true;
      if (onTimeout) await onTimeout();
      this.stopPolling();
    }, maxDurationMs);

    // Instant IP rotation: closes + reopens only the context (browser stays
    // alive). Each new context gets a fresh exit IP from the rotating
    // proxy endpoint.
    const rotateIp = async (): Promise<boolean> => {
      console.log(`[poll] Rotating IP after ${this.pollsOnCurrentIp} polls`);
      const reopened = await this.reopenContext();
      if (!reopened) {
        console.error("[poll] Failed to rotate IP");
        return false;
      }

      this.pollsOnCurrentIp = 0;
      console.log("[poll] ✅ IP rotated successfully");
      return true;
    };

    const rapidPoll = async () => {
      if (this.shouldStopPolling) {
        this.stopPolling();
        return;
      }

      if (this.processingOid) {
        setImmediate(() => setTimeout(rapidPoll, interval));
        return;
      }

      try {
        this.pollCount++;
        this.pollsOnCurrentIp++;

        const data = await this.browserApiCall();
        console.log(`[poll] Raw data:`, JSON.stringify(data)?.substring(0, 200));

        if (!data) {
          console.warn("[poll] Null response (non-200 / timeout) — rotating instantly");
          const rotated = await rotateIp();
          if (!rotated) {
            this.stopPolling();
            if (onTimeout) await onTimeout();
            return;
          }
          setImmediate(() => setTimeout(rapidPoll, interval));
          return;
        }

        if (!data?.DATA || !Array.isArray(data.DATA)) {
          if (this.pollCount % 10 === 0) {
            console.log(`[poll] No data returned (${this.pollCount} polls)`);
          }
          setImmediate(() => setTimeout(rapidPoll, interval));
          return;
        }

        if (this.lockedExam) {
          const lockedExam = data.DATA.find(
            (exam: ExamData) =>
              exam.locationName === this.lockedExam!.locationName &&
              exam.startDate === this.lockedExam!.startDate &&
              exam.moduleId === this.lockedExam!.moduleId
          );

          if (lockedExam) {
            if (lockedExam.oid && !this.processedOids.has(lockedExam.oid)) {
              const elapsed = this.startTime ? Date.now() - this.startTime.getTime() : 0;
              console.log(`\n${"=".repeat(50)}`);
              console.log(`[poll] OID DETECTED`);
              console.log(`[poll] OID: ${lockedExam.oid}`);
              console.log(`[poll] Location: ${lockedExam.locationName || "unknown"}`);
              console.log(`[poll] Detected in: ${elapsed}ms`);
              console.log(`[poll] Poll count: ${this.pollCount}`);
              console.log(`${"=".repeat(50)}\n`);

              this.processedOids.add(lockedExam.oid);
              this.processingOid = true;

              if (this.rapidOidHandler) {
                setImmediate(() => {
                  this.rapidOidHandler!(lockedExam).finally(() => {
                    this.processingOid = false;
                  });
                });
              }

              if (stopOnFirstOid) {
                this.shouldStopPolling = true;
                this.stopPolling();
                return;
              }
            } else if (!lockedExam.oid && this.pollCount % 10 === 0) {
              console.log(`[poll] Waiting for OID (${this.pollCount} polls)`);
            }
          } else {
            console.log(`[poll] Locked exam disappeared — resuming scan`);
            this.lockedExam = null;
          }
        } else {
          const matchingExams = data.DATA

          if (matchingExams.length > 0) {
            const exam = matchingExams[0];

            this.lockedExam = {
              locationName: exam.locationName || "",
              startDate: exam.startDate || "",
              moduleId: exam.moduleId || "",
              bookFrom: exam.bookFrom || "",
              bookFromTime: exam.bookFromTime || "",
            };

            console.log(`\n${"=".repeat(50)}`);
            console.log(`[poll] ✅ EXAM LOCKED`);
            console.log(`[poll] Location:      ${exam.locationName}`);
            console.log(`[poll] Exam date:     ${exam.startDate}`);
            console.log(`[poll] Module ID:     ${exam.moduleId}`);
            console.log(`[poll] Booking opens: ${exam.bookFrom} ${exam.bookFromTimeFormatted || exam.bookFromTime}`);
            console.log(`[poll] Availability:  ${exam.availability ?? "N/A"}`);
            console.log(`[poll] Monitoring for OID...`);
            console.log(`${"=".repeat(50)}\n`);

            if (onExamFound) setImmediate(() => onExamFound(exam));

            if (exam.oid && !this.processedOids.has(exam.oid)) {
              const elapsed = this.startTime ? Date.now() - this.startTime.getTime() : 0;
              console.log(`[poll] ✅ OID already present at ${elapsed}ms: ${exam.oid}`);

              this.processedOids.add(exam.oid);
              this.processingOid = true;

              if (this.rapidOidHandler) {
                setImmediate(() => {
                  this.rapidOidHandler!(exam).finally(() => {
                    this.processingOid = false;
                  });
                });
              }

              if (stopOnFirstOid) {
                this.shouldStopPolling = true;
                this.stopPolling();
                return;
              }
            }
          } else if (this.pollCount % 10 === 0) {
            const elapsed = this.startTime ? Date.now() - this.startTime.getTime() : 0;
            const rate = elapsed > 0 ? Math.round(this.pollCount / (elapsed / 1000)) : 0;
            console.log(`[poll] ${new Date().toLocaleTimeString()} | Polls: ${this.pollCount} | Rate: ${rate}/s | IP polls: ${this.pollsOnCurrentIp}/${this.MAX_POLLS_PER_IP}`);
          }
        }

        if (this.lastApiCallDuration > 1000) {
          console.warn(`[poll] Slow API call: ${this.lastApiCallDuration}ms`);
        }
      } catch (error) {
        console.error("[poll] Error:", error);
      }

      setImmediate(() => setTimeout(rapidPoll, interval));
    };

    setImmediate(rapidPoll);
  }

  stopPolling() {
    if (this.timeoutInterval) {
      clearTimeout(this.timeoutInterval);
      this.timeoutInterval = null;
    }

    if (this.isPolling) {
      this.isPolling = false;
      this.shouldStopPolling = true;

      const elapsed = this.startTime ? Date.now() - this.startTime.getTime() : 0;
      console.log("[stopPolling] Polling stopped");
      console.log(`[stopPolling] Total polls: ${this.pollCount}`);
      console.log(`[stopPolling] Duration: ${elapsed}ms`);
      console.log(`[stopPolling] Average rate: ${Math.round(this.pollCount / (elapsed / 1000))} polls/second`);
      console.log(`[stopPolling] Processed OIDs: ${this.processedOids.size}`);
    }
  }

  async forceStopPolling(maxWaitMs = 2000): Promise<void> {
    this.shouldStopPolling = true;
    this.stopPolling();

    const startTime = Date.now();
    while (this.processingOid && Date.now() - startTime < maxWaitMs) {
      console.log("[forceStopPolling] Waiting for OID processing to complete");
      await new Promise((r) => setTimeout(r, 500));
    }

    await this.closeBrowser();
  }

  getStatus(): any {
    const elapsed = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const rate = elapsed > 0 ? Math.round(this.pollCount / (elapsed / 1000)) : 0;

    return {
      isPolling: this.isPolling,
      processingOid: this.processingOid,
      processedOids: Array.from(this.processedOids),
      lastSuccessfulPoll: this.lastSuccessfulPoll,
      lockedExam: this.lockedExam,
      pollCount: this.pollCount,
      pollRate: `${rate} polls/second`,
      uptime: `${elapsed}ms`,
      lastApiCallDuration: `${this.lastApiCallDuration}ms`,
      browserActive: !!this.browser,
    };
  }

  async destroy() {
    await this.forceStopPolling();
    await this.closeBrowser();
    this.processedOids.clear();
    this.processingOid = false;
    this.lockedExam = null;
    this.pollCount = 0;
    this.pollsOnCurrentIp = 0;
    this.startTime = null;
  }
}

export const examMonitor = new ExamMonitor();
export { ExamMonitor };