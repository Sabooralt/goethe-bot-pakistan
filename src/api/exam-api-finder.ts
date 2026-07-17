import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page } from "puppeteer";
import dotenv from "dotenv";

dotenv.config();

const USE_PROXIES = process.env.USE_PROXIES;

puppeteer.use(StealthPlugin());

const TARGET_URL =
  process.env.TARGET_URL ||
  "https://www.goethe.de/ins/pk/en/spr/prf/gzsd2.cfm";

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
  priorityLocations?: string[];
}

interface LockedExam {
  locationName: string;
  startDate: string;
  moduleId: string;
  bookFrom: string;
  bookFromTime: string;
}

class ExamMonitor {
  private apiUrl: string | null =
    process.env.TEST_MODE === "true"
      ? "http://localhost:3001/api/mock-exam"
      : null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private timeoutInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private shouldStopPolling = false;
  private processingOid = false;
  private processedOids = new Set<string>();
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 5;
  private lastSuccessfulPoll: Date | null = null;
  private rapidOidHandler: ((exam: ExamData) => Promise<void>) | null = null;
  private lockedExam: LockedExam | null = null;
  private pollCount = 0;
  private startTime: Date | null = null;
  private lastApiCallDuration = 0;
  private pollsOnCurrentIp = 0;
  private readonly MAX_POLLS_PER_IP = 2;

  private async launchBrowser(): Promise<boolean> {
    try {
      console.log("[browser] Launching browser");

      const proxyHost = process.env.GERMANY_PROXY_HOST;
      const username = process.env.GERMANY_PROXY_USERNAME;
      const password = process.env.GERMANY_PROXY_PASSWORD;

      // Generate unique session ID for each launch = new IP each time
      const sessionId = Math.floor(Math.random() * 1000000);
      const rotatingUsername = username
        ? `${username}-sessid-${sessionId}-sesstime-2`
        : undefined;

      console.log(`[browser] Using proxy session: ${sessionId}`);

      this.browser = await puppeteer.launch({
        headless: false,
        executablePath: "/usr/bin/google-chrome",
        userDataDir: `./profile_${sessionId}`, // fresh profile = fresh fingerprint
        env: { DISPLAY: ":2" },
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          ...(proxyHost ? [`--proxy-server=http://${proxyHost}`] : []),
        ],
        defaultViewport: null,
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 720 });

      if (rotatingUsername && password) {
        await this.page.authenticate({
          username: rotatingUsername,
          password,
        });
      }

      await this.page.setRequestInterception(true);
      this.page.on("request", (req: any) => {
        const url = req.url();
        const type = req.resourceType();

        if (url.includes("qsC0Q1SRs") || url.includes("VS0kRERZ") || url.includes("EBFUJX") || url.includes("28M7sj") || url.includes("akam")) {
          console.log(`[request] Blocked Akamai sensor: ${url.substring(0, 80)}`);
          req.abort();
          return;
        }

        // Never block the examfinder API call
        if (url.includes("examfinder")) {
          console.log(`[request] Allowing examfinder: ${url.substring(0, 80)}`);
          req.continue();
          return;
        }

        if (["image", "font", "media", "stylesheet"].includes(type)) {
          req.abort();
          return;
        }

        req.continue();
      });



      console.log("[browser] Browser launched");
      return true;
    } catch (error) {
      console.error("[browser] Failed to launch browser:", error);
      return false;
    }
  }

  private async closeBrowser(): Promise<void> {
    try {
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

  async captureApiUrl(
    maxRetries = 30,
    retryDelay = 5000
  ): Promise<string | null> {

    if (process.env.TEST_MODE === "true") {
      this.apiUrl = "http://localhost:3001/api/mock-exam";
      console.log("[captureApiUrl] Test mode - using mock URL directly");
      return this.apiUrl;
    }
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[captureApiUrl] Attempt ${attempt}/${maxRetries}`);

      try {
        if (!this.browser || !this.page) {
          const launched = await this.launchBrowser();
          if (!launched) continue;
        }

        const page = this.page!;

        const apiUrl = await new Promise<string | null>(async (resolve) => {
          let captured = false;

          const timeoutId = setTimeout(() => {
            if (!captured) resolve(null);
          }, 25000);

          page.on("response", (response: any) => {
            const url = response.url();
            if (!captured && url.includes("examfinder")) {
              captured = true;
              clearTimeout(timeoutId);
              console.log("[captureApiUrl] API URL captured:", url);
              resolve(url);
            }
          });

          try {
            await page.goto(TARGET_URL, {
              waitUntil: "networkidle0",
              timeout: 20000,
            });
          } catch (error) {
            console.log("[captureApiUrl] Navigation timeout, checking if URL was captured");
          }

          await new Promise((r) => setTimeout(r, 3000));
          if (!captured) {
            clearTimeout(timeoutId);
            resolve(null);
          }
        });

        if (apiUrl) {
          console.log(`[captureApiUrl] Success on attempt ${attempt}`);
          this.apiUrl = apiUrl;
          this.consecutiveErrors = 0;
          return apiUrl;
        }
      } catch (error) {
        console.error(`[captureApiUrl] Error on attempt ${attempt}:`, error);
        await this.closeBrowser();
      }

      if (attempt < maxRetries) {
        const waitTime = Math.min(retryDelay * Math.sqrt(attempt), 15000);
        console.log(`[captureApiUrl] Retrying in ${waitTime}ms`);
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }

    console.error(`[captureApiUrl] Failed after ${maxRetries} attempts`);
    return null;
  }

  private async browserApiCall(): Promise<ApiResponse | null> {
    if (process.env.TEST_MODE === "true" && this.apiUrl?.includes("localhost")) {
      try {
        const res = await fetch(this.apiUrl);
        if (!res.ok) return null;
        const data = await res.json();
        this.consecutiveErrors = 0;
        this.lastSuccessfulPoll = new Date();
        return data;
      } catch (error) {
        this.consecutiveErrors++;
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
          this.consecutiveErrors = 0;
          this.lastSuccessfulPoll = new Date();
        } else {
          this.consecutiveErrors++;
        }
        resolve(data);
      };

      const handler = async (response: any) => {
        const url = response.url();
        if (url.includes("examfinder")) {
          const status = response.status();
          console.log(`[api] Intercepted examfinder — status: ${status}`);
          if (status === 403) {
            console.warn("[api] 403 detected — flagging for IP rotation");
            this.consecutiveErrors = this.maxConsecutiveErrors; // force rotation on next cycle
            done(null);
            return;
          }
          if (status !== 200) {
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
      }, 15000);

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

  private async checkAndRecaptureApiUrl(rotateIp: () => Promise<boolean>): Promise<boolean> {
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      console.warn(`[poll] ${this.consecutiveErrors} consecutive errors — rotating IP`);
      const rotated = await rotateIp();
      if (!rotated) return false;
      return true;
    }
    return true;
  }

  private prioritizeExams(
    exams: ExamData[],
    priorityLocations: string[]
  ): ExamData[] {
    if (!priorityLocations || priorityLocations.length === 0) return exams;

    return exams.sort((a, b) => {
      const aLocation = a.locationName?.toLowerCase() || "";
      const bLocation = b.locationName?.toLowerCase() || "";

      let aPriority = -1;
      let bPriority = -1;

      priorityLocations.forEach((location, index) => {
        const lower = location.toLowerCase();
        if (aLocation.includes(lower) && aPriority === -1) aPriority = index;
        if (bLocation.includes(lower) && bPriority === -1) bPriority = index;
      });

      if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
      if (aPriority !== -1) return -1;
      if (bPriority !== -1) return 1;
      return 0;
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
      priorityLocations = ["karachi", "lahore", "islamabad"],
    } = options;

    this.rapidOidHandler = onExamWithOid || null;
    this.shouldStopPolling = false;
    this.processingOid = false;
    this.processedOids.clear();
    this.consecutiveErrors = 0;
    this.lockedExam = null;
    this.pollCount = 0;
    this.pollsOnCurrentIp = 0; // reset
    this.startTime = new Date();

    if (!this.apiUrl) {
      console.log("[startPolling] Capturing API URL");
      await this.captureApiUrl();

      if (!this.apiUrl) {
        console.error("[startPolling] Could not capture API URL");
        if (onTimeout) await onTimeout();
        return;
      }
    }

    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
    const targetDatePKT = new Date(targetDate.getTime() + PKT_OFFSET_MS);
    const [year, month, day] = targetDatePKT.toISOString().split("T")[0].split("-");
    const targetBookFromDate = `${day}.${month}.${year}`;
    /* 
        console.log(`[startPolling] Target (UTC): ${targetDate.toISOString()}`);
        console.log(`[startPolling] Target (PKT): ${targetDatePKT.toISOString()}`);
        console.log(`[startPolling] bookFrom date: ${targetBookFromDate}`); */


    this.isPolling = true;

    this.timeoutInterval = setTimeout(async () => {
      console.log(`[startPolling] Max duration reached (${maxDurationMs}ms)`);
      this.shouldStopPolling = true;
      if (onTimeout) await onTimeout();
      this.stopPolling();
    }, maxDurationMs);

    const rotateIp = async (): Promise<boolean> => {
      console.log(`[poll] Rotating IP after ${this.pollsOnCurrentIp} polls`);
      await this.closeBrowser();
      this.apiUrl = null;

      try {
        const { execSync } = await import("child_process");
        execSync("rm -rf ./profile_*");
        console.log("[poll] Cleaned up old profiles");
      } catch { }

      const newUrl = await this.captureApiUrl(5, 3000);
      if (!newUrl) {
        console.error("[poll] Failed to rotate IP");
        return false;
      }

      this.pollsOnCurrentIp = 0;
      this.consecutiveErrors = 0;
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



      const canContinue = await this.checkAndRecaptureApiUrl(rotateIp);
      if (!canContinue) {
        this.stopPolling();
        if (onTimeout) await onTimeout();
        return;
      }

      try {
        this.pollCount++;
        this.pollsOnCurrentIp++;

        const data = await this.browserApiCall();
        console.log(`[poll] Raw data:`, JSON.stringify(data)?.substring(0, 200));

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
          const matchingExams = data.DATA.filter(
            (exam: ExamData) => exam.bookFrom === targetBookFromDate
          );

          if (matchingExams.length > 0) {
            const exam = this.prioritizeExams(matchingExams, priorityLocations)[0];

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
        this.consecutiveErrors++;
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

  async forceStopPolling(maxWaitMs = 5000): Promise<void> {
    this.shouldStopPolling = true;
    this.stopPolling();

    const startTime = Date.now();
    while (this.processingOid && Date.now() - startTime < maxWaitMs) {
      console.log("[forceStopPolling] Waiting for OID processing to complete");
      await new Promise((r) => setTimeout(r, 500));
    }

    await this.closeBrowser();
  }

  getApiUrl(): string | null {
    return this.apiUrl;
  }

  getStatus(): any {
    const elapsed = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const rate = elapsed > 0 ? Math.round(this.pollCount / (elapsed / 1000)) : 0;

    return {
      isPolling: this.isPolling,
      hasApiUrl: !!this.apiUrl,
      apiUrl: this.apiUrl,
      processingOid: this.processingOid,
      processedOids: Array.from(this.processedOids),
      consecutiveErrors: this.consecutiveErrors,
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
    this.apiUrl = null;
    this.processedOids.clear();
    this.consecutiveErrors = 0;
    this.lockedExam = null;
    this.pollCount = 0;
    this.pollsOnCurrentIp = 0;
    this.startTime = null;
  }
}

export const examMonitor = new ExamMonitor();
export { ExamMonitor };