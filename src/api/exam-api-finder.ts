import puppeteer from "puppeteer";
import axios from "axios";
import http from "http";
import https from "https";
import dotenv from "dotenv";
dotenv.config();

const TARGET_URL = process.env.TARGET_URL || "https://www.goethe.de/ins/pk/en/spr/prf/gzb2.cfm"



const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30000,
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  keepAliveMsecs: 30000,
  rejectUnauthorized: false,
});
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

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
  pageNumber: number;
}

class ExamMonitor {
  private apiUrl: string | null =
    process.env.TEST_MODE === "true"
      ? "http://localhost:3001/api/mock-exam"
      : null;
  private timeoutInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private shouldStopPolling = false;
  private processingOid = false;
  private processedOids = new Set<string>();
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 5;
  private lastSuccessfulPoll: Date | null = null;
  private rapidOidHandler: ((exam: ExamData) => Promise<void>) | null = null;

  // Smart page tracking for optimized polling
  private lockedExam: LockedExam | null = null;
  private lastPageChecked = 0;
  private emptyPageStreak = 0;
  private maxPagesToCheck = 5;

  // Performance metrics
  private pollCount = 0;
  private startTime: Date | null = null;
  private lastApiCallDuration = 0;

  async captureApiUrl(
    maxRetries = 30,
    retryDelay = 5000
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`🔍 Attempt ${attempt}/${maxRetries}: Capturing API URL...`);

      let browser = null;
      try {
        browser = await puppeteer.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-blink-features=AutomationControlled",
          ],
          timeout: 30000,
        });

        const page = await browser.newPage();
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );
        await page.setViewport({ width: 1920, height: 1080 });

        const apiUrl = await new Promise<string | null>(async (resolve) => {
          let captured = false;
          const timeoutId = setTimeout(() => {
            if (!captured) resolve(null);
          }, 25000);

          page.on("response", (response) => {
            const url = response.url();
            if (!captured && url.includes("examfinder")) {
              captured = true;
              clearTimeout(timeoutId);
              console.log("✅ Captured API URL:", url);
              resolve(url);
            }
          });

          try {
            await page.goto(
            TARGET_URL,
              {
                waitUntil: "networkidle0",
                timeout: 20000,
              }
            );
          } catch (error) {
            console.log("Navigation error, but may have captured URL");
          }

          await new Promise((r) => setTimeout(r, 3000));
          if (!captured) {
            clearTimeout(timeoutId);
            resolve(null);
          }
        });

        await browser.close();

        if (apiUrl) {
          console.log(`✅ API URL captured successfully on attempt ${attempt}`);
          this.apiUrl = apiUrl;
          this.consecutiveErrors = 0;
          return apiUrl;
        }
      } catch (error) {
        console.error(`❌ Browser error on attempt ${attempt}:`, error);
        if (browser) {
          await browser.close().catch(() => { });
        }
      }

      if (attempt < maxRetries) {
        const waitTime = Math.min(retryDelay * Math.sqrt(attempt), 15000);
        console.log(`⏳ Waiting ${waitTime}ms before retry...`);
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }

    console.error(`❌ Failed to capture API URL after ${maxRetries} attempts`);
    return null;
  }

  private async directApiCall(
    pageNum: number = 1
  ): Promise<ApiResponse | null> {
    if (!this.apiUrl) return null;

    const startTime = Date.now();
    try {
      const url = new URL(this.apiUrl);

      if (pageNum > 1) {
        const pageSize = 10;
        const startValue = (pageNum - 1) * pageSize + 1;
        url.searchParams.set("page", pageNum.toString());
        url.searchParams.set("start", startValue.toString());
      }

      const response = await axios.get(url.toString(), {
        timeout: 5000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
        validateStatus: (status) => status === 200,
      });

      this.lastApiCallDuration = Date.now() - startTime;
      this.consecutiveErrors = 0;
      this.lastSuccessfulPoll = new Date();

      return response.data;
    } catch (error) {
      this.lastApiCallDuration = Date.now() - startTime;
      this.consecutiveErrors++;
      return null;
    }
  }

  private async checkAndRecaptureApiUrl(): Promise<boolean> {
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      console.warn(
        `⚠️ ${this.consecutiveErrors} consecutive errors → recapturing API URL...`
      );
      this.apiUrl = null;
      const newUrl = await this.captureApiUrl(5, 3000);

      if (newUrl) {
        console.log("✅ Successfully recaptured API URL");
        this.consecutiveErrors = 0;
        return true;
      }
      console.error("❌ Failed to recapture API URL");
      return false;
    }
    return true;
  }

  private prioritizeExams(
    exams: ExamData[],
    priorityLocations: string[]
  ): ExamData[] {
    if (!priorityLocations || priorityLocations.length === 0) {
      return exams;
    }

    return exams.sort((a, b) => {
      const aLocation = a.locationName?.toLowerCase() || "";
      const bLocation = b.locationName?.toLowerCase() || "";

      let aPriority = -1;
      let bPriority = -1;

      priorityLocations.forEach((location, index) => {
        const lowerLocation = location.toLowerCase();
        if (aLocation.includes(lowerLocation) && aPriority === -1) {
          aPriority = index;
        }
        if (bLocation.includes(lowerLocation) && bPriority === -1) {
          bPriority = index;
        }
      });

      if (aPriority !== -1 && bPriority !== -1) {
        return aPriority - bPriority;
      }

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
      priorityLocations = ["karachi", "islamabad",],
    } = options;

    this.rapidOidHandler = onExamWithOid || null;
    this.shouldStopPolling = false;
    this.processingOid = false;
    this.processedOids.clear();
    this.consecutiveErrors = 0;
    this.lockedExam = null;
    this.pollCount = 0;
    this.startTime = new Date();
    this.lastPageChecked = 0;
    this.emptyPageStreak = 0;

    if (!this.apiUrl) {
      console.log("Capturing API URL...");
      await this.captureApiUrl();

      if (!this.apiUrl) {
        console.error("❌ Could not capture API URL");
        if (onTimeout) await onTimeout();
        return;
      }
    }

    // Convert UTC time to IST (Indian Standard Time = UTC+5:30)
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds
    const targetDateIST = new Date(targetDate.getTime() + IST_OFFSET_MS);

    // Format for matching with API (which uses PST)
    const targetDateStr = targetDateIST.toISOString().split("T")[0];
    const targetTimeStr = targetDateIST
      .toISOString()
      .split("T")[1]
      .substring(0, 5);

    const [year, month, day] = targetDateStr.split("-");
    const targetBookFromDate = `${day}.${month}.${year}`; 
    const targetBookFromTime = `${targetTimeStr}:00.000`; 

    console.log(`🚀 Starting ULTRA-FAST polling mode`);
    console.log(`🎯 Target (UTC): ${targetDate.toISOString()}`);
    console.log(`🎯 Target (PST): ${targetDateIST.toISOString()}`);
    console.log(`🔍 Looking for exam with:`);
    console.log(`   - bookFrom: ${targetBookFromDate}`);
    console.log(`   - bookFromTime: ${targetBookFromTime} (IST)`);
    console.log(
      `⚡ Interval: ${interval}ms (${1000 / interval} checks/second)`
    );
    console.log(`📍 Priority locations: ${priorityLocations.join(", ")}`);
    console.log(` Timezone: PST (UTC+5:00)\n`);

    this.isPolling = true;

    // Set timeout for max duration
    this.timeoutInterval = setTimeout(async () => {
      console.log(`⏰ Max duration reached (${maxDurationMs}ms)`);
      this.shouldStopPolling = true;
      if (onTimeout) await onTimeout();
      this.stopPolling();
    }, maxDurationMs);

    // Ultra-fast polling loop
    const rapidPoll = async () => {
      if (this.shouldStopPolling) {
        this.stopPolling();
        return;
      }

      // Skip this iteration if still processing an OID
      if (this.processingOid) {
        setImmediate(() => setTimeout(rapidPoll, interval));
        return;
      }

      // Check if we need to recapture API URL
      const canContinue = await this.checkAndRecaptureApiUrl();
      if (!canContinue) {
        this.stopPolling();
        if (onTimeout) await onTimeout();
        return;
      }

      try {
        this.pollCount++;

        // STAGE 1: If we've locked onto an exam, only check that page
        if (this.lockedExam) {
          const data = await this.directApiCall(this.lockedExam.pageNumber);

          if (data?.DATA && Array.isArray(data.DATA)) {
            // Find our specific locked exam
            const lockedExam = data.DATA.find(
              (exam: ExamData) =>
                exam.locationName === this.lockedExam!.locationName &&
                exam.startDate === this.lockedExam!.startDate &&
                exam.moduleId === this.lockedExam!.moduleId
            );

            if (lockedExam) {
              // Check if OID appeared
              if (lockedExam.oid && !this.processedOids.has(lockedExam.oid)) {
                const elapsed = this.startTime
                  ? Date.now() - this.startTime.getTime()
                  : 0;
                console.log(`\ OID DETECTED IN ${elapsed}ms`);
                console.log(`🎯 OID: ${lockedExam.oid}`);
                console.log(
                  `📍 Location: ${lockedExam.locationName || "Unknown"}`
                );
                console.log(`📄 Page: ${this.lockedExam.pageNumber}`);
                console.log(`📊 Poll count: ${this.pollCount}`);

                this.processedOids.add(lockedExam.oid);
                this.processingOid = true;

                // Pass exam with oid
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
              } else if (!lockedExam.oid) {
                // Show brief status every 10 polls
                if (this.pollCount % 10 === 0) {
                  console.log(
                    `⏳ Locked exam on page ${this.lockedExam.pageNumber} - waiting for OID... (${this.pollCount} polls)`
                  );
                }
              }
            } else {
              console.log(
                `⚠️ Locked exam disappeared from page ${this.lockedExam.pageNumber}, resuming full scan`
              );
              this.lockedExam = null;
            }
          }
        }
        // STAGE 2: Full page scan to FIND and LOCK the exam
        else {
          let foundExam = false;
          let pagesToCheck = Math.min(this.maxPagesToCheck, 5);

          // Reduce pages to check if we've had empty streaks
          if (this.emptyPageStreak > 3) {
            pagesToCheck = 2;
          }

          for (let page = 1; page <= pagesToCheck; page++) {
            const data = await this.directApiCall(page);

            if (!data?.DATA || !Array.isArray(data.DATA)) {
              break;
            }

            if (data.DATA.length === 0) {
              this.emptyPageStreak++;
              break;
            }

            this.emptyPageStreak = 0;

            // Find exams matching bookFrom and bookFromTime
            const matchingExams = data.DATA.filter((exam: ExamData) => {
              return (
                exam.bookFrom === targetBookFromDate &&
                exam.bookFromTime === targetBookFromTime
              );
            });

            if (matchingExams.length > 0) {
              foundExam = true;
              const prioritizedExams = this.prioritizeExams(
                matchingExams,
                priorityLocations
              );
              const exam = prioritizedExams[0];

              // LOCK ONTO THIS EXAM
              this.lockedExam = {
                locationName: exam.locationName || "",
                startDate: exam.startDate || "",
                moduleId: exam.moduleId || "",
                bookFrom: exam.bookFrom || "",
                bookFromTime: exam.bookFromTime || "",
                pageNumber: page,
              };

              console.log(`\nEXAM LOCKED!`);
              console.log(`   📍 Location: ${exam.locationName}`);
              console.log(`   📅 Exam Date: ${exam.startDate}`);
              console.log(`   🆔 Module ID: ${exam.moduleId}`);
              console.log(`   📄 Page: ${page}`);
              console.log(
                `  Booking opens: ${exam.bookFrom} ${exam.bookFromTimeFormatted || exam.bookFromTime
                }`
              );
              console.log(`   🔍 Now monitoring for OID...`);

              if (onExamFound) {
                setImmediate(() => onExamFound(exam));
              }

              // Check immediately if OID already exists
              if (exam.oid && !this.processedOids.has(exam.oid)) {
                const elapsed = this.startTime
                  ? Date.now() - this.startTime.getTime()
                  : 0;
                console.log(
                  `\nOID ALREADY PRESENT! ${elapsed}ms `
                );
                console.log(`🎯 OID: ${exam.oid}`);

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

              break; // Stop checking other pages
            }
          }

          if (!foundExam) {
            // Show status every 10 polls when no exam found
            if (this.pollCount % 10 === 0) {
              const elapsed = this.startTime
                ? Date.now() - this.startTime.getTime()
                : 0;
              const rate =
                elapsed > 0 ? Math.round(this.pollCount / (elapsed / 1000)) : 0;
              console.log(
                `⏳ [${new Date().toLocaleTimeString()}] Scanning for exam... | Polls: ${this.pollCount
                } | Rate: ${rate}/s | Pages: ${pagesToCheck}`
              );
            }
          }
        }

        // Log performance warning if API calls are slow
        if (this.lastApiCallDuration > 1000) {
          console.warn(`⚠️ Slow API call: ${this.lastApiCallDuration}ms`);
        }
      } catch (error) {
        console.error("❌ Poll error:", error);
        this.consecutiveErrors++;
      }

      // Schedule next poll
      setImmediate(() => setTimeout(rapidPoll, interval));
    };

    // Start polling immediately
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

      const elapsed = this.startTime
        ? Date.now() - this.startTime.getTime()
        : 0;
      console.log("\n🛑 Polling stopped");
      console.log(`📊 Statistics:`);
      console.log(`   - Total polls: ${this.pollCount}`);
      console.log(`   - Duration: ${elapsed}ms`);
      console.log(
        `   - Average rate: ${Math.round(
          this.pollCount / (elapsed / 1000)
        )} polls/second`
      );
      console.log(`   - Processed OIDs: ${this.processedOids.size}`);
    }
  }

  async forceStopPolling(maxWaitMs = 5000): Promise<void> {
    this.shouldStopPolling = true;
    this.stopPolling();

    const startTime = Date.now();
    while (this.processingOid && Date.now() - startTime < maxWaitMs) {
      console.log("Waiting for OID processing to complete...");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  getApiUrl(): string | null {
    return this.apiUrl;
  }

  getStatus(): any {
    const elapsed = this.startTime ? Date.now() - this.startTime.getTime() : 0;
    const rate =
      elapsed > 0 ? Math.round(this.pollCount / (elapsed / 1000)) : 0;

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
    };
  }

  async destroy() {
    await this.forceStopPolling();
    this.apiUrl = null;
    this.processedOids.clear();
    this.consecutiveErrors = 0;
    this.lockedExam = null;
    this.pollCount = 0;
    this.startTime = null;
  }
}

export const examMonitor = new ExamMonitor();
export { ExamMonitor };
