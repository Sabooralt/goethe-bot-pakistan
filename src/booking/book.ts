import { Page } from "playwright-core";
import dotenv from "dotenv";
import type TelegramBot from "node-telegram-bot-api";
import { AccountDocument } from "../models/accountSchema";
import { UserDocument } from "../models/userSchema";
import { getModuleStatus, ModuleKey } from "../fillers/getModuleStatus";
import { accountPool } from "../accounts/account-pool"; // adjust path to wherever you place account-pool.ts

dotenv.config();

const EXAM = process.env.EXAM || "A1";

interface DisplayInfo {
  display: string;
  displayNumber: string;
  noVncUrl: string;
  vncPort: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sendLog = (
  bot: TelegramBot,
  chatId: string | null,
  identifier: string,
  message: string
) => {
  if (!chatId) return;
  const fullMessage = `[${identifier}] ${message}`;
  console.log(fullMessage);
  setImmediate(() => {
    try {
      bot.sendMessage(chatId, fullMessage, { parse_mode: "Markdown" });
    } catch (error) {
      console.error("Failed to send Telegram message:", error);
    }
  });
};

const getBackoffDelay = (
  attempt: number,
  baseDelay = 5000,
  maxDelay = 300000
): number => {
  const exponentialDelay = baseDelay * Math.pow(2, Math.min(attempt - 1, 6));
  return Math.min(exponentialDelay, maxDelay);
};

const isRateLimited = async (page: Page): Promise<boolean> => {
  try {
    const title = (await page.title()).toLowerCase();
    const url = page.url().toLowerCase();
    return (
      !title.includes("options") &&
      title.includes("429") ||
      title.includes("too many requests") ||
      title.includes("rate limit") ||
      title.includes("forbidden") ||
      title.includes("access denied") ||
      url.includes("error") ||
      url.includes("blocked")
    );
  } catch {
    return false;
  }
};

const isBookingPageLoaded = async (page: Page): Promise<boolean> => {
  try {
    const pageTitle = await page.title();
    return pageTitle.toLowerCase().includes("option");
  } catch {
    return false;
  }
};

const navigateWithTimeout = async (
  page: Page,
  url: string,
  identifier: string,
  maxAttempts = 3
): Promise<{ success: boolean; rateLimited: boolean }> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[${identifier}] 🔄 Navigation attempt ${attempt}/${maxAttempts}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });

      if (await isRateLimited(page)) {
        console.log(`[${identifier}] 🚫 Rate limited detected`);
        return { success: false, rateLimited: true };
      }

      console.log(`[${identifier}] ✅ Page loaded within timeout`);
      return { success: true, rateLimited: false };
    } catch (error) {
      const err = error as Error;
      if (err.message.includes("timeout") || err.message.includes("Navigation timeout")) {
        console.log(`[${identifier}] ⏰ Timeout on attempt ${attempt}/${maxAttempts}`);
        if (attempt < maxAttempts) {
          await delay(500);
          continue;
        }
        console.log(`[${identifier}] ⚠️ All ${maxAttempts} attempts timed out — continuing anyway`);
        return { success: false, rateLimited: false };
      }
      console.error(`[${identifier}] ❌ Navigation error: ${err.message}`);
      return { success: false, rateLimited: false };
    }
  }
  return { success: false, rateLimited: false };
};

/**
 * Navigates to the booking URL and retries (with rate-limit backoff) until
 * the options page loads, or timeoutMs elapses. Returns true the moment
 * this browser has "caught the slot" — this is identical for every
 * browser regardless of whether it'll end up with an account or not,
 * since that decision now happens AFTER this resolves.
 */
const navigateUntilLoaded = async (
  page: Page,
  identifier: string,
  bookingUrl: string,
  bot: TelegramBot,
  chatId: string | null,
  timeoutMs: number
): Promise<boolean> => {
  const startTime = Date.now();
  let consecutiveRateLimits = 0;
  let totalRateLimits = 0;

  console.log(`[${identifier}] 🔍 Title: "${await page.title()}" | URL: ${page.url()}`);

  const alreadyLoaded = await isBookingPageLoaded(page);
  const alreadyRateLimited = await isRateLimited(page);

  if (alreadyRateLimited) {
    consecutiveRateLimits++;
    totalRateLimits++;
    sendLog(bot, chatId, identifier, `🚫 Rate limited on initial load — starting retry loop with exponential backoff`);
  } else if (alreadyLoaded) {
    console.log(`[${identifier}] ✅ Options page already loaded on first check`);
    return true;
  } else {
    const title = await page.title();
    console.log(`[${identifier}] ⚠️ Page not loaded correctly. Title: "${title}"`);
    sendLog(bot, chatId, identifier, `⚠️ Page not loaded (title: ${title}) — starting retry loop`);
  }

  let attempts = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      sendLog(bot, chatId, identifier, `⏰ Retry timeout reached (5h)\nTotal rate limits: ${totalRateLimits} — stopping retries`);
      return false;
    }

    attempts++;

    const retryDelay = consecutiveRateLimits > 0
      ? getBackoffDelay(consecutiveRateLimits, 10000, 300000)
      : Math.floor(Math.random() * 1200) + 200; // jitter instead of flat delay when not rate-limited

    if (consecutiveRateLimits > 0) {
      console.log(`[${identifier}] 🕐 Rate limited ${consecutiveRateLimits}x — backing off ${Math.round(retryDelay / 1000)}s`);
    }

    await delay(retryDelay);

    try {
      const navResult = await navigateWithTimeout(page, bookingUrl, identifier);

      if (navResult.rateLimited) {
        consecutiveRateLimits++;
        totalRateLimits++;
        if (consecutiveRateLimits === 1 || consecutiveRateLimits % 3 === 0) {
          const backoff = getBackoffDelay(consecutiveRateLimits, 10000, 300000);
          sendLog(bot, chatId, identifier, `🚫 *Rate Limited (429)*\nConsecutive: ${consecutiveRateLimits} | Total: ${totalRateLimits}\nNext retry in: ${Math.round(backoff / 1000)}s`);
        }
        continue;
      }

      if (consecutiveRateLimits > 0) {
        console.log(`[${identifier}] ✅ Rate limit cleared — resetting backoff`);
        consecutiveRateLimits = 0;
      }

      if (!await isBookingPageLoaded(page)) {
        if (attempts % 20 === 0) {
          sendLog(bot, chatId, identifier, `⚠️ Still retrying — attempt ${attempts}\nTitle: ${await page.title()}\nElapsed: ${Math.round(elapsed / 60000)} min`);
        }
        continue;
      }

      console.log(`[${identifier}] ✅ Options page loaded after ${attempts} attempts`);
      return true;

    } catch (navError) {
      console.error(`[${identifier}] ❌ Navigation error attempt ${attempts}:`, (navError as Error).message);
      if (attempts % 30 === 0) {
        sendLog(bot, chatId, identifier, `❌ Navigation error — still retrying\nAttempt: ${attempts} | Elapsed: ${Math.round(elapsed / 60000)} min`);
      }
    }
  }
};

/**
 * Runs once an account has been successfully claimed from the pool for
 * this browser.
 */
const runAutomatedFlow = async (
  page: Page,
  account: AccountDocument,
  identifier: string,
  bot: TelegramBot,
  chatId: string,
  displayInfo: DisplayInfo
) => {
  try {
    sendLog(bot, chatId, identifier, `🚀 Starting automated booking (account: ${account.email})\n
      🖥️ Display: ${displayInfo.display}\n🔗 noVNC: ${displayInfo.noVncUrl}\n🔌 VNC Port: ${displayInfo.vncPort}\n`);

    if (!EXAM.includes("A")) {
      const availableModules = await getModuleStatus(page);
      sendLog(bot, chatId, identifier,
        `🖥️ Display: ${displayInfo.display}\n🔗 noVNC: ${displayInfo.noVncUrl}\n🔌 VNC Port: ${displayInfo.vncPort}\n`
      );

      const allRequiredAvailable = Object.entries(account.modules).every(
        ([key, required]) => !required || availableModules[key as ModuleKey]
      );

      if (!allRequiredAvailable) {
        sendLog(bot, chatId, identifier,
          `⚠️ Required modules not available — stopping automation\n🔗 noVNC: ${displayInfo.noVncUrl}\nComplete manually if needed`
        );
        await delay(1800000);
        return;
      }
    }
    sendLog(bot, chatId, identifier, `✅ Modules selected — continuing\n🖥️ Display: ${displayInfo.display}\n🔗 noVNC: ${displayInfo.noVncUrl}\n🔌 VNC Port: ${displayInfo.vncPort}\n`);

    await page.locator("button.cs-button--arrow_next").nth(1).click();
    console.log(`[${identifier}] ✅ Clicked next`);
    await page.waitForLoadState("domcontentloaded");

    await page.locator("button.cs-layer__button--high").nth(1).click();
    console.log(`[${identifier}] ✅ Clicked book for me`);
    await page.waitForLoadState("domcontentloaded");

    // Login
    await page.locator("#username").fill(account.email);
    await page.fill("#password", account.password);
    await page.click('input[type="submit"][name="submit"]');
    sendLog(bot, chatId, identifier, `🔐 Login submitted\n🖥️ Display: ${displayInfo.display}\n🔗 noVNC: ${displayInfo.noVncUrl}\n🔌 VNC Port: ${displayInfo.vncPort}\n`);

    try {
      await page.waitForLoadState("domcontentloaded");
    } catch {
      sendLog(bot, chatId, identifier,
        `❌ Login failed or timed out — check credentials\n🔗 noVNC: ${displayInfo.noVncUrl}\nComplete manually`
      );
      await delay(1800000);
      return;
    }

    await page.locator("button.cs-button--arrow_next").nth(2).click();
    await page.waitForLoadState("domcontentloaded");

    await page.locator("button.cs-button--arrow_next").nth(1).click();
    await page.waitForLoadState("domcontentloaded");

    await page.locator("button.cs-button--arrow_next").nth(1).click();
    await page.waitForLoadState("domcontentloaded");

    console.log(`[${identifier}] ✅ Reached payment page`);

    sendLog(bot, chatId, identifier,
      `✅ *Redirected to payment page!*\n\n💳 Review details and complete payment manually\n⏳ ~30 min before session expires\n\n🔗 noVNC: ${displayInfo.noVncUrl}\n🖥️ Display: ${displayInfo.display}`
    );

    await delay(1800000);

    account.status = false;
    await account.save();

    sendLog(bot, chatId, identifier,
      `⏰ Session timeout — account disabled\nIf payment was completed, booking is confirmed`
    );

  } catch (err) {
    console.error(`[${identifier}] ❌ Automated flow error:`, err);
    sendLog(bot, chatId, identifier,
      `❌ Automation failed\n🔗 noVNC: ${displayInfo.noVncUrl}\nComplete manually — browser stays open 30 min`
    );
    await delay(1800000);
  }
};

/**
 * Runs when the slot was caught but no account was available to claim.
 */
const runManualFlow = async (
  bot: TelegramBot,
  chatId: string | null,
  identifier: string,
  displayInfo: DisplayInfo
) => {
  sendLog(bot, chatId, identifier,
    `✅ *Slot caught — no account available*\n\n🖥️ Display: ${displayInfo.display}\n🔗 noVNC: ${displayInfo.noVncUrl}\n\nComplete booking manually — browser stays open 30 min`
  );
  await delay(1800000);
};

// ── Main export ─────────────────────────────────────────────────────────────

const startBooking = async (
  page: Page,
  oid: string,
  bot: TelegramBot,
  displayInfo: DisplayInfo,
  chatId: string | null,
  timeoutMs = 5 * 60 * 60 * 1000
) => {
  const identifier = `Browser ${displayInfo.displayNumber}`;
  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;

  console.log(`[${identifier}] 🔍 Title: "${await page.title()}" | URL: ${page.url()}`);

  try {
    await page.waitForFunction(
      () => document.body?.innerText.trim().length > 0,
      { timeout: 30000 }
    );
  } catch {
    console.warn(`[${identifier}] ⚠️ Page body still empty after 30s, continuing anyway...`);
  }

  // Navigate/retry until the booking options page loads for THIS browser —
  // this is "catching the slot". Identical for every browser; no account
  // decision happens until after this resolves.
  const caught = await navigateUntilLoaded(page, identifier, bookingUrl, bot, chatId, timeoutMs);
  if (!caught) {
    return; // timed out without ever loading — nothing more to do
  }

  // Slot caught — NOW claim an account from the shared pool. Whichever
  // browser gets here first gets the next account; no two browsers can
  // ever claim the same one, since claimAccount() is serialized.
  const account = await accountPool.claimAccount();

  if (account) {
    const resolvedChatId = chatId ?? (account.user as UserDocument).telegramId;
    console.log(`[${identifier}] 🎯 Slot caught — claimed account: ${account.email}`);
    await runAutomatedFlow(page, account, account.email, bot, resolvedChatId, displayInfo);
  } else {
    console.log(`[${identifier}] 🎯 Slot caught — no account available, falling to manual`);
    await runManualFlow(bot, chatId, identifier, displayInfo);
  }
};

export default startBooking;