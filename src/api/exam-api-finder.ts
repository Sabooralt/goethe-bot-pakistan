import puppeteer from "puppeteer";
import axios from "axios";

interface ExamModule {
  date: string;
  startTime: string;
}

interface ExamData {
  oid?: string;
  modules?: ExamModule[];
  [key: string]: any;
}

interface ApiResponse {
  DATA?: ExamData[];
  [key: string]: any;
}

class ExamApiMonitor {
  private apiUrl: string | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private timeoutInterval: NodeJS.Timeout | null = null;
  private isPolling = false;

  /**
   * Captures the exam API URL using Puppeteer with retry logic
   */
  async captureApiUrl(
    maxRetries = 20,
    retryDelay = 10000
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(
        `🔍 Attempt ${attempt}/${maxRetries}: Launching browser to capture API URL...`
      );

      let browser = null;
      try {
        browser = await puppeteer.launch({
          headless: true, // Set to false for debugging
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
          ],
        });

        const page = await browser.newPage();

        // Set user agent to avoid detection
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );

        const apiUrl = await new Promise<string | null>(async (resolve) => {
          let apiUrlCaptured = false;

          // Set up response interceptor
          page.on("response", async (response) => {
            if (apiUrlCaptured) return;

            const url = response.url();
            if (url.includes("examfinder")) {
              console.log("✅ Captured API URL:", url);
              this.apiUrl = url;
              apiUrlCaptured = true;
              resolve(url);
            }
          });

          try {
            await page.goto(
              "https://www.goethe.de/ins/in/en/spr/prf/gzb2.cfm",
              {
                waitUntil: "networkidle2",
                timeout: 25000,
              }
            );

            // Wait a bit more to ensure all requests are captured
            await new Promise((resolve) => setTimeout(resolve, 3000));

            if (!apiUrlCaptured) {
              resolve(null);
            }
          } catch (error) {
            console.error(`❌ Navigation error on attempt ${attempt}:`, error);
            resolve(null);
          }
        });

        await browser.close();

        if (apiUrl) {
          console.log(`✅ Successfully captured API URL on attempt ${attempt}`);
          return apiUrl;
        }
      } catch (error) {
        console.error(`❌ Browser error on attempt ${attempt}:`, error);
        if (browser) {
          try {
            await browser.close();
          } catch (e) {
            // Ignore close errors
          }
        }
      }

      // If not the last attempt, wait before retrying
      if (attempt < maxRetries) {
        console.log(`⏳ Waiting ${retryDelay}ms before next attempt...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    console.error(`❌ Failed to capture API URL after ${maxRetries} attempts`);
    return null;
  }

  /**
   * Starts polling the API for exams at specified date/time
   */
  async startPolling(
    targetDate: Date,
    options: {
      interval?: number;
      onExamFound?: (exam: ExamData) => void;
      onExamWithOid?: (exam: ExamData) => void;
      onTimeout?: () => void;
      stopOnFirstOid?: boolean;
      maxDurationMs?: number;
    } = {}
  ) {
    const {
      interval = 5000,
      onExamFound,
      onExamWithOid,
      onTimeout,
      stopOnFirstOid = true,
      maxDurationMs = 30 * 60 * 1000, // Default to 30 minutes
    } = options;

    // Ensure we have the API URL
    if (!this.apiUrl) {
      console.log("📡 API URL not available, capturing it first...");
      await this.captureApiUrl();

      if (!this.apiUrl) {
        console.error("❌ Could not capture API URL, aborting polling");
        return;
      }
    }

    if (this.isPolling) {
      console.log("⚠️ Already polling, stopping previous poll first");
      this.stopPolling();
    }

    const targetDateStr = targetDate.toISOString().split("T")[0];
    const targetTimeStr = targetDate.toTimeString().split(" ")[0]; // Gets HH:MM:SS

    console.log(
      `📡 Starting to poll API every ${
        interval / 1000
      }s for exam on ${targetDateStr} at ${targetTimeStr}`
    );
    console.log(
      `⏰ Maximum polling duration: ${maxDurationMs / 60000} minutes`
    );
    console.log(`🔗 Using API URL: ${this.apiUrl}`);

    this.isPolling = true;

    // Set timeout to stop polling after maxDurationMs
    this.timeoutInterval = setTimeout(async () => {
      console.log(
        `⏰ Reached max duration of ${
          maxDurationMs / 60000
        } minutes - no exam found`
      );

      // Call the timeout callback if provided
      if (onTimeout) {
        try {
          await onTimeout();
        } catch (error) {
          console.error("❌ Error in timeout callback:", error);
        }
      }

      this.stopPolling();
    }, maxDurationMs);

    this.pollInterval = setInterval(async () => {
      try {
        const response = await axios.get(this.apiUrl!, {
          timeout: 10000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        });

        const data: ApiResponse = response.data;

        if (!data.DATA || !Array.isArray(data.DATA)) {
          console.warn("⚠️ Unexpected API response format");
          return;
        }

        // Find matching exams
        const matchingExams = data.DATA.filter((exam: ExamData) =>
          exam.modules?.some((module: ExamModule) => {
            const moduleDate = module.date === targetDateStr;
            const moduleTime = module.startTime.startsWith(
              targetTimeStr.substring(0, 5)
            ); // Match HH:MM
            return moduleDate && moduleTime;
          })
        );

        if (matchingExams.length > 0) {
          console.log(
            `✅ Found ${matchingExams.length} matching exam(s) on ${targetDateStr} at ${targetTimeStr}`
          );

          for (const exam of matchingExams) {
            // Call the general exam found callback
            if (onExamFound) {
              try {
                await onExamFound(exam);
              } catch (error) {
                console.error("❌ Error in onExamFound callback:", error);
              }
            }

            if (exam.oid) {
              console.log(`🎯 Exam with OID found: ${exam.oid}`);

              if (onExamWithOid) {
                try {
                  await onExamWithOid(exam);
                } catch (error) {
                  console.error("❌ Error in onExamWithOid callback:", error);
                }
              }

              if (stopOnFirstOid) {
                console.log("🛑 Stopping polling (found exam with OID)");
                this.stopPolling();
                return;
              }
            } else {
              console.log(
                "⏳ Exam found but no OID yet, continuing to poll..."
              );
            }
          }
        } else {
          const now = new Date().toLocaleTimeString();
          console.log(
            `⌛ [${now}] No matching exams found, continuing to poll...`
          );
        }
      } catch (error: any) {
        console.error("❌ Error polling API:", error.message);

        // If it's a network error, try to recapture the API URL
        if (
          axios.isAxiosError(error) &&
          (error.code === "ECONNREFUSED" || error.response?.status === 404)
        ) {
          console.log(
            "🔄 Network error detected, attempting to recapture API URL..."
          );
          this.apiUrl = null;
          await this.captureApiUrl();
        }
      }
    }, interval);
  }

  /**
   * Stops the current polling operation
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.timeoutInterval) {
      clearTimeout(this.timeoutInterval);
      this.timeoutInterval = null;
    }

    if (this.isPolling) {
      this.isPolling = false;
      console.log("🛑 Polling stopped");
    }
  }

  /**
   * Gets the current API URL without launching browser
   */
  getApiUrl(): string | null {
    return this.apiUrl;
  }

  /**
   * Forces recapture of API URL with retry logic
   */
  async refreshApiUrl(
    maxRetries = 5,
    retryDelay = 3000
  ): Promise<string | null> {
    this.apiUrl = null;
    return await this.captureApiUrl(maxRetries, retryDelay);
  }

  /**
   * Get current polling status
   */
  getStatus(): {
    isPolling: boolean;
    hasApiUrl: boolean;
    apiUrl: string | null;
  } {
    return {
      isPolling: this.isPolling,
      hasApiUrl: !!this.apiUrl,
      apiUrl: this.apiUrl,
    };
  }

  /**
   * Cleanup method
   */
  destroy() {
    this.stopPolling();
    this.apiUrl = null;
  }
}

export { ExamApiMonitor };
export const examMonitor = new ExamApiMonitor();

// Legacy function for backward compatibility
export async function pollExamApi(
  runAt: Date = new Date("2025-09-21T09:00:00.000+00:00"),
  interval = 5000
) {
  await examMonitor.startPolling(runAt, {
    interval,
    maxDurationMs: 30 * 60 * 1000, // 30 minutes
    onExamWithOid: (exam) => {
      console.log(`🎯 Ready to process exam with OID: ${exam.oid}`);
      // Add your cluster processing logic here
      // await runCluster(exam);
    },
    onTimeout: () => {
      console.log("⏰ Polling timeout - no exam found within 30 minutes");
    },
  });
}
