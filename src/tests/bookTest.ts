import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";


import dotenv from "dotenv";
import { Page } from "puppeteer";
import { proxyPool, USE_PROXIES } from "../proxyPool";
import { browserArgs } from "../utils/browserArgs";

dotenv.config();

puppeteer.use(StealthPlugin());




const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));



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
    const pageTitle = (await page.title()).toLocaleLowerCase();
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
        timeout: 20000, // 20 seconds
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
  browserNumber: number = 2,
  oid: string,
  timeoutMs = 5 * 60 * 60 * 1000 // 5 hours for retry loop
) => {

  const proxyHost = "pr.oxylabs.io:7777";
  const username = "customer-Ashon_UbFVW-cc-US";
  const password = "Ashon+482001";

  let proxy: any = null;
  let proxyUrl = "";
  if (USE_PROXIES) {
    proxy = proxyPool.getNextProxy();
    if (proxy) {
      proxyUrl = `${proxy.host}:${proxy.port}`;
      console.log(`🔒 Proxy ${proxyUrl} → Browser ${browserNumber}`);
    }
  }

  const args = browserArgs;

  if (proxy) {
    args.push(
      `--proxy-server=${proxy.type}://${proxy.host}:${proxy.port}`
    );
  }

  if (browserNumber) {
    args.push(
      `--display=:${browserNumber}`,
      "--window-size=1280,720",
    )
  }


  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "/usr/bin/google-chrome",
    userDataDir: "./profile",
    env: {
      display: `:${browserNumber}`,
    },
    args,
    defaultViewport: null,
  })

  const startTime = Date.now();
  const bookingUrl = `https://www.goethe.de/coe?lang=en&oid=${oid}`;

  const page = await browser.newPage();

  await page.setViewport({ width: 1280, height: 720 });
  
  if (proxy && proxy.username && proxy.password) {
    await page.authenticate({
      username: proxy.username,
      password: proxy.password,
    });
  }



  await page.goto(bookingUrl, { waitUntil: "networkidle2" });

  console.log("Url reached!");


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


    } else if (alreadyLoaded) {
      // SUCCESS - Page already loaded correctly!
      console.log(
        `✅ Browser ${browserNumber}: Booking page already loaded successfully!`
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

          }
          continue;
        }

        // SUCCESS - Page loaded!
        console.log(
          `✅ Browser ${browserNumber}: Page loaded successfully after ${attempts} attempts!`
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

        }
      }
    }
  } catch (err) {
    console.error(`❌ Browser ${browserNumber}: Unexpected error:`, err);

    await delay(1800000);
  }
};

startBooking(2, "13b81c3f40dcf835f612f2c00ff1cf084893f5072e83c0e8c6d13d5ded236095")
