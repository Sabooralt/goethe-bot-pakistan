import { Cluster } from "puppeteer-cluster";
import Account from "../models/accountSchema";
import startBooking from "../booking/book";
import { bot } from "..";
import Schedule, { ISchedule } from "../models/scheduleSchema";
import  { UserDocument } from "../models/userSchema";

const activeClusters: Map<string, Cluster> = new Map();

export const runAllAccounts = async (oid: string, scheduleId?: string) => {
  let schedule: ISchedule | null = null;
  let user: UserDocument | null = null;

  try {
    console.log("🚀 Starting scraping cluster...");

    // Get schedule and user info for logging
    if (scheduleId) {
      schedule = await Schedule.findById(scheduleId).populate("createdBy");
      if (schedule?.createdBy) {
        user = schedule.createdBy as any;
      }
    }

    // Send initial log to user
    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `🚀 **Automation Started**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `🆔 OID: ${oid}\n` +
          `⚡ Initializing browser cluster...`,
        { parse_mode: "Markdown" }
      );
    }

    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_CONTEXT,
      maxConcurrency: 2,
      puppeteerOptions: {
        headless: false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
        ],
      },
      timeout: 1800000, // 15 minutes per task
    });

    // Store cluster reference if associated with a schedule
    if (scheduleId) {
      activeClusters.set(scheduleId, cluster);
    }

    console.log("✅ Cluster initialized!");

    // Enhanced error handling for tasks
    cluster.on("taskerror", async (err, data) => {
      console.error(`❌ Error scraping ${data.account.email}: ${err.message}`);

      // Send detailed error notification to account owner
      if (data.account.user?.telegramId) {
        await bot.sendMessage(
          data.account.user.telegramId,
          `❌ **Account Error**\n` +
            `📧 Account: ${data.account.email}\n` +
            `🚨 Error: ${err.message}\n` +
            `⏰ Time: ${new Date().toLocaleString()}`,
          { parse_mode: "Markdown" }
        );
      }

      // Also send to schedule owner if different
      if (
        user?.telegramId &&
        user.telegramId !== data.account.user?.telegramId &&
        schedule
      ) {
        await bot.sendMessage(
          user.telegramId,
          `⚠️ **Account Error in Schedule**\n` +
            `📝 Schedule: ${schedule.name}\n` +
            `📧 Account: ${data.account.email}\n` +
            `❌ Error: ${err.message}`,
          { parse_mode: "Markdown" }
        );
      }
    });

    // Get all active accounts
    const accounts = await Account.find({ status: true }).populate("user");

    if (!accounts || accounts.length === 0) {
      console.log("ℹ️ No active accounts found. Exiting Cluster...");

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

      await cluster.close();
      return;
    }

    // Send progress update to user
    if (user?.telegramId && schedule) {
      await bot.sendMessage(
        user.telegramId,
        `🔄 **Processing Accounts**\n` +
          `📝 Schedule: ${schedule.name}\n` +
          `👥 Found ${accounts.length} active accounts\n` +
          `⚡ Starting booking process...`,
      );
    }

    console.log(`📊 Processing ${accounts.length} accounts...`);

    let processedCount = 0;
    let successCount = 0;
    let errorCount = 0;

    // Add all accounts to the cluster queue with enhanced tracking
    for (const account of accounts) {
      cluster.queue({ account }, async ({ page, data }) => {
        try {
          console.log(`🔄 Processing account: ${data.account.email}`);
          await startBooking(page, data.account, oid, bot);

          processedCount++;
          successCount++;

          console.log(
            `✅ Account ${data.account.email} processed successfully`
          );

          // Send periodic updates (every 2 accounts or on completion)
          if (processedCount % 2 === 0 || processedCount === accounts.length) {
            if (user?.telegramId && schedule) {
              await bot.sendMessage(
                user.telegramId,
                `📊 **Progress Update**\n` +
                  `📝 Schedule: ${schedule.name}\n` +
                  `✅ Processed: ${processedCount}/${accounts.length}\n` +
                  `🎯 Successful: ${successCount}\n` +
                  `❌ Errors: ${errorCount}`
              );
            }
          }
        } catch (accountError) {
          processedCount++;
          errorCount++;
          console.error(
            `❌ Account ${data.account.email} failed:`,
            accountError
          );

          // This error will be caught by the taskerror handler above
          throw accountError;
        }
      });
    }

    // Wait for all tasks to complete
    await cluster.idle();
    await cluster.close();

    console.log("✅ All accounts processed successfully!");
    console.log(
      `📊 Final stats: ${successCount} successful, ${errorCount} errors out of ${accounts.length} total`
    );

    // Update schedule status if applicable
    if (scheduleId) {
      const isSuccess = errorCount === 0;
      await Schedule.findByIdAndUpdate(scheduleId, {
        completed: true,
        status: isSuccess ? "success" : "partial_success",
        lastRun: new Date(),
        lastError: isSuccess
          ? null
          : `${errorCount} accounts failed out of ${accounts.length}`,
      });

      // Send final notification
      if (user?.telegramId && schedule) {
        const statusIcon = isSuccess ? "✅" : "⚠️";
        const statusText = isSuccess
          ? "Completed Successfully"
          : "Completed with Errors";

        await bot.sendMessage(
          user.telegramId,
          `${statusIcon} **Schedule ${statusText}**\n` +
            `📝 Schedule: ${schedule.name}\n` +
            `👥 Total accounts: ${accounts.length}\n` +
            `✅ Successful: ${successCount}\n` +
            `❌ Errors: ${errorCount}\n` +
            `⏰ Completed at: ${new Date().toLocaleString()}\n\n` +
            (isSuccess
              ? `🎉 All accounts processed successfully!`
              : `⚠️ Some accounts encountered errors. Check individual account notifications for details.`),
          { parse_mode: "Markdown" }
        );
      }

      // Remove cluster reference
      activeClusters.delete(scheduleId);
    }
  } catch (error) {
    console.error("❌ Cluster error:", error);
    const errorMessage = (error as any).message || (error as string).toString();

    // Update schedule status if applicable
    if (scheduleId) {
      await Schedule.findByIdAndUpdate(scheduleId, {
        status: "failed",
        lastError: `Cluster error: ${errorMessage}`,
        lastRun: new Date(),
      });

      // Remove cluster reference
      if (activeClusters.has(scheduleId)) {
        try {
          const cluster = activeClusters.get(scheduleId);
          await cluster?.close();
        } catch (closeError) {
          console.error("Error closing cluster:", closeError);
        }
        activeClusters.delete(scheduleId);
      }
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

    throw error; // Re-throw so scheduler can handle it
  }
};

// Enhanced function to stop a running schedule
export const stopSchedule = async (scheduleId: string): Promise<boolean> => {
  const cluster = activeClusters.get(scheduleId);
  if (cluster) {
    try {
      console.log(`🛑 Stopping cluster for schedule ${scheduleId}...`);

      // Get schedule info for notification
      const schedule = await Schedule.findById(scheduleId).populate(
        "createdBy"
      );

      await cluster.close();
      activeClusters.delete(scheduleId);

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

      console.log(`✅ Successfully stopped cluster for schedule ${scheduleId}`);
      return true;
    } catch (error) {
      console.error(
        `❌ Error stopping cluster for schedule ${scheduleId}:`,
        error
      );
      return false;
    }
  } else {
    console.log(`⚠️ No active cluster found for schedule ${scheduleId}`);
    return false;
  }
};

// Get status of all active clusters
export const getClusterStatus = (): {
  activeSchedules: string[];
  totalActive: number;
} => {
  return {
    activeSchedules: Array.from(activeClusters.keys()),
    totalActive: activeClusters.size,
  };
};

// Emergency stop all clusters
export const stopAllClusters = async (): Promise<void> => {
  console.log(
    `🛑 Emergency stop: Closing ${activeClusters.size} active clusters...`
  );

  const stopPromises = Array.from(activeClusters.keys()).map((scheduleId) =>
    stopSchedule(scheduleId)
  );

  await Promise.allSettled(stopPromises);

  console.log("✅ All clusters stopped");
};
