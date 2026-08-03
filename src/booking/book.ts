import { Page } from "playwright-core";
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
      await page.goto(url, { waitUntil: "networkidle", timeout: 5000 });

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

  console.log(`[${identifier}] 🔍 Title: "${await page.title()}" | URL: ${page.url()}`);

  const alreadyLoaded = await isBookingPageLoaded(page);
  const alreadyRateLimited = await isRateLimited(page);

  if (alreadyRateLimited) {
    consecutiveRateLimits++;
    totalRateLimits++;
    sendLog(bot, chatId, identifier,
      `🚫 Rate limited on initial load — starting retry loop with exponential backoff`
    );
  } else if (alreadyLoaded) {
    sendLog(bot, chatId, identifier,
      `✅ *Page already loaded!*\n\n🖥️ Display: ${displayInfo.display}\n🔗 noVNC: ${displayInfo.noVncUrl}\n\nComplete booking manually — browser stays open 30 min`
    );
    await delay(1800000);
    return;
  } else {
    const title = await page.title();
    console.log(`[${identifier}] ⚠️ Page not loaded correctly. Title: "${title}"`);
    sendLog(bot, chatId, identifier,
      `⚠️ Page not loaded (title: ${title}) — starting retry loop`
    );
  }

  let attempts = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      sendLog(bot, chatId, identifier,
        `⏰ Retry timeout reached (5h)\nTotal rate limits: ${totalRateLimits} — stopping retries`
      );
      return;
    }

    attempts++;

    const retryDelay = consecutiveRateLimits > 0
      ? getBackoffDelay(consecutiveRateLimits, 10000, 300000)
      : 5000;

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
          sendLog(bot, chatId, identifier,
            `🚫 *Rate Limited (429)*\nConsecutive: ${consecutiveRateLimits} | Total: ${totalRateLimits}\nNext retry in: ${Math.round(backoff / 1000)}s`
          );
        }
        continue;
      }

      if (consecutiveRateLimits > 0) {
        console.log(`[${identifier}] ✅ Rate limit cleared — resetting backoff`);
        consecutiveRateLimits = 0;
      }

      if (!await isBookingPageLoaded(page)) {
        if (attempts % 20 === 0) {
          sendLog(bot, chatId, identifier,
            `⚠️ Still retrying — attempt ${attempts}\nTitle: ${await page.title()}\nElapsed: ${Math.round(elapsed / 60000)} min`
          );
        }
        continue;
      }

      sendLog(bot, chatId, identifier,
        `✅ *Page loaded successfully!*\n\nAttempts: ${attempts} | Time: ${Math.round(elapsed / 1000)}s\n🚫 Rate limits: ${totalRateLimits}\n\n🔗 noVNC: ${displayInfo.noVncUrl}\n\nComplete booking manually — browser stays open 30 min`
      );
      await delay(1800000);
      return;

    } catch (navError) {
      console.error(`[${identifier}] ❌ Navigation error attempt ${attempts}:`, (navError as Error).message);
      if (attempts % 30 === 0) {
        sendLog(bot, chatId, identifier,
          `❌ Navigation error — still retrying\nAttempt: ${attempts} | Elapsed: ${Math.round(elapsed / 60000)} min`
        );
      }
    }
  }
};

// Automated flow

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
  let consecutiveRateLimits = 0;
  let totalRateLimits = 0;

  console.log(`[${identifier}] 🔍 Title: "${await page.title()}" | URL: ${page.url()}`);

  const alreadyLoaded = await isBookingPageLoaded(page);
  const alreadyRateLimited = await isRateLimited(page);

  if (alreadyRateLimited) {
    consecutiveRateLimits++;
    totalRateLimits++;
    sendLog(bot, chatId, identifier,
      `🚫 Rate limited on initial load — starting retry loop with exponential backoff`
    );
  } else if (alreadyLoaded) {
    console.log(`[${identifier}] ✅ Options page already loaded — skipping re-navigation`);
  } else {
    const title = await page.title();
    console.log(`[${identifier}] ⚠️ Page not loaded correctly. Title: "${title}"`);
    sendLog(bot, chatId, identifier,
      `⚠️ Page not loaded (title: ${title}) — starting retry loop`
    );
  }

  // Only enter the retry loop if we're not already sitting on the options page
  if (!alreadyLoaded || alreadyRateLimited) {
    let attempts = 0;

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        sendLog(bot, chatId, identifier,
          `⏰ Booking retry timeout (5h)\nTotal rate limits: ${totalRateLimits} — stopping retries`
        );
        return;
      }

      attempts++;

      const retryDelay = consecutiveRateLimits > 0
        ? getBackoffDelay(consecutiveRateLimits, 10000, 300000)
        : Math.floor(Math.random() * 1200) + 200; // jitter instead of flat 5s when not rate-limited

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
            sendLog(bot, chatId, identifier,
              `🚫 *Rate Limited (429)*\nConsecutive: ${consecutiveRateLimits} | Total: ${totalRateLimits}\nNext retry in: ${Math.round(backoff / 1000)}s`
            );
          }
          continue;
        }

        if (consecutiveRateLimits > 0) {
          console.log(`[${identifier}] ✅ Rate limit cleared — resetting backoff`);
          consecutiveRateLimits = 0;
        }

        if (!await isBookingPageLoaded(page)) {
          if (attempts % 20 === 0) {
            sendLog(bot, chatId, identifier,
              `⚠️ Still retrying — attempt ${attempts}\nTitle: ${await page.title()}\nElapsed: ${Math.round(elapsed / 60000)} min`
            );
          }
          continue;
        }

        console.log(`[${identifier}] ✅ Options page loaded after ${attempts} attempts`);
        break; // success — fall through to booking logic below

      } catch (navError) {
        console.error(`[${identifier}] ❌ Navigation error attempt ${attempts}:`, (navError as Error).message);
        if (attempts % 30 === 0) {
          sendLog(bot, chatId, identifier,
            `❌ Navigation error — still retrying\nAttempt: ${attempts} | Elapsed: ${Math.round(elapsed / 60000)} min`
          );
        }
      }
    }
  }

  try {


    sendLog(bot, chatId, identifier, `🚀 Starting automated booking`);
    sendLog(bot, chatId, identifier,
      `🖥️ Display: ${displayInfo.display}\n🔗 noVNC: ${displayInfo.noVncUrl}\n🔌 VNC Port: ${displayInfo.vncPort}`
    );

    sendLog(bot, chatId, identifier,
      `Change detected in modules page — stopping automation\n🔗 noVNC: ${displayInfo.noVncUrl}\nComplete manually if needed`
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
      `❌ *Automation failed:* ${(err as Error).message}\n\n🔗 noVNC: ${displayInfo.noVncUrl}\nComplete manually — browser stays open 30 min`
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

  console.log(`[${identifier}] 🔍 Title: "${await page.title()}" | URL: ${page.url()}`);

  let pageBody = await page.evaluate(() => document.body?.innerText.trim() || "");

  while (!pageBody) {
    console.log(`[${identifier}] ⏳ Page still loading — waiting 2s`);
    await delay(2000);
    pageBody = await page.evaluate(() => document.body?.innerText.trim() || "");
  }



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