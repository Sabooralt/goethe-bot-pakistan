import puppeteer from "puppeteer";
import axios from "axios";
import { runAllAccounts } from "../cluster/runCluster";

interface ExamModule {
  date: string;
  startTime: string;
}

interface ExamData {
  oid?: string;
  modules?: ExamModule[];
  bookFromStamp?: string;
  bookToStamp?: string;
  bookFrom?: string;
  bookTo?: string;
  eventName?: string;
  locationName?: string; // Added location name property
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

class ExamApiMonitor {
  private apiUrl: string | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private timeoutInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private shouldStopPolling = false;
  private processingOid = false;
  private processedOids = new Set<string>();

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
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-blink-features=AutomationControlled",
            "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          ],
        });

        const page = await browser.newPage();

        // Better user agent and viewport
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );
        await page.setViewport({ width: 1920, height: 1080 });

        const apiUrl = await new Promise<string | null>(async (resolve) => {
          let apiUrlCaptured = false;
          const timeoutId = setTimeout(() => {
            if (!apiUrlCaptured) {
              console.log(
                `⏱️ Timeout waiting for API URL on attempt ${attempt}`
              );
              resolve(null);
            }
          }, 20000);

          // Set up response interceptor
          page.on("response", async (response) => {
            if (apiUrlCaptured) return;

            const url = response.url();
            if (url.includes("examfinder")) {
              console.log("✅ Captured API URL:", url);
              this.apiUrl = url;
              apiUrlCaptured = true;
              clearTimeout(timeoutId);
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

            // Additional wait to ensure all requests are captured
            await new Promise((resolve) => setTimeout(resolve, 5000));

            if (!apiUrlCaptured) {
              clearTimeout(timeoutId);
              resolve(null);
            }
          } catch (error) {
            console.error(`❌ Navigation error on attempt ${attempt}:`, error);
            clearTimeout(timeoutId);
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
            console.error("Error closing browser:", e);
          }
        }
      }

      // Wait before retrying
      if (attempt < maxRetries) {
        console.log(`⏳ Waiting ${retryDelay}ms before next attempt...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    console.error(`❌ Failed to capture API URL after ${maxRetries} attempts`);
    return null;
  }

  /**
   * Prioritize exams based on location preferences
   */
  private prioritizeExams(
    exams: ExamData[],
    priorityLocations: string[]
  ): ExamData[] {
    if (!priorityLocations || priorityLocations.length === 0) {
      return exams;
    }

    // Sort exams by priority location
    return exams.sort((a, b) => {
      const aLocation = a.locationName?.toLowerCase() || "";
      const bLocation = b.locationName?.toLowerCase() || "";

      // Check priority for each exam
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

      // If both have priority, sort by priority order
      if (aPriority !== -1 && bPriority !== -1) {
        return aPriority - bPriority;
      }

      // Priority locations come first
      if (aPriority !== -1) return -1;
      if (bPriority !== -1) return 1;

      // No priority difference
      return 0;
    });
  }

  /**
   * Starts polling the API for exams at specified date/time
   */
  async startPolling(targetDate: Date, options: PollingOptions = {}) {
    const {
      interval = 5000,
      onExamFound,
      onExamWithOid,
      onTimeout,
      stopOnFirstOid = true,
      maxDurationMs = 5 * 60 * 60 * 1000,
      priorityLocations = ["chennai", "bengal", "bangalore"], // Default priority locations
    } = options;

    // Reset flags
    this.shouldStopPolling = false;
    this.processingOid = false;
    this.processedOids.clear();

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
      // Wait for previous polling to fully stop
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const targetDateStr = targetDate.toISOString().split("T")[0];
    const targetTimeStr = targetDate.toTimeString().split(" ")[0];

    console.log(
      `📡 Starting to poll API every ${
        interval / 1000
      }s for exams with booking opening at ${targetDateStr} at ${targetTimeStr}`
    );
    console.log(
      `⏰ Maximum polling duration: ${maxDurationMs / 60000} minutes`
    );
    console.log(`📍 Priority locations: ${priorityLocations.join(", ")}`);
    console.log(`🔗 Using API URL: ${this.apiUrl}`);

    this.isPolling = true;

    // Set timeout to stop polling after maxDurationMs
    this.timeoutInterval = setTimeout(async () => {
      console.log(
        `⏰ Reached max duration of ${
          maxDurationMs / 60000
        } minutes - stopping poll`
      );

      this.shouldStopPolling = true;

      if (onTimeout) {
        try {
          await onTimeout();
        } catch (error) {
          console.error("❌ Error in timeout callback:", error);
        }
      }

      this.stopPolling();
    }, maxDurationMs);

    // Main polling loop
    this.pollInterval = setInterval(async () => {
      // Check if we should stop polling
      if (this.shouldStopPolling) {
        console.log("🛑 Polling stop requested, clearing interval");
        this.stopPolling();
        return;
      }

      // Skip this iteration if we're processing an OID
      if (this.processingOid) {
        console.log(
          "⏳ Still processing previous OID, skipping this poll iteration"
        );
        return;
      }

      try {
        const response = await axios.get(this.apiUrl!, {
          timeout: 10000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
          },
        });

        const data: ApiResponse = response.data;

        if (!data.DATA || !Array.isArray(data.DATA)) {
          console.warn("⚠️ Unexpected API response format");
          return;
        }

        // Find matching exams by checking when booking opens
        let matchingExams = data.DATA.filter((exam: ExamData) => {
          if (!exam.bookFromStamp) {
            return false;
          }

          const bookFromDate = new Date(exam.bookFromStamp);
          const bookFromDateStr = bookFromDate.toISOString().split("T")[0];
          const bookFromTimeStr = bookFromDate.toTimeString().split(" ")[0];

          const dateMatches = bookFromDateStr === targetDateStr;
          const timeMatches =
            bookFromTimeStr.substring(0, 5) === targetTimeStr.substring(0, 5);

          return dateMatches && timeMatches;
        });

        if (matchingExams.length > 0) {
          // Prioritize exams based on location
          matchingExams = this.prioritizeExams(
            matchingExams,
            priorityLocations
          );

          const firstExam = matchingExams[0];
          console.log(`✅ Found ${matchingExams.length} matching exam(s)`);

          if (matchingExams.length > 1) {
            console.log(`🎯 Multiple exams found. Processing by priority:`);
            matchingExams.forEach((exam, index) => {
              console.log(
                `  ${index + 1}. ${exam.eventName || "Unknown"} at ${
                  exam.locationName || "Unknown Location"
                } ${
                  exam.oid
                    ? `(OID: ${exam.oid.substring(0, 8)}...)`
                    : "(No OID yet)"
                }`
              );
            });
          }

          // Log exam details
          if (firstExam.bookFromStamp && firstExam.bookToStamp) {
            const bookFrom = new Date(firstExam.bookFromStamp);
            const bookTo = new Date(firstExam.bookToStamp);
            console.log(
              `📅 Booking window: ${bookFrom.toLocaleString()} → ${bookTo.toLocaleString()}`
            );
          }

          // Process exams in priority order
          for (const exam of matchingExams) {
            // Skip if already processed this OID
            if (exam.oid && this.processedOids.has(exam.oid)) {
              console.log(
                `⏭️ Skipping already processed OID: ${exam.oid.substring(
                  0,
                  8
                )}...`
              );
              continue;
            }

            // Call the general exam found callback
            if (onExamFound) {
              try {
                await onExamFound(exam);
              } catch (error) {
                console.error("❌ Error in onExamFound callback:", error);
              }
            }

            if (exam.oid) {
              console.log(
                `🎯 Exam with OID found: ${exam.oid} (${
                  exam.eventName || "Unknown"
                }) at ${exam.locationName || "Unknown Location"}`
              );

              // Mark as processed
              this.processedOids.add(exam.oid);

              if (onExamWithOid) {
                try {
                  // Set processing flag BEFORE calling the callback
                  this.processingOid = true;

                  if (stopOnFirstOid) {
                    // Mark for stopping BEFORE processing
                    this.shouldStopPolling = true;
                    console.log(
                      "🛑 Marking polling for stop (found exam with OID)"
                    );
                  }

                  // Process the exam
                  await onExamWithOid(exam);

                  // Clear processing flag after completion
                  this.processingOid = false;

                  if (stopOnFirstOid) {
                    // Stop polling after processing
                    this.stopPolling();
                    return;
                  }
                } catch (error) {
                  console.error("❌ Error in onExamWithOid callback:", error);
                  this.processingOid = false;
                }
              }

              if (stopOnFirstOid && !onExamWithOid) {
                this.shouldStopPolling = true;
                this.stopPolling();
                return;
              }
            } else {
              console.log(
                `⏳ Exam found (${exam.eventName || "Unknown"}) at ${
                  exam.locationName || "Unknown Location"
                } but no OID yet, continuing to poll...`
              );
            }
          }
        } else {
          const now = new Date().toLocaleTimeString();
          console.log(
            `⌛ [${now}] No matching exams with booking opening at ${targetDateStr} ${targetTimeStr}`
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
          const newUrl = await this.captureApiUrl(3, 5000); // Fewer retries for network errors
          if (!newUrl) {
            console.error("❌ Failed to recapture API URL, stopping polling");
            this.stopPolling();
          }
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
      this.shouldStopPolling = true;
      console.log("🛑 Polling stopped");
    }
  }

  /**
   * Force stops polling and waits for any processing to complete
   */
  async forceStopPolling(maxWaitMs = 10000): Promise<void> {
    this.shouldStopPolling = true;
    this.stopPolling();

    const startTime = Date.now();
    while (this.processingOid && Date.now() - startTime < maxWaitMs) {
      console.log("⏳ Waiting for OID processing to complete...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (this.processingOid) {
      console.warn("⚠️ Force stop timeout - processing may still be running");
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
    processingOid: boolean;
    processedOids: string[];
  } {
    return {
      isPolling: this.isPolling,
      hasApiUrl: !!this.apiUrl,
      apiUrl: this.apiUrl,
      processingOid: this.processingOid,
      processedOids: Array.from(this.processedOids),
    };
  }

  /**
   * Cleanup method
   */
  async destroy() {
    await this.forceStopPolling();
    this.apiUrl = null;
    this.processedOids.clear();
  }
}

// Export singleton instance
export const examMonitor = new ExamApiMonitor();

// Export class for testing or multiple instances
export { ExamApiMonitor };

// Updated legacy function with location priority
export async function pollExamApi(
  runAt: Date,
  interval = 5000,
  priorityLocations: string[] = ["new delhi", "bengal", "bangalore"]
) {
  await examMonitor.startPolling(runAt, {
    interval,
    stopOnFirstOid: true,
    maxDurationMs: 30 * 60 * 1000,
    priorityLocations,
    onExamWithOid: async (exam) => {
      console.log(`🎯 Ready to process exam with OID: ${exam.oid}`);
      console.log(`📍 Location: ${exam.locationName || "Unknown"}`);

      try {
        // Call runAllAccounts and wait for it to complete
        await runAllAccounts(exam.oid!);
        console.log(`✅ Finished processing OID: ${exam.oid}`);
      } catch (error) {
        console.error(`❌ Error processing OID ${exam.oid}:`, error);
        throw error; // Re-throw to be handled by the monitor
      }
    },
    onTimeout: () => {
      console.log("⏰ Polling timeout - no exam found within 30 minutes");
    },
  });
}
