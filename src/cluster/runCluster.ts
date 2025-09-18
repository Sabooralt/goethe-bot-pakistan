import { Cluster } from "puppeteer-cluster";
import Account from "../models/accountSchema";
import startBooking from "../booking/book";
import { bot } from "..";
import Schedule from "../models/scheduleSchema";
import User from "../models/userSchema";

const activeClusters: Map<string, Cluster> = new Map();

export const runAllAccounts = async (scheduleId?: string) => {
  try {
    console.log("🚀 Starting scraping cluster...");

    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_PAGE,
      maxConcurrency: 5,
      puppeteerOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      },
      timeout: 600000, // 10 minutes per task
    });

    // Store cluster reference if associated with a schedule
    if (scheduleId) {
      activeClusters.set(scheduleId, cluster);
    }

    console.log("✅ Cluster initialized!");

    cluster.on("taskerror", (err, data) => {
      console.error(`❌ Error scraping ${data.account.email}: ${err.message}`);
      
      // Send error notification to user
      if (data.account.user?.telegramId) {
        bot.sendMessage(
          data.account.user.telegramId,
          `❌ Error for account ${data.account.email}:\n${err.message}`
        );
      }
    });

    const accounts = await Account.find({ status: true }).populate("user");

    if (!accounts || accounts.length === 0) {
      console.log("ℹ️ No active accounts found. Exiting Cluster...");
      
      // Update schedule status if applicable
      if (scheduleId) {
        await Schedule.findByIdAndUpdate(scheduleId, {
          completed: true,
          lastRun: new Date(),
          lastError: "No active accounts"
        });
      }
      
      await cluster.close();
      return;
    }

    // Add all accounts to the cluster queue
    for (const account of accounts) {
      cluster.queue({ account }, async ({ page, data }) => {
        await startBooking(page, data.account, bot);
      });
    }

    await cluster.idle();
    await cluster.close();

    console.log("✅ All accounts processed successfully!");
    
    // Update schedule status if applicable
    if (scheduleId) {
      await Schedule.findByIdAndUpdate(scheduleId, {
        completed: true,
        lastRun: new Date()
      });
      
      // Send success notification
      const schedule = await Schedule.findById(scheduleId);
      if (schedule?.createdBy) {
        const user = await User.findById(schedule.createdBy);
        if (user?.telegramId) {
          bot.sendMessage(
            user.telegramId,
            `✅ Schedule completed: ${schedule.name}\n` +
            `Ran ${accounts.length} accounts successfully!`
          );
        }
      }
      
      // Remove cluster reference
      activeClusters.delete(scheduleId);
    }
  } catch (error) {
    console.error("❌ Cluster error:", error);
    
    // Update schedule status if applicable
    if (scheduleId) {
      await Schedule.findByIdAndUpdate(scheduleId, {
        lastError: error,
        lastRun: new Date()
      });
    }
    
    // Send error notification
    if (scheduleId) {
      const schedule = await Schedule.findById(scheduleId);
      if (schedule?.createdBy) {
        const user = await User.findById(schedule.createdBy);
        if (user?.telegramId) {
          bot.sendMessage(
            user.telegramId,
            `❌ Schedule failed: ${schedule.name}\n` +
            `Error: ${error}`
          );
        }
      }
    }
  }
};

// Function to stop a running schedule
export const stopSchedule = async (scheduleId: string) => {
  const cluster = activeClusters.get(scheduleId);
  if (cluster) {
    try {
      await cluster.close();
      activeClusters.delete(scheduleId);
      console.log(`🛑 Stopped cluster for schedule ${scheduleId}`);
      return true;
    } catch (error) {
      console.error("Error stopping cluster:", error);
      return false;
    }
  }
  return false;
};