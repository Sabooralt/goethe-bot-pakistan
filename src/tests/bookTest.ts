import puppeteer, { Page } from "puppeteer";
import { selectAvailableModules } from "../fillers/selectAllModules";
import { handleBookingConflict } from "../fillers/handleBookingConflict";

interface AccountModules {
  read: boolean;
  hear: boolean;
  write: boolean;
  speak: boolean;
}

let display = ":1"
const run = async () => {
  const browser = await puppeteer.launch({
    headless: false,

    env: { DISPLAY: display },
    args: [
      // Performance optimizations
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--disable-features=VizDisplayCompositor",
      `--display=${display}`,

      // Disable unnecessary features for speed
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",

      // Skip first run tasks
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",

      // Disable telemetry and unnecessary network calls
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-extensions-with-background-pages",
      "--disable-domain-reliability",
      "--disable-features=AutofillServerCommunication",
      "--disable-sync",

      // Performance flags
      "--enable-features=NetworkService,NetworkServiceInProcess",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--mute-audio",

      // Memory optimization
      "--max_old_space_size=512",
      "--memory-pressure-off",

      // Additional speed optimizations
      "--disable-blink-features=AutomationControlled",
      "--disable-logging",
      "--disable-permissions-api",
      "--disable-save-password-bubble",
      "--disable-single-click-autofill",
      "--disable-extensions",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
    ],
  });
  const page = await browser.newPage();

  const url =
    "https://goethe.de/coe?lang=en&oid=2faab28c6a9436d1f1ebaf00ea245afec7cc65c974a5444ee32fe5b202cd2b91"; // Replace with your website

  await page.goto(url, { waitUntil: "networkidle2" });

  // Example account modules
  const accountModules: AccountModules = {
    read: true,
    hear: true,
    write: true,
    speak: true,
  };

  await page.evaluateOnNewDocument(() => {
    localStorage.setItem(
      "uc_gcm",
      JSON.stringify({
        adsDataRedaction: true,
        adPersonalization: "denied",
        adStorage: "denied",
        adUserData: "denied",
        analyticsStorage: "denied",
      })
    );

    localStorage.setItem("uc_ui_version", "3.73.0");
    localStorage.setItem("uc_user_interaction", "true");

    localStorage.setItem(
      "uc_settings",
      JSON.stringify({
        controllerId:
          "42e213448633d19d017343f77368ef4ab462b0ca1fb10607c313393260b08f21",
        id: "rTbKQ4Qc-",
        services: [],
      })
    );
  });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const resourceType = req.resourceType();
    if (
      resourceType === "image" ||
      resourceType === "font" ||
      resourceType === "media" ||
      resourceType === "other"
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });

  let maxRetries = 20;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await page.goto(
      `https://www.goethe.de/coe?lang=en&oid=4d593ed99a6f2206d516e9314a26809574d64026e3ae71e8c6350bf6654e359d`,
      {
        waitUntil: "domcontentloaded",
      }
    );
    const pageTitle = (await page.title()).toLowerCase();
    if (
      pageTitle.includes("error") ||
      pageTitle.includes("unterbrechung") ||
      /http\s?\d{3}/i.test(pageTitle)
    ) {
      console.error(`❗ Booking error detected on attempt ${attempt}`);

      if (attempt === maxRetries) {
        console.log("❌ Max retries reached. Stopping booking.");
        return;
      }
      continue;
    }
    break;
  }
  try {
    const availableModules = await selectAvailableModules(page, accountModules);

    if (!availableModules) {
      console.log("❌ No modules available, stopping booking.");
    }

    await page.waitForSelector("button.cs-button--arrow_next", {
      visible: true,
    });
    await page.click("button.cs-button--arrow_next");
    console.log('✅ Clicked "weiter" button');

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector("button.cs-layer__button--high", {
      visible: true,
    });
    const bookForButtons = await page.$$("button.cs-layer__button--high");
    await bookForButtons[1]?.click();
    console.log('🎯 Clicked "Book for me" button');

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#username", { visible: true });
    await page.type("#username", "Jerinjoseph898@gmail.com");

    await page.type("#password", "Jerin@898");
    console.log("✅ Submitted login form");

    await page.click('input[type="submit"][name="submit"]');
    console.log("🚀 Submitted login form");

    try {
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 200000,
      });
    } catch (err) {
      console.log(" ℹ️ Error logging in:" + (err as Error).message);
    }

    const bookingConflict = await handleBookingConflict(page);

    await page.click("button.cs-button--arrow_next");

    try {
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 5000,
      });
      console.log("✅ Navigated after DOB form");
    } catch {
      console.log("ℹ️ No navigation after DOB form (skipped step?)");
    }

    await page.click("button.cs-button--arrow_next");
    await page.waitForNavigation({
      waitUntil: "networkidle2",
    });
    
    if (bookingConflict) {
      await page.click("button.cs-button--arrow_next");
      await page.waitForNavigation({
        waitUntil: "networkidle2",
      });
    }

    console.log("✅ Navigated to payment page");

    let paymentMessage =
      "✅ Redirected to the payment page.\n" +
      "💳 Please review all the details and complete the payment manually.\n" +
      "⏳ You have approximately *10 minutes* to finish the payment before the session expires.\n\n";
  } catch (err) {
    console.log(err);
  }
};

run().catch(console.error);
