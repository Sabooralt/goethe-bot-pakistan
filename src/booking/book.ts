import { Page } from "puppeteer";
import dotenv from "dotenv";
import type TelegramBot from "node-telegram-bot-api";

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
  browserNumber: number,
  message: string
) => {
  if (!chatId) return;

  const fullMessage = `[Browser ${browserNumber}] ${message}`;

  // Fire and forget - don't block on telegram messages
  setImmediate(() => {
    try {
      bot.sendMessage(chatId, fullMessage, { parse_mode: "Markdown" });
    } catch (error) {
      console.error("Failed to send Telegram message:", error);
    }
  });
};

/**
 * Calculate exponential backoff delay
 */
const getBackoffDelay = (
  attempt: number,
  baseDelay: number = 5000,
  maxDelay: number = 300000
): number => {
  // Exponential: 5s, 10s, 20s, 40s, 80s, 160s, 300s (capped at 5min)
  const exponentialDelay = baseDelay * Math.pow(2, Math.min(attempt - 1, 6));
  return Math.min(exponentialDelay, maxDelay);
};

/**
 * Check if page has rate limit error (429)
 */
const isRateLimited = async (page: Page): Promise<boolean> => {
  try {
    const content = await page.content();
    const title = (await page.title()).toLowerCase();

    // Check for 429 indicators
    return (
      content.includes("429") ||
      content.includes("too many requests") ||
      content.includes("rate limit") ||
      title.includes("429") ||
      title.includes("too many requests")
    );
  } catch (error) {
    return false;
  }
};

/**
 * Check if booking page loaded successfully
 */
const isBookingPageLoaded = async (page: Page): Promise<boolean> => {
  try {
    const pageTitle = (await page.title()).toLowerCase();
    return pageTitle.includes("options");
  } catch (error) {
    return false;
  }
};

/**
 * Navigate to URL with 5 second timeout - refresh if it takes longer
 */
const navigateWithTimeout = async (
  page: Page,
  url: string,
  browserNumber: number,
  maxAttempts = 3
): Promise<{ success: boolean; rateLimited: boolean }> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `🔄 Browser ${browserNumber}: Navigation attempt ${attempt}/${maxAttempts}...`
      );

      // Try to load with 5 second timeout
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 5000, // 5 seconds
      });

      // Check for rate limiting
      const rateLimited = await isRateLimited(page);
      if (rateLimited) {
        console.log(`🚫 Browser ${browserNumber}: Rate limited (429) detected`);
        return { success: false, rateLimited: true };
      }

      console.log(`✅ Browser ${browserNumber}: Page loaded within 5 seconds`);
      return { success: true, rateLimited: false }; // Success!
    } catch (error) {
      const err = error as Error;

      if (
        err.message.includes("timeout") ||
        err.message.includes("Navigation timeout")
      ) {
        console.log(
          `⏰ Browser ${browserNumber}: Page took >5s to load (attempt ${attempt}/${maxAttempts}), refreshing...`
        );

        // If not the last attempt, continue to next iteration (refresh)
        if (attempt < maxAttempts) {
          await delay(500); // Small delay before retry
          continue;
        } else {
          console.log(
            `⚠️ Browser ${browserNumber}: All ${maxAttempts} attempts timed out, continuing anyway...`
          );
          return { success: false, rateLimited: false }; // Failed all attempts but continue
        }
      } else {
        // Other errors (not timeout) - log and continue
        console.error(
          `❌ Browser ${browserNumber}: Navigation error: ${err.message}`
        );
        return { success: false, rateLimited: false };
      }
    }
  }

  return { success: false, rateLimited: false };
};

/**
 * SIMPLIFIED: Check if page already loaded, if not retry until it loads
 * Then notify user to complete booking manually
 * NOW WITH RATE LIMITING HANDLING
 */
const startBooking = async (
  page: Page,
  browserNumber: number,
  oid: string,
  bot: TelegramBot,
  displayInfo: DisplayInfo,
  chatId: string | null,
  timeoutMs = 5 * 60 * 60 * 1000 // 5 hours for retry loop
) => {
  const startTime = Date.now();
  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;
  let consecutiveRateLimits = 0;
  let totalRateLimits = 0;

  try {
    // STEP 1: Check if page is ALREADY loaded (since we redirected before calling this)
    console.log(
      `🔍 Browser ${browserNumber}: Checking if booking page already loaded...`
    );

    const alreadyLoaded = await isBookingPageLoaded(page);
    const alreadyRateLimited = await isRateLimited(page);

    if (alreadyRateLimited) {
      console.log(
        `🚫 Browser ${browserNumber}: Page already shows rate limit (429)`
      );
      consecutiveRateLimits++;
      totalRateLimits++;

      sendLog(
        bot,
        chatId,
        browserNumber,
        `🚫 **Rate Limited on Initial Load**\n\n` +
        `Starting retry loop with exponential backoff...`
      );
    } else if (alreadyLoaded) {
      // SUCCESS - Page already loaded correctly!
      console.log(
        `✅ Browser ${browserNumber}: Booking page already loaded successfully!`
      );

      sendLog(
        bot,
        chatId,
        browserNumber,
        `✅ **PAGE ALREADY LOADED!**\n\n` +
        `🖥️ **Display:** ${displayInfo.display}\n` +
        `🔗 **noVNC URL:** ${displayInfo.noVncUrl}\n` +
        `📌 **VNC Port:** ${displayInfo.vncPort}\n\n` +
        `💡 **You can now complete the booking manually:**\n` +
        `1. Click the noVNC URL to access the browser\n` +
        `2. Complete the booking process\n` +
        `3. Browser will remain open for manual use\n\n` +
        `⏱️ Page was already loaded from redirect`
      );

      // Keep browser open indefinitely for manual booking
      console.log(
        `🖥️ Browser ${browserNumber}: Keeping browser open for manual booking...`
      );
      await delay(1800000);

      return;
    } else {
      // Page not loaded correctly - get current state for logging
      const currentTitle = await page.title();
      console.log(
        `⚠️ Browser ${browserNumber}: Page not loaded correctly. Title: "${currentTitle}"`
      );

      sendLog(
        bot,
        chatId,
        browserNumber,
        `⚠️ **Page Not Loaded Correctly**\n\n` +
        `Current title: ${currentTitle}\n` +
        `Starting retry loop...`
      );
    }

    // STEP 2: START RETRY LOOP - Page didn't load correctly or rate limited
    console.log(
      `🔄 Browser ${browserNumber}: Starting 5-hour retry loop with rate limit handling...`
    );

    let attempts = 0;
    let baseRetryDelay = 5000; // Start with 5 seconds

    while (true) {
      const elapsed = Date.now() - startTime;

      if (elapsed > timeoutMs) {
        console.log(`⏰ Browser ${browserNumber}: 5 hour timeout reached`);
        sendLog(
          bot,
          chatId,
          browserNumber,
          `⏰ Retry timeout reached (5 hours). Stopping retries.\n` +
          `Total rate limits encountered: ${totalRateLimits}`
        );
        return;
      }

      attempts++;

      // Calculate delay based on rate limiting
      let retryDelay = baseRetryDelay;

      if (consecutiveRateLimits > 0) {
        // Exponential backoff when rate limited
        retryDelay = getBackoffDelay(consecutiveRateLimits, 10000, 300000); // 10s base, max 5min
        console.log(
          `🕐 Browser ${browserNumber}: Rate limited ${consecutiveRateLimits} times, backing off for ${Math.round(
            retryDelay / 1000
          )}s...`
        );
      }

      // Wait before retry
      await delay(retryDelay);

      try {
        // Use navigateWithTimeout to reload the page
        const navResult = await navigateWithTimeout(
          page,
          bookingUrl,
          browserNumber
        );

        // Handle rate limiting
        if (navResult.rateLimited) {
          consecutiveRateLimits++;
          totalRateLimits++;

          const backoffTime = getBackoffDelay(
            consecutiveRateLimits,
            10000,
            300000
          );

          console.log(
            `🚫 Browser ${browserNumber}: Rate limited! (${consecutiveRateLimits} consecutive, ${totalRateLimits} total)`
          );

          // Notify on rate limits
          if (consecutiveRateLimits === 1 || consecutiveRateLimits % 3 === 0) {
            sendLog(
              bot,
              chatId,
              browserNumber,
              `🚫 **Rate Limited (429)**\n\n` +
              `Consecutive: ${consecutiveRateLimits}\n` +
              `Total: ${totalRateLimits}\n` +
              `Next retry in: ${Math.round(backoffTime / 1000)}s\n` +
              `Attempt: ${attempts}\n` +
              `Elapsed: ${Math.round(elapsed / 60000)} min`
            );
          }

          continue; // Skip to next iteration with exponential backoff
        }

        // Reset consecutive rate limits on successful navigation
        if (consecutiveRateLimits > 0) {
          console.log(
            `✅ Browser ${browserNumber}: Rate limit cleared! Resetting backoff.`
          );
          consecutiveRateLimits = 0;
        }

        // Check if page loaded correctly now
        const pageLoaded = await isBookingPageLoaded(page);

        if (!pageLoaded) {
          const retryPageTitle = await page.title();

          // Notify every 20 attempts
          if (attempts % 20 === 0) {
            console.log(
              `⚠️ Browser ${browserNumber}: Still seeing error (attempt ${attempts}): ${retryPageTitle}`
            );
            sendLog(
              bot,
              chatId,
              browserNumber,
              `⚠️ Still retrying...\n` +
              `Attempt: ${attempts}\n` +
              `Error: ${retryPageTitle}\n` +
              `Rate limits: ${totalRateLimits}\n` +
              `Elapsed: ${Math.round(elapsed / 60000)} min\n` +
              `Remaining: ${Math.round((timeoutMs - elapsed) / 60000)} min`
            );
          }
          continue;
        }

        // SUCCESS - Page loaded!
        console.log(
          `✅ Browser ${browserNumber}: Page loaded successfully after ${attempts} attempts!`
        );

        sendLog(
          bot,
          chatId,
          browserNumber,
          `✅ **PAGE LOADED SUCCESSFULLY!**\n\n` +
          `🖥️ **Display:** ${displayInfo.display}\n` +
          `🔗 **noVNC URL:** ${displayInfo.noVncUrl}\n` +
          `📌 **VNC Port:** ${displayInfo.vncPort}\n\n` +
          `🔄 **Attempts:** ${attempts}\n` +
          `🚫 **Rate Limits:** ${totalRateLimits}\n` +
          `⏱️ **Time:** ${Math.round(elapsed / 1000)}s\n\n` +
          `💡 **You can now complete the booking manually:**\n` +
          `1. Click the noVNC URL to access the browser\n` +
          `2. Complete the booking process\n` +
          `3. Browser will remain open for manual use`
        );

        // Keep browser open indefinitely for manual booking
        console.log(
          `🖥️ Browser ${browserNumber}: Keeping browser open for manual booking...`
        );
        await delay(1800000);
        return;
      } catch (navError) {
        console.error(
          `❌ Browser ${browserNumber}: Navigation error (attempt ${attempts}):`,
          (navError as Error).message
        );

        // Notify on critical errors every 30 attempts
        if (attempts % 30 === 0) {
          sendLog(
            bot,
            chatId,
            browserNumber,
            `❌ Navigation error\n` +
            `Attempt: ${attempts}\n` +
            `Elapsed: ${Math.round(elapsed / 60000)} min\n` +
            `Will keep retrying...`
          );
        }
      }
    }
  } catch (err) {
    console.error(`❌ Browser ${browserNumber}: Unexpected error:`, err);
    sendLog(
      bot,
      chatId,
      browserNumber,
      `❌ Unexpected error: ${(err as Error).message}\n\n` +
      `🖥️ Display: ${displayInfo.display}\n` +
      `🔗 noVNC: ${displayInfo.noVncUrl}\n\n` +
      `You may need to access manually.`
    );
    await delay(1800000);
  }
};

export default startBooking;
