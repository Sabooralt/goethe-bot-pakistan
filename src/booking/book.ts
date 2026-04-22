import { Page } from "puppeteer";
import dotenv from "dotenv";
import type TelegramBot from "node-telegram-bot-api";
import { AccountDocument } from "../models/accountSchema";
import { UserDocument } from "../models/userSchema";
import { handleBookingConflict } from "../fillers/handleBookingConflict";
import { selectAvailableModules } from "../fillers/selectAllModules";

dotenv.config();

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
      console.log(`[${identifier}] Navigation attempt ${attempt}/${maxAttempts}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 5000 });

      if (await isRateLimited(page)) {
        console.log(`[${identifier}] Rate limited detected`);
        return { success: false, rateLimited: true };
      }

      return { success: true, rateLimited: false };
    } catch (error) {
      const err = error as Error;
      if (err.message.includes("timeout") || err.message.includes("Navigation timeout")) {
        console.log(`[${identifier}] Timeout on attempt ${attempt}/${maxAttempts}`);
        if (attempt < maxAttempts) {
          await delay(500);
          continue;
        }
        return { success: false, rateLimited: false };
      }
      console.error(`[${identifier}] Navigation error: ${err.message}`);
      return { success: false, rateLimited: false };
    }
  }
  return { success: false, rateLimited: false };
};

// ── Manual flow (no account) ────────────────────────────────────────────────

const runManualFlow = async (
  page: Page,
  identifier: string,
  bookingUrl: string,
  bot: TelegramBot,
  chatId: string | null,
  displayInfo: DisplayInfo,
  timeoutMs: number
) => {
  const startTime = Date.now();
  let consecutiveRateLimits = 0;
  let totalRateLimits = 0;

  console.log(`[${identifier}] Title: "${await page.title()}" | URL: ${page.url()}`);

  const alreadyLoaded = await isBookingPageLoaded(page);
  const alreadyRateLimited = await isRateLimited(page);

  if (alreadyRateLimited) {
    consecutiveRateLimits++;
    totalRateLimits++;
    sendLog(bot, chatId, identifier, `Rate limited on initial load, starting retry loop...`);
  } else if (alreadyLoaded) {
    sendLog(
      bot, chatId, identifier,
      `Page loaded\nDisplay: ${displayInfo.display}\nnoVNC: ${displayInfo.noVncUrl}\nComplete booking manually`
    );
    await delay(1800000);
    return;
  } else {
    const title = await page.title();
    console.log(`[${identifier}] Page not loaded correctly. Title: "${title}"`);
    sendLog(bot, chatId, identifier, `Page not loaded (title: ${title}), starting retry loop...`);
  }

  let attempts = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      sendLog(bot, chatId, identifier, `Retry timeout (5h). Rate limits total: ${totalRateLimits}`);
      return;
    }

    attempts++;

    const retryDelay = consecutiveRateLimits > 0
      ? getBackoffDelay(consecutiveRateLimits, 10000, 300000)
      : 5000;

    if (consecutiveRateLimits > 0) {
      console.log(`[${identifier}] Rate limited ${consecutiveRateLimits}x, backing off ${Math.round(retryDelay / 1000)}s`);
    }

    await delay(retryDelay);

    try {
      const navResult = await navigateWithTimeout(page, bookingUrl, identifier);

      if (navResult.rateLimited) {
        consecutiveRateLimits++;
        totalRateLimits++;
        if (consecutiveRateLimits === 1 || consecutiveRateLimits % 3 === 0) {
          const backoff = getBackoffDelay(consecutiveRateLimits, 10000, 300000);
          sendLog(bot, chatId, identifier,
            `Rate limited (${consecutiveRateLimits} consecutive, ${totalRateLimits} total)\nNext retry in ${Math.round(backoff / 1000)}s`
          );
        }
        continue;
      }

      if (consecutiveRateLimits > 0) {
        console.log(`[${identifier}] Rate limit cleared`);
        consecutiveRateLimits = 0;
      }

      if (!await isBookingPageLoaded(page)) {
        if (attempts % 20 === 0) {
          sendLog(bot, chatId, identifier,
            `Still retrying (attempt ${attempts})\nTitle: ${await page.title()}\nElapsed: ${Math.round(elapsed / 60000)} min`
          );
        }
        continue;
      }

      sendLog(
        bot, chatId, identifier,
        `Page loaded after ${attempts} attempts (${Math.round(elapsed / 1000)}s)\nnoVNC: ${displayInfo.noVncUrl}\nComplete booking manually`
      );
      await delay(1800000);
      return;

    } catch (navError) {
      console.error(`[${identifier}] Navigation error attempt ${attempts}:`, (navError as Error).message);
      if (attempts % 30 === 0) {
        sendLog(bot, chatId, identifier,
          `Navigation error, still retrying (attempt ${attempts}, ${Math.round(elapsed / 60000)} min elapsed)`
        );
      }
    }
  }
};

// ── Automated flow (with account) ──────────────────────────────────────────

const runAutomatedFlow = async (
  page: Page,
  account: AccountDocument,
  identifier: string,
  bookingUrl: string,
  bot: TelegramBot,
  chatId: string,
  displayInfo: DisplayInfo,
  timeoutMs: number
) => {
  const startTime = Date.now();

  // Cookie consent bypass
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("uc_gcm", JSON.stringify({
      adsDataRedaction: true,
      adPersonalization: "denied",
      adStorage: "denied",
      adUserData: "denied",
      analyticsStorage: "denied",
    }));
    localStorage.setItem("uc_ui_version", "3.73.0");
    localStorage.setItem("uc_user_interaction", "true");
    localStorage.setItem("uc_settings", JSON.stringify({
      controllerId: "42e213448633d19d017343f77368ef4ab462b0ca1fb10607c313393260b08f21",
      id: "rTbKQ4Qc-",
      services: [],
    }));
  });

  // Navigate with retry until booking page loads
  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      sendLog(bot, chatId, identifier, `Booking retry timeout (5h). Stopping.`);
      return;
    }

    await page.goto(bookingUrl, { waitUntil: "domcontentloaded" });

    const title = (await page.title()).toLowerCase();
    if (
      title.includes("error") ||
      title.includes("unterbrechung") ||
      /http\s?\d{3}/i.test(title)
    ) {
      console.error(`[${identifier}] Error page detected (${title}), retrying in 5s...`);
      sendLog(bot, chatId, identifier, `Error page detected, retrying...\nElapsed: ${Math.round(elapsed / 60000)} min`);
      await delay(5000);
      continue;
    }

    break; // Page loaded fine
  }

  try {
    sendLog(bot, chatId, identifier, `Starting automated booking...`);

    if (displayInfo) {
      sendLog(bot, chatId, identifier,
        `Display: ${displayInfo.display}\nnoVNC: ${displayInfo.noVncUrl}\nVNC Port: ${displayInfo.vncPort}`
      );
    }

    // Module selection
    const availableModules = await selectAvailableModules(page, account.modules);
    if (!availableModules) {
      sendLog(bot, chatId, identifier,
        `Required modules not available\nnoVNC: ${displayInfo.noVncUrl}\nComplete manually if needed`
      );
      await delay(1800000); // Keep browser open
      return;
    }

    sendLog(bot, chatId, identifier, `Modules selected, continuing...`);

    await page.waitForSelector("button.cs-button--arrow_next", { visible: true });
    await page.click("button.cs-button--arrow_next");
    console.log(`[${identifier}] Clicked next button`);

    await page.waitForNavigation({ waitUntil: "domcontentloaded" });

    await page.waitForSelector("button.cs-layer__button--high", { visible: true });
    const bookForButtons = await page.$$("button.cs-layer__button--high");
    await bookForButtons[1]?.click();
    console.log(`[${identifier}] Clicked book for me`);

    await page.waitForNavigation({ waitUntil: "domcontentloaded" });

    // Login
    await page.waitForSelector("#username", { visible: true });
    await page.type("#username", account.email);
    await page.type("#password", account.password);
    await page.click('input[type="submit"][name="submit"]');
    sendLog(bot, chatId, identifier, `Login submitted`);

    try {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 });
    } catch {
      sendLog(bot, chatId, identifier,
        `Login failed or timed out. Check credentials.\nnoVNC: ${displayInfo.noVncUrl}\nComplete manually`
      );
      await delay(1800000);
      return;
    }

    const bookingConflict = await handleBookingConflict(page);

    await page.click("button.cs-button--arrow_next");
    try {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 5000 });
    } catch {
      console.log(`[${identifier}] No navigation after DOB step (skipped)`);
    }

    await page.click("button.cs-button--arrow_next");
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    if (bookingConflict) {
      await page.click("button.cs-button--arrow_next");
      await page.waitForNavigation({ waitUntil: "networkidle2" });
    }

    console.log(`[${identifier}] Reached payment page`);

    sendLog(bot, chatId, identifier,
      `Redirected to payment page\nReview details and complete payment manually (30 min window)\nnoVNC: ${displayInfo.noVncUrl}\nDisplay: ${displayInfo.display}`
    );

    await delay(1800000);

    account.status = false;
    await account.save();

    sendLog(bot, chatId, identifier, `Session timeout. Account disabled. Booking should be confirmed if payment was completed.`);

  } catch (err) {
    // Never close — notify and keep open for manual intervention
    console.error(`[${identifier}] Automated flow error:`, err);
    sendLog(bot, chatId, identifier,
      `Automation failed: ${(err as Error).message}\nnoVNC: ${displayInfo.noVncUrl}\nComplete manually`
    );
    await delay(1800000);
  }
};

// ── Main export ─────────────────────────────────────────────────────────────

const startBooking = async (
  page: Page,
  oid: string,
  bot: TelegramBot,
  displayInfo: DisplayInfo,
  chatId: string | null,
  account?: AccountDocument,
  timeoutMs = 5 * 60 * 60 * 1000
) => {
  const identifier = account
    ? account.email
    : `Browser ${displayInfo.displayNumber}`;

  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;

  console.log(`[${identifier}] Title: "${await page.title()}" | URL: ${page.url()}`);

  if (account) {
    const resolvedChatId = chatId ?? (account.user as UserDocument).telegramId;
    await runAutomatedFlow(
      page, account, identifier, bookingUrl,
      bot, resolvedChatId, displayInfo, timeoutMs
    );
  } else {
    await runManualFlow(
      page, identifier, bookingUrl,
      bot, chatId, displayInfo, timeoutMs
    );
  }
};

export default startBooking;