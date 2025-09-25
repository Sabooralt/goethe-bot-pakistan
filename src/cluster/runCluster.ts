import puppeteer, { Browser, Page } from "puppeteer";
import Account from "../models/accountSchema";
import startBooking from "../booking/book";
import { bot } from "..";
import Schedule, { ISchedule } from "../models/scheduleSchema";
import { UserDocument } from "../models/userSchema";
import { exec } from "child_process";
import { promisify } from "util";
import dotenv from "dotenv";

dotenv.config();
const execAsync = promisify(exec);

interface BrowserInstance {
  browser: Browser;
  page: Page;
  display: string;
  accountEmail: string;
}

interface ScheduleManager {
  browsers: BrowserInstance[];
  isRunning: boolean;
  shouldStop: boolean;
  processedCount: number;
  successCount: number;
  errorCount: number;
}

const activeSchedules: Map<string, ScheduleManager> = new Map();
const availableDisplays = Array.from({ length: 20 }, (_, i) => `:${i + 99}`); // :99 to :118
let displayCounter = 0;

const getNextDisplay = (): string => {
  const display = availableDisplays[displayCounter % availableDisplays.length];
  displayCounter++;
  return display;
};

const startXvfbDisplay = async (displayNum: string): Promise<void> => {
  try {
    console.log(`🖥️ Starting Xvfb display ${displayNum}...`);
    await execAsync(`/root/start-display.sh ${displayNum.replace(":", "")}`);
    // Give display time to initialize
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log(`✅ Display ${displayNum} started successfully`);
  } catch (error) {
    console.error(`❌ Failed to start display ${displayNum}:`, error);
    throw error;
  }
};

const createBrowserInstance = async (
  account: any,
  display: string
): Promise<BrowserInstance> => {
  try {
    console.log(
      `🌐 Creating browser for ${account.email} on display ${display}...`
    );

    const browser = await puppeteer.launch({
      headless: false,
      env: { DISPLAY: display },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        `--display=${display}`,
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-default-apps",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    console.log(`✅ Browser created for ${account.email} on ${display}`);

    return {
      browser,
      page,
      display,
      accountEmail: account.email,
    };
  } catch (error) {
    console.error(`❌ Failed to create browser for ${account.email}:`, error);
    throw error;
  }
};

const closeBrowserInstance = async (
  browserInstance: BrowserInstance
): Promise<void> => {
  try {
    console.log(`🔄 Closing browser for ${browserInstance.accountEmail}...`);
    await browserInstance.browser.close();
    console.log(`✅ Browser closed for ${browserInstance.accountEmail}`);
  } catch (error) {
    console.error(
      `❌ Error closing browser for ${browserInstance.accountEmail}:`,
      error
    );
  }
};

const processAccount = async (
  account: any,
  oid: string,
  scheduleManager: ScheduleManager,
  schedule: ISchedule | null,
  user: UserDocument | null
): Promise<void> => {
  let browserInstance: BrowserInstance | null = null;

  try {
    // Check if schedule should stop before processing
    if (scheduleManager.shouldStop) {
      console.log(`⏹️ Skipping ${account.email} - schedule marked for stop`);
      return;
    }

    const display = getNextDisplay();

    // Start Xvfb display
    await startXvfbDisplay(display);

    // Create browser instance
    browserInstance = await createBrowserInstance(account, display);
    scheduleManager.browsers.push(browserInstance);

    console.log(`🔄 Processing ${account.email} on display ${display}`);

    // Process the account booking with display info for noVNC access
    const displayNumber = parseInt(display.replace(":", ""));
    const displayInfo = {
      display: display,
      displayNumber: display.replace(":", ""),
      noVncUrl: `http://${process.env.SERVER_IP || "localhost"}:${
        6080 + displayNumber - 99
      }`,
      vncPort: 5900 + displayNumber - 99,
    };

    console.log(
      `📺 Account ${account.email} browser accessible at: ${displayInfo.noVncUrl}`
    );

    await startBooking(browserInstance.page, account, oid, bot, displayInfo);

    scheduleManager.processedCount++;
    scheduleManager.successCount++;

    console.log(`✅ Account ${account.email} processed successfully`);

    // Send periodic updates
    const totalAccounts =
      scheduleManager.processedCount +
      (scheduleManager.browsers.length - scheduleManager.processedCount);

    if (
      scheduleManager.processedCount % 2 === 0 ||
      scheduleManager.processedCount === totalAccounts
    ) {
      if (user?.telegramId && schedule) {
        await bot.sendMessage(
          user.telegramId,
          `📊 **Progress Update**\n` +
            `📝 Schedule: ${schedule.name}\n` +
            `✅ Processed: ${scheduleManager.processedCount}/${totalAccounts}\n` +
            `🎯 Successful: ${scheduleManager.successCount}\n` +
            `❌ Errors: ${scheduleManager.errorCount}`
        );
      }
    }
  } catch (accountError) {
    scheduleManager.processedCount++;
    scheduleManager.errorCount++;

    console.error(`❌ Account ${account.email} failed:`, accountError);

    // Send error notification to account owner
    if (account.user?.telegramId) {
      await bot.sendMessage(
        account.user.telegramId,
        `❌ **Account Error**\n` +
          `📧 Account: ${account.email}\n` +
          `🚨 Error: ${(accountError as Error).message}\n` +
          `⏰ Time: ${new Date().toLocaleString()}`,
        { parse_mode: "Markdown" }
      );
    }

    // Also send to schedule owner if different
    if (
      user?.telegramId &&
      user.telegramId !== account.user?.telegramId &&
      schedule
    ) {
      await bot.sendMessage(
        user.telegramId,
        `⚠️ **Account Error in Schedule**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `📧 Account: ${account.email}\n` +
          `❌ Error: ${(accountError as Error).message}`,
        { parse_mode: "Markdown" }
      );
    }

    throw accountError;
  } finally {
    // Close browser instance after processing (or on error)
    if (browserInstance) {
      await closeBrowserInstance(browserInstance);
      // Remove from active browsers list
      const index = scheduleManager.browsers.findIndex(
        (b) => b === browserInstance
      );
      if (index > -1) {
        scheduleManager.browsers.splice(index, 1);
      }
    }
  }
};

export const runAllAccounts = async (oid: string, scheduleId?: string) => {
  let schedule: ISchedule | null = null;
  let user: UserDocument | null = null;
  let scheduleManager: ScheduleManager | null = null;

  try {
    console.log("🚀 Starting individual browser automation...");

    // Get schedule and user info for logging
    if (scheduleId) {
      schedule = await Schedule.findById(scheduleId).populate("createdBy");
      if (schedule?.createdBy) {
        user = schedule.createdBy as any;
      }
    }

    // Initialize schedule manager
    scheduleManager = {
      browsers: [],
      isRunning: true,
      shouldStop: false,
      processedCount: 0,
      successCount: 0,
      errorCount: 0,
    };

    if (scheduleId) {
      activeSchedules.set(scheduleId, scheduleManager);
    }

    // Send initial log to user
    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `🚀 **Automation Started**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `🆔 OID: ${oid}\n` +
          `⚡ Initializing individual browsers...`,
        { parse_mode: "Markdown" }
      );
    }

    // Get all active accounts
    const accounts = await Account.find({ status: true }).populate("user");

    if (!accounts || accounts.length === 0) {
      console.log("ℹ️ No active accounts found. Exiting...");

      const errorMsg = "No active accounts found";

      // Update schedule status if applicable
      if (scheduleId) {
        await Schedule.findByIdAndUpdate(scheduleId, {
          completed: true,
          status: "failed",
          lastRun: new Date(),
          lastError: errorMsg,
        });
      }

      // Send notification to user
      if (user?.telegramId && schedule) {
        await bot.sendMessage(
          user.telegramId,
          `❌ **Schedule Failed**\n` +
            `📝 Schedule: ${schedule.name}\n` +
            `🚨 Error: ${errorMsg}\n` +
            `💡 Please add active accounts and try again.`,
          { parse_mode: "Markdown" }
        );
      }

      return;
    }

    // Send progress update to user
    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `🔄 **Processing Accounts**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `👥 Found ${accounts.length} active accounts\n` +
          `⚡ Starting booking process...`
      );
    }

    console.log(`📊 Processing ${accounts.length} accounts...`);

    // Process accounts with controlled concurrency (max 2 concurrent)
    const maxConcurrent = 2;
    const accountQueue = [...accounts];
    const activePromises: Promise<void>[] = [];

    while (accountQueue.length > 0 || activePromises.length > 0) {
      // Check if schedule should stop
      if (scheduleManager.shouldStop) {
        console.log("⏹️ Schedule stop requested, breaking processing loop");
        break;
      }

      // Start new accounts if we have space and accounts to process
      while (activePromises.length < maxConcurrent && accountQueue.length > 0) {
        const account = accountQueue.shift()!;

        const accountPromise = processAccount(
          account,
          oid,
          scheduleManager,
          schedule,
          user
        ).catch((error) => {
          // Error handling is already done in processAccount
          console.error(`Account ${account.email} processing failed:`, error);
        });

        activePromises.push(accountPromise);
      }

      // Wait for at least one account to complete
      if (activePromises.length > 0) {
        await Promise.race(activePromises);

        // Remove completed promises
        for (let i = activePromises.length - 1; i >= 0; i--) {
          const promise = activePromises[i];
          // Check if promise is resolved
          try {
            const result = await Promise.race([
              promise,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), 0)
              ),
            ]);
            // If we get here, the promise resolved
            activePromises.splice(i, 1);
          } catch (error: any) {
            if (error.message !== "timeout") {
              // Promise rejected
              activePromises.splice(i, 1);
            }
          }
        }
      }
    }

    // Wait for all remaining promises to complete
    await Promise.allSettled(activePromises);

    console.log("✅ All accounts processed!");
    console.log(
      `📊 Final stats: ${scheduleManager.successCount} successful, ${scheduleManager.errorCount} errors out of ${accounts.length} total`
    );

    // Update schedule status if applicable
    if (scheduleId) {
      const isSuccess = scheduleManager.errorCount === 0;
      const wasStopped = scheduleManager.shouldStop;

      await Schedule.findByIdAndUpdate(scheduleId, {
        completed: true,
        status: wasStopped
          ? "stopped"
          : isSuccess
          ? "success"
          : "partial_success",
        lastRun: new Date(),
        lastError: wasStopped
          ? "Schedule stopped by user request"
          : isSuccess
          ? null
          : `${scheduleManager.errorCount} accounts failed out of ${accounts.length}`,
      });

      // Send final notification
      if (user?.telegramId && schedule) {
        const statusIcon = wasStopped ? "⏹️" : isSuccess ? "✅" : "⚠️";
        const statusText = wasStopped
          ? "Stopped by User"
          : isSuccess
          ? "Completed Successfully"
          : "Completed with Errors";

        await bot.sendMessage(
          user.telegramId,
          `${statusIcon} **Schedule ${statusText}**\n` +
            `📝 Schedule: ${schedule.name}\n` +
            `👥 Total accounts: ${accounts.length}\n` +
            `✅ Successful: ${scheduleManager.successCount}\n` +
            `❌ Errors: ${scheduleManager.errorCount}\n` +
            `⏰ Completed at: ${new Date().toLocaleString()}\n\n` +
            (wasStopped
              ? `⏹️ Schedule was stopped by user request.`
              : isSuccess
              ? `🎉 All accounts processed successfully!`
              : `⚠️ Some accounts encountered errors. Check individual account notifications for details.`),
          { parse_mode: "Markdown" }
        );
      }
    }
  } catch (error) {
    console.error("❌ Automation error:", error);
    const errorMessage = (error as any).message || (error as string).toString();

    // Update schedule status if applicable
    if (scheduleId) {
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: "failed",
        lastError: `System error: ${errorMessage}`,
        lastRun: new Date(),
      });
    }

    // Send error notification
    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `❌ **Schedule Failed**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `🚨 System Error: ${errorMessage}\n` +
          `⏰ Failed at: ${new Date().toLocaleString()}\n\n` +
          `💡 This appears to be a system error. Please try again or contact support.`,
        { parse_mode: "Markdown" }
      );
    }

    throw error;
  } finally {
    // Cleanup: close any remaining browsers
    if (scheduleManager) {
      scheduleManager.isRunning = false;

      if (scheduleManager.browsers.length > 0) {
        console.log(
          `🧹 Cleaning up ${scheduleManager.browsers.length} remaining browsers...`
        );

        const closePromises = scheduleManager.browsers.map((browserInstance) =>
          closeBrowserInstance(browserInstance)
        );

        await Promise.allSettled(closePromises);
        scheduleManager.browsers = [];
      }

      // Remove from active schedules
      if (scheduleId) {
        activeSchedules.delete(scheduleId);
      }
    }
  }
};

// Enhanced function to stop a running schedule
export const stopSchedule = async (scheduleId: string): Promise<boolean> => {
  const scheduleManager = activeSchedules.get(scheduleId);

  if (scheduleManager) {
    try {
      console.log(`🛑 Stopping schedule ${scheduleId}...`);

      // Get schedule info for notification
      const schedule = await Schedule.findById(scheduleId).populate(
        "createdBy"
      );

      // Mark for stopping
      scheduleManager.shouldStop = true;

      // Close all active browsers
      if (scheduleManager.browsers.length > 0) {
        console.log(
          `🧹 Closing ${scheduleManager.browsers.length} active browsers...`
        );

        const closePromises = scheduleManager.browsers.map((browserInstance) =>
          closeBrowserInstance(browserInstance)
        );

        await Promise.allSettled(closePromises);
        scheduleManager.browsers = [];
      }

      // Update schedule status
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: "stopped",
        lastError: "Schedule stopped by user request",
        lastRun: new Date(),
      });

      // Notify user
      if (schedule?.createdBy) {
        const user = schedule.createdBy as any;
        if (user.telegramId) {
          await bot.sendMessage(
            user.telegramId,
            `🛑 **Schedule Stopped**\n` +
              `📝 Schedule: ${schedule.name}\n` +
              `⚠️ Booking process was stopped by request\n` +
              `⏰ Stopped at: ${new Date().toLocaleString()}`,
            { parse_mode: "Markdown" }
          );
        }
      }

      // Remove from active schedules
      activeSchedules.delete(scheduleId);

      console.log(`✅ Successfully stopped schedule ${scheduleId}`);
      return true;
    } catch (error) {
      console.error(`❌ Error stopping schedule ${scheduleId}:`, error);
      return false;
    }
  } else {
    console.log(`⚠️ No active schedule found for ${scheduleId}`);
    return false;
  }
};

// Get status of all active schedules
export const getScheduleStatus = (): {
  activeSchedules: string[];
  totalActive: number;
  scheduleDetails: Array<{
    scheduleId: string;
    activeBrowsers: number;
    processedCount: number;
    successCount: number;
    errorCount: number;
    isRunning: boolean;
  }>;
} => {
  const scheduleDetails = Array.from(activeSchedules.entries()).map(
    ([scheduleId, manager]) => ({
      scheduleId,
      activeBrowsers: manager.browsers.length,
      processedCount: manager.processedCount,
      successCount: manager.successCount,
      errorCount: manager.errorCount,
      isRunning: manager.isRunning,
    })
  );

  return {
    activeSchedules: Array.from(activeSchedules.keys()),
    totalActive: activeSchedules.size,
    scheduleDetails,
  };
};

// Emergency stop all schedules
export const stopAllSchedules = async (): Promise<void> => {
  console.log(
    `🛑 Emergency stop: Stopping ${activeSchedules.size} active schedules...`
  );

  const stopPromises = Array.from(activeSchedules.keys()).map((scheduleId) =>
    stopSchedule(scheduleId)
  );

  await Promise.allSettled(stopPromises);

  console.log("✅ All schedules stopped");
};

// Get browsers for a specific schedule (useful for monitoring)
export const getScheduleBrowsers = (scheduleId: string): BrowserInstance[] => {
  const scheduleManager = activeSchedules.get(scheduleId);
  return scheduleManager ? scheduleManager.browsers : [];
};

// Force close a specific browser instance
export const closeBrowser = async (
  scheduleId: string,
  accountEmail: string
): Promise<boolean> => {
  const scheduleManager = activeSchedules.get(scheduleId);

  if (scheduleManager) {
    const browserInstance = scheduleManager.browsers.find(
      (b) => b.accountEmail === accountEmail
    );

    if (browserInstance) {
      await closeBrowserInstance(browserInstance);

      // Remove from browsers array
      const index = scheduleManager.browsers.indexOf(browserInstance);
      if (index > -1) {
        scheduleManager.browsers.splice(index, 1);
      }

      return true;
    }
  }

  return false;
};
