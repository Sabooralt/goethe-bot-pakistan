import { Page } from "puppeteer";
import dotenv from "dotenv";
import type TelegramBot from "node-telegram-bot-api";
import { submitDetailsForm } from "../fillers/submitDetailsForm";
import { submitAddressForm } from "../fillers/submitAddressForm";
import { handleBookingConflict } from "../fillers/handleBookingConflict";
import { AccountDocument } from "../models/accountSchema";
import { UserDocument } from "../models/userSchema";
import { selectAvailableModules } from "../fillers/selectAllModules";

dotenv.config();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sendAccountLog = (
  bot: TelegramBot,
  chatId: string,
  account: AccountDocument,
  message: string
) => {
  const accountInfo = `[${account.firstName} ${account.lastName} - ${account.email}]`;
  const fullMessage = `${accountInfo} ${message}`;

  try {
    bot.sendMessage(chatId, fullMessage);
    console.log(fullMessage);
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
};

const startBooking = async (
  page: Page,
  acc: AccountDocument,
  oid: string,
  bot: TelegramBot,
  maxRetries = 10
) => {
  let attempt = 0;
  const chatId = (acc.user as UserDocument).telegramId;

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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await page.goto(`https://www.goethe.de/coe?lang=en&oid=${oid}`, {
      waitUntil: "domcontentloaded",
    });
    const pageTitle = await page.title();
    if (pageTitle.includes("Error")) {
      console.error(`❗ Booking error detected on attempt ${attempt}`);
      sendAccountLog(
        bot,
        chatId,
        acc,
        `❗ Booking error detected, retrying... (${attempt}/${maxRetries})`
      );

      if (attempt === maxRetries) {
        sendAccountLog(
          bot,
          chatId,
          acc,
          "❌ Max retries reached. Stopping booking."
        );
        return;
      }
      continue;
    }
    break;
  }

  try {
    sendAccountLog(bot, chatId, acc, "🚀 Starting booking process...");
    const availableModules = await selectAvailableModules(page, acc.modules);

    if (!availableModules) {
      sendAccountLog(
        bot,
        chatId,
        acc,
        "❌ Required modules not available, stopping booking."
      );
      return;
    }

    sendAccountLog(bot, chatId, acc, "Selected modules, continuing booking...");

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
    await page.type("#username", acc.email);

    await page.type("#password", acc.password);
    console.log("✅ Submitted login form");
    sendAccountLog(bot, chatId, acc, "✅ Submitted out login form");

    await page.click('input[type="submit"][name="submit"]');
    console.log("🚀 Submitted login form");

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });

    await handleBookingConflict(page);

    await submitDetailsForm(page, acc);

    try {
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 5000,
      });
      console.log("✅ Navigated after DOB form");
    } catch {
      console.log("ℹ️ No navigation after DOB form (skipped step?)");
    }

    sendAccountLog(bot, chatId, acc, "✅ Filled out DOB form");

    // ------------------------------

    await submitAddressForm(page, acc);

    try {
      await page.waitForNavigation({
        waitUntil: "networkidle2",
        timeout: 5000,
      });
      console.log("✅ Navigated after address form");
    } catch {
      console.log(
        "ℹ️ No navigation after address form (optional step skipped)"
      );
    }

    console.log("✅ Filled out contact details");
    sendAccountLog(bot, chatId, acc, "✅ Filled out contact details");

    await page.click("button.cs-button--arrow_next");
    console.log('✅ Clicked "Next Button" after address');

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });

    console.log("✅ Navigated to payment page");

    sendAccountLog(
      bot,
      chatId,
      acc,
      "✅ Redirected to the payment page.\n" +
        "💳 Please log in to the RDP, review all the details and complete the payment manually.\n" +
        "⏳ You have approximately *10 minutes* to finish the payment before the session expires."
    );

    acc.status = false;
    await acc.save();

    await delay(600000);
  } catch (err) {
    sendAccountLog(
      bot,
      chatId,
      acc,
      `❌ Booking process failed: ${(err as Error).message}`
    );
    console.error("Error in startBooking:", err);
  }
};

export default startBooking;
