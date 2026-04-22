import startBooking from "../booking/book";
import { bot } from "..";
import Account, { AccountDocument } from "../models/accountSchema";
import Schedule from "../models/scheduleSchema";
import { UserDocument } from "../models/userSchema";
import dotenv from "dotenv";
import { browserPool, PrewarmedBrowser } from "../browser/prewarmed-browser-pool";

dotenv.config();

interface DisplayInfo {
  display: string;
  displayNumber: string;
  noVncUrl: string;
  vncPort: number;
}

const getDisplayInfo = (browser: PrewarmedBrowser): DisplayInfo => {
  const displayNum = parseInt(browser.display.replace(":", ""));
  return {
    display: browser.display,
    displayNumber: browser.display.replace(":", ""),
    noVncUrl: `http://${process.env.SERVER_IP || "localhost"}:${6080 + displayNum}/vnc.html`,
    vncPort: 5900 + displayNum,
  };
};

const getAccountsForUser = async (userId: string): Promise<AccountDocument[]> => {
  const accounts = await Account.find({ user: userId, status: true }).populate("user");
  console.log(`[cluster] Found ${accounts.length} active accounts for user ${userId}`);
  return accounts;
};

export const runAllAccountsWithPrewarmedBrowsers = async (
  oid: string,
  scheduleId?: string
) => {
  const startTime = Date.now();
  console.log(`[cluster] Starting redirect - OID: ${oid}`);

  // Get user
  let user: UserDocument | null = null;
  if (scheduleId) {
    try {
      const schedule = await Schedule.findById(scheduleId).populate("createdBy");
      user = schedule?.createdBy as unknown as UserDocument;
    } catch (err) {
      console.error("[cluster] Failed to get user:", err);
    }
  }

  const sendLog = (message: string) => {
    if (user?.telegramId) {
      setImmediate(() => {
        bot.sendMessage(user!.telegramId, message).catch(() => { });
      });
    }
  };

  // Get browsers
  const prewarmedBrowsers = browserPool.getAllReadyBrowsers();
  if (prewarmedBrowsers.length === 0) {
    console.error("[cluster] No prewarmed browsers available");
    sendLog(`[cluster] No prewarmed browsers found. Cannot proceed.`);
    return;
  }

  console.log(`[cluster] ${prewarmedBrowsers.length} browsers ready`);

  // Get accounts
  let accounts: AccountDocument[] = [];
  if (user?._id) {
    try {
      accounts = await getAccountsForUser(user._id.toString());
    } catch (err) {
      console.error("[cluster] Failed to fetch accounts:", err);
      sendLog(`[cluster] Failed to fetch accounts: ${(err as Error).message} — all browsers will run manually`);
    }
  }

  if (accounts.length === 0) {
    console.warn("[cluster] No active accounts — all browsers will run manual flow");
    sendLog(`[cluster] No active accounts found — all ${prewarmedBrowsers.length} browsers running manual flow`);
  } else if (accounts.length < prewarmedBrowsers.length) {
    console.warn(`[cluster] ${accounts.length} accounts for ${prewarmedBrowsers.length} browsers — ${prewarmedBrowsers.length - accounts.length} browsers will run manual flow`);
    sendLog(`[cluster] ${accounts.length} accounts assigned, ${prewarmedBrowsers.length - accounts.length} browsers running manual flow`);
  }

  // Navigate all browsers in parallel then start booking
  console.log(`[cluster] Redirecting ${prewarmedBrowsers.length} browsers in parallel...`);

  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;

  const bookingPromises = prewarmedBrowsers.map((browser, index) => {
    // Assign account by index — browsers beyond account count get undefined
    const account: AccountDocument | undefined = accounts[index];
    const displayInfo = getDisplayInfo(browser);
    const chatId = user?.telegramId || null;

    console.log(
      account
        ? `[cluster] Browser ${browser.browserNumber} -> ${account.email}`
        : `[cluster] Browser ${browser.browserNumber} -> manual (no account)`
    );

    return (async () => {
      // Navigate first
      try {
        await browser.page.goto(bookingUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        console.log(`[cluster] Browser ${browser.browserNumber} reached booking page`);
      } catch (err) {
        console.error(`[cluster] Browser ${browser.browserNumber} initial navigation failed:`, (err as Error).message);
        // Don't return — pass to startBooking anyway, it handles retries
      }

      // Start booking — automated if account present, manual otherwise
      try {
        await startBooking(
          browser.page,
          oid,
          bot,
          displayInfo,
          chatId,
          account, // undefined for browsers without accounts → falls to manual flow
        );
      } catch (err) {
        // Should never reach here since startBooking catches everything internally
        // but just in case — keep browser alive
        console.error(`[cluster] Browser ${browser.browserNumber} unhandled error:`, (err as Error).message);
        sendLog(
          `[Browser ${browser.browserNumber}] Unhandled error: ${(err as Error).message}\nAccess manually: ${displayInfo.noVncUrl}`
        );
      }
    })();
  });

  // Wait for all — Promise.allSettled ensures no browser cancels another
  const results = await Promise.allSettled(bookingPromises);

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const totalTime = Date.now() - startTime;

  console.log(`[cluster] All browsers completed — ${succeeded}/${prewarmedBrowsers.length} | ${totalTime}ms`);
  sendLog(`[cluster] All browsers completed\nSuccess: ${succeeded}/${prewarmedBrowsers.length}\nTime: ${totalTime}ms`);

  // Update schedule
  if (scheduleId) {
    setImmediate(async () => {
      try {
        await Schedule.findByIdAndUpdate(scheduleId, {
          completed: true,
          status: succeeded > 0 ? "success" : "failed",
          lastRun: new Date(),
          lastError: succeeded === 0 ? "All browsers failed" : null,
        });
      } catch (err) {
        console.error("[cluster] Failed to update schedule:", err);
      }
    });
  }
};