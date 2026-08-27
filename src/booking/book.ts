//Pak

import { Browser, BrowserContext, Page } from "playwright-core";
import dotenv from "dotenv";
import type TelegramBot from "node-telegram-bot-api";
import { AccountDocument } from "../models/accountSchema";
import { UserDocument } from "../models/userSchema";
import { getModuleStatus, ModuleKey } from "../fillers/getModuleStatus";
import { accountPool } from "../accounts/account-pool";
import { notifyBookingCompleted } from "../fillers/notifyBookingComplete";
import { CookieConsentBypass } from "../browser/cookieConsentBypass";
import { selectModules } from "../fillers/selectModules";
import { handleBookingConflict } from "../fillers/handleBookingConflict";

dotenv.config();

const EXAM = process.env.EXAM || "A1";
const REFRESH_INTERVAL_MS = 2500;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RATE_LIMIT_PING_INTERVAL_MS = 60000;
let lastRateLimitPingAt = 0;
let globalRateLimitCount = 0;

const canSendRateLimitPing = (): boolean => {
  const now = Date.now();
  if (now - lastRateLimitPingAt >= RATE_LIMIT_PING_INTERVAL_MS) {
    lastRateLimitPingAt = now;
    return true;
  }
  return false;
};

interface DisplayInfo {
  display: string;
  displayNumber: string;
  noVncUrl: string;
  vncPort: number;
}


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

const isRateLimited = async (page: Page): Promise<boolean> => {
  try {
    const title = (await page.title()).toLowerCase();
    const url = page.url().toLowerCase();
    return (
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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });

      if (await isRateLimited(page)) {
        console.log(`[${identifier}] 🚫 Rate limited detected`);
        return { success: false, rateLimited: true };
      }
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


// Closes the current context and opens a fresh one + page.
// Called every time a rate limit is detected (initial check or mid-loop).
// This is also what rotates the proxy IP (confirmed via testing — a plain
// context recreation pulls a new exit IP from the rotating gateway).
const recreateContext = async (
  context: BrowserContext,
  browser: Browser,
  identifier: string
): Promise<{ context: BrowserContext; page: Page }> => {
  await context.close();

  const newContext = await browser.newContext();

  const newPage = await newContext.newPage();
  await CookieConsentBypass(newPage, true);
  return { context: newContext, page: newPage };
};

const navigateUntilLoaded = async (
  context: BrowserContext,
  browser: Browser,
  page: Page,
  identifier: string,
  bookingUrl: string,
  bot: TelegramBot,
  chatId: string | null,
  timeoutMs: number
): Promise<{ success: boolean; context: BrowserContext; page: Page }> => {
  const startTime = Date.now();
  let totalRateLimits = 0;

  console.log(`[${identifier}] 🔍 Title: "${await page.title()}" | URL: ${page.url()}`);

  const alreadyLoaded = await isBookingPageLoaded(page);
  const alreadyRateLimited = await isRateLimited(page);

  if (alreadyRateLimited) {
    totalRateLimits++;
    sendLog(bot, chatId, identifier, `🚫 Rate limited on initial load — rotating proxy and retrying`);
    ({ context, page } = await recreateContext(context, browser, identifier));
  } else if (alreadyLoaded) {
    console.log(`[${identifier}] ✅ Options page already loaded on first check`);
    return { success: true, context, page };
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
      return { success: false, context, page };
    }

    attempts++;

    await delay(REFRESH_INTERVAL_MS);

    try {
      const navResult = await navigateWithTimeout(page, bookingUrl, identifier);

      if (navResult.rateLimited) {
        totalRateLimits++;

        ({ context, page } = await recreateContext(context, browser, identifier));

        if (canSendRateLimitPing()) {
          sendLog(bot, chatId, identifier, `🚫 Rate limits ongoing across browsers (${globalRateLimitCount} total hits so far) — proxies rotating, still trying`);
        }
        continue;
      }

      if (!await isBookingPageLoaded(page)) {
        if (attempts % 20 === 0) {
          sendLog(bot, chatId, identifier, `⚠️ Still retrying — attempt ${attempts}\nTitle: ${await page.title()}\nElapsed: ${Math.round(elapsed / 60000)} min`);
        }
        continue;
      }

      console.log(`[${identifier}] ✅ Options page loaded after ${attempts} attempts`);
      return { success: true, context, page };

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
        await delay(7200000);
        return;
      }
    }

    await selectModules(page, account.modules);

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
      await delay(7200000);
      return;
    }

    const bookingConflict = await handleBookingConflict(page);

    if (bookingConflict) {
      //DOB Page
      await page.locator("button.cs-button--arrow_next").nth(0).click();
      await page.waitForLoadState("domcontentloaded");

      //Additional Info Page
      await page.locator("button.cs-button--arrow_next").nth(0).click();
      await page.waitForLoadState("domcontentloaded");
    }

    //Voucher Page
    await page.locator("button.cs-button--arrow_next").nth(2).click();
    await page.waitForLoadState("domcontentloaded");


    //Payment confirm Page
    await page.locator("button.cs-button--arrow_next").nth(1).click();
    await page.waitForLoadState("domcontentloaded");

    //Final Confirmation Page
    await page.locator("button.cs-button--arrow_next").nth(0).click();
    await page.waitForLoadState("domcontentloaded");

    console.log(`[${identifier}] ✅ Booking Completed`);

    sendLog(bot, chatId, identifier,
      `✅ *Booking Completed*\n\n💳 Review the page.\n⏳ ~2 hrs before session expires\n\n🔗 noVNC: ${displayInfo.noVncUrl}\n🖥️ Display: ${displayInfo.display}`
    );

    await delay(10000);
    notifyBookingCompleted(page, bot, chatId, identifier);
    await delay(7200000);


    sendLog(bot, chatId, identifier,
      `⏰ Session timeout — account disabled\nIf payment was completed, booking is confirmed`
    );

  } catch (err) {
    console.error(`[${identifier}] ❌ Automated flow error:`, err);
    sendLog(bot, chatId, identifier,
      `❌ Automation failed\n🔗 noVNC: ${displayInfo.noVncUrl}\nComplete manually — browser stays open 2 hrs`
    );
    await delay(7200000);
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
    `✅ *Slot caught — no account available*\n\n🖥️ Display: ${displayInfo.display}\n🔗 noVNC: ${displayInfo.noVncUrl}\n\nComplete booking manually — browser stays open 2 hrs`
  );
  await delay(7200000);
};

// ── Main export ─────────────────────────────────────────────────────────────

const startBooking = async (
  browser: Browser,
  context: BrowserContext,
  page: Page,
  oid: string,
  bot: TelegramBot,
  displayInfo: DisplayInfo,
  chatId: string | null,
  timeoutMs = 5 * 60 * 60 * 1000
) => {
  const identifier = `Browser ${displayInfo.displayNumber}`;
  const bookingUrl = `https://www.goethe.de/coe/entry?lang=en&oid=${oid}`;

  console.log(`[${identifier}] 🔍 Title: "${await page.title()}" | URL: ${page.url()}`);

  try {
    await page.waitForFunction(
      () => document.body?.innerText.trim().length > 0,
      { timeout: 10000 }
    );
    console.log(`[${identifier}] ✅ Page body loaded within timeout`)
  } catch {
    console.warn(`[${identifier}] ⚠️ Page body still empty after 10s, relaunching the browser...`);
    ({ context, page } = await recreateContext(context, browser, identifier));
  }


  const result = await navigateUntilLoaded(context, browser, page, identifier, bookingUrl, bot, chatId, timeoutMs);
  context = result.context;
  page = result.page;

  if (!result.success) {
    return;
  }
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