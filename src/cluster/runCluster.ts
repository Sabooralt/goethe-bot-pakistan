import startBooking from "../booking/book";
import { bot } from "..";
import Schedule from "../models/scheduleSchema";
import { UserDocument } from "../models/userSchema";
import dotenv from "dotenv";
import { browserPool, PrewarmedBrowser } from "../browser/prewarmed-browser-pool";
import { accountPool } from "../accounts/account-pool";
import { timeNow } from "../utils/timeLog";

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

  // Initialize the shared account pool ONCE — browsers claim from it
  // dynamically as each one individually catches the slot, rather than
  // being preassigned an account by array index before anything happens.
  if (user?._id) {
    try {
      await accountPool.initialize(user._id.toString());
      const accountCount = accountPool.remaining();
      console.log(`[cluster] Account pool ready: ${accountCount} account(s) for ${prewarmedBrowsers.length} browsers`);

      if (accountCount === 0) {
        sendLog(`[cluster] No active accounts found — all ${prewarmedBrowsers.length} browsers will run manually if they catch the slot`);
      } else if (accountCount < prewarmedBrowsers.length) {
        sendLog(`[cluster] ${accountCount} account(s) available for ${prewarmedBrowsers.length} browsers — accounts claimed first-come as browsers catch the slot; remaining browsers fall back to manual`);
      } else {
        sendLog(`[cluster] ${accountCount} account(s) available — enough for all ${prewarmedBrowsers.length} browsers`);
      }
    } catch (err) {
      console.error("[cluster] Failed to initialize account pool:", err);
      sendLog(`[cluster] Failed to load accounts: ${(err as Error).message} — all browsers will run manually if they catch the slot`);
    }
  } else {
    console.warn("[cluster] No user resolved — account pool will be empty, all browsers run manually");
  }

  timeNow("Initialized accounts");
  console.log(`[cluster] Redirecting ${prewarmedBrowsers.length} browsers in parallel...`);

  const bookingUrl = `https://www.goethe.de/coe/entry?lang=en&oid=${oid}`;

  console.log(
    `[cluster] Redirecting ${prewarmedBrowsers.length} browsers in parallel...`
  );

  const redirectStart = performance.now();

  const redirectResults = await Promise.all(
    prewarmedBrowsers.map(async (browser) => {
      try {
        await browser.page.goto(bookingUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        console.log(
          `[cluster] Browser ${browser.browserNumber} reached booking page`
        );

        return {
          browser,
          success: true,
        };
      } catch (err) {
        console.error(
          `[cluster] Browser ${browser.browserNumber} navigation failed:`,
          (err as Error).message
        );

        return {
          browser,
          success: false,
        };
      }
    })
  );

  const redirectTime = performance.now() - redirectStart;

  const successfulRedirects = redirectResults.filter(
    (result) => result.success
  ).length;

  console.log(
    `[cluster] All redirects finished: ${successfulRedirects}/${prewarmedBrowsers.length}`
  );

  timeNow("All redirects finished")

  console.log(
    `[cluster] Total redirect time: ${redirectTime.toFixed(2)}ms`
  );

  console.log(
    `[cluster] Total redirect time: ${(redirectTime / 1000).toFixed(3)}s`
  );

  // ============================================================
  // PHASE 2 — ONLY NOW START BOOKING
  // ============================================================

  console.log(
    `[cluster] Starting booking for ${successfulRedirects} browsers...`
  );

  const bookingPromises = redirectResults
    .filter((result) => result.success)
    .map(({ browser }) => {
      const displayInfo = getDisplayInfo(browser);
      const chatId = user?.telegramId || null;

      return startBooking(
        browser.browser,
        browser.context,
        browser.page,
        oid,
        bot,
        displayInfo,
        chatId,
      );
    });


  const results = await Promise.allSettled(bookingPromises);

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const totalTime = Date.now() - startTime;

  console.log(`[cluster] All browsers completed — ${succeeded}/${prewarmedBrowsers.length} | ${totalTime}ms`);
  sendLog(
    `[cluster] All browsers completed\nSuccess: ${succeeded}/${prewarmedBrowsers.length}\nAccounts claimed: ${accountPool.totalClaimed()}\nTime: ${totalTime}ms`
  );

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