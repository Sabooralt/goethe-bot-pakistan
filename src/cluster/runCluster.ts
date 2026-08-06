import startBooking from "../booking/book";
import { bot } from "..";
import Schedule from "../models/scheduleSchema";
import { UserDocument } from "../models/userSchema";
import dotenv from "dotenv";
import { browserPool, PrewarmedBrowser } from "../browser/prewarmed-browser-pool";
import { accountPool } from "../accounts/account-pool";

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

  // Navigate all browsers in parallel then start booking — account
  // assignment now happens inside startBooking, at the moment each
  // browser individually catches the slot.
  console.log(`[cluster] Redirecting ${prewarmedBrowsers.length} browsers in parallel...`);

  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;

  const bookingPromises = prewarmedBrowsers.map((browser) => {
    const displayInfo = getDisplayInfo(browser);
    const chatId = user?.telegramId || null;

    return (async () => {
      // Navigate first
      try {
        await browser.page.goto(bookingUrl, {
          waitUntil: "networkidle",
          timeout: 60000,
        });
        console.log(`[cluster] Browser ${browser.browserNumber} reached booking page`);
      } catch (err) {
        console.error(`[cluster] Browser ${browser.browserNumber} initial navigation failed:`, (err as Error).message);
        // Don't return — pass to startBooking anyway, it handles retries
      }

      // startBooking now claims an account dynamically once it confirms
      // the slot is actually caught for this specific browser.
      try {
        await startBooking(
          browser.page,
          oid,
          bot,
          displayInfo,
          chatId,
        );
      } catch (err) {
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