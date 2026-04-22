import { bot } from "..";
import Account, { AccountDocument } from "../models/accountSchema";
import { browserPool, PrewarmedBrowser } from "../browser/prewarmed-browser-pool";
import Schedule from "../models/scheduleSchema";
import { UserDocument } from "../models/userSchema";
import startBooking from "../booking/book";

interface BrowserAccountAssignment {
  browserNumber: number;
  account: AccountDocument;
  browser: PrewarmedBrowser;
}

const getAccountsForSchedule = async (scheduleId: string): Promise<AccountDocument[]> => {
  const schedule = await Schedule.findById(scheduleId).populate("createdBy");
  if (!schedule) throw new Error(`Schedule ${scheduleId} not found`);

  const user = schedule.createdBy as unknown as UserDocument;
  const userId = user._id.toString();

  const accounts = await Account.find({
    user: userId,
    status: true,
  }).populate("user");

  console.log(`[cluster] Found ${accounts.length} active accounts for user ${userId}`);
  return accounts;
};

const assignAccountsToBrowsers = (
  browsers: PrewarmedBrowser[],
  accounts: AccountDocument[]
): BrowserAccountAssignment[] => {
  const assignments: BrowserAccountAssignment[] = [];

  // Each browser gets one unique account — stop at whichever runs out first
  const count = Math.min(browsers.length, accounts.length);

  if (accounts.length < browsers.length) {
    console.warn(
      `[cluster] Only ${accounts.length} accounts for ${browsers.length} browsers — ${browsers.length - accounts.length} browsers will be unused`
    );
  }

  for (let i = 0; i < count; i++) {
    assignments.push({
      browserNumber: browsers[i].browserNumber,
      account: accounts[i],
      browser: browsers[i],
    });
    console.log(
      `[cluster] Browser ${browsers[i].browserNumber} -> ${accounts[i].email}`
    );
  }

  return assignments;
};

export const runAllAccountsWithPrewarmedBrowsers = async (
  oid: string,
  scheduleId: string
): Promise<void> => {
  console.log(`[cluster] Starting booking for OID: ${oid}`);

  const schedule = await Schedule.findById(scheduleId).populate("createdBy");
  if (!schedule) throw new Error(`Schedule ${scheduleId} not found`);

  const user = schedule.createdBy as unknown as UserDocument;

  // Step 1: Get accounts
  let accounts: AccountDocument[];
  try {
    accounts = await getAccountsForSchedule(scheduleId);
  } catch (error) {
    console.error("[cluster] Failed to fetch accounts:", error);
    if (user.telegramId) {
      await bot.sendMessage(
        user.telegramId,
        `[cluster] Failed to fetch accounts: ${(error as Error).message}`
      );
    }
    return;
  }

  if (accounts.length === 0) {
    console.error("[cluster] No active accounts found");
    if (user.telegramId) {
      await bot.sendMessage(
        user.telegramId,
        `[cluster] No active accounts found. Cannot proceed with booking.`
      );
    }
    return;
  }

  // Step 2: Get ready browsers
  const readyBrowsers = browserPool.getAllReadyBrowsers();
  if (readyBrowsers.length === 0) {
    console.error("[cluster] No prewarmed browsers available");
    if (user.telegramId) {
      await bot.sendMessage(
        user.telegramId,
        `[cluster] No prewarmed browsers available. Cannot proceed.`
      );
    }
    return;
  }

  console.log(`[cluster] ${readyBrowsers.length} browsers, ${accounts.length} accounts`);

  // Step 3: Assign — one account per browser, no duplicates
  const assignments = assignAccountsToBrowsers(readyBrowsers, accounts);

  if (user.telegramId) {
    await bot.sendMessage(
      user.telegramId,
      `[cluster] Launching ${assignments.length} browsers\nOID: ${oid}`
    );
  }

  // Step 4: Launch all in parallel — never close browsers on failure
  const bookingPromises = assignments.map(({ browserNumber, account, browser }) => {
    const displayInfo = {
      display: browser.display,
      displayNumber: browser.display.replace(":", ""),
      noVncUrl: `http://localhost:${6080 + parseInt(browser.display.replace(":", ""))}`,
      vncPort: 5900 + parseInt(browser.display.replace(":", "")),
    };

    return startBooking(
      browser.page,
      oid,
      bot,
      displayInfo,
      user.telegramId,
      account,
    ).catch((error) => {
      // Catch at cluster level too — browser must never close
      console.error(
        `[cluster] Browser ${browserNumber} (${account.email}) unhandled error:`,
        (error as Error).message
      );
      if (user.telegramId) {
        bot.sendMessage(
          user.telegramId,
          `[Browser ${browserNumber}] [${account.email}] Unhandled error: ${(error as Error).message}\nAccess manually at: ${displayInfo.noVncUrl}`
        );
      }
    });
  });

  // Wait for all — browsers stay open regardless
  await Promise.allSettled(bookingPromises);

  console.log(`[cluster] All booking attempts completed for OID: ${oid}`);
};