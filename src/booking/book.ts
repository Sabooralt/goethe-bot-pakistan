import puppeteer, { Page } from "puppeteer";
import dotenv from "dotenv";
import checkAppointments from "../fillers/checkAppointment";
import { Account, Slot } from "../types";
import detectBookingError from "../fillers/detectBookingError";
import selectAllCheckboxes from "../fillers/selectAllCheckBoxes";
import type TelegramBot from "node-telegram-bot-api";

dotenv.config();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let available: Slot[] = [];
const MAX_RETRIES = 10;
let attempts = 0;

const sendAccountLog = async (
  bot: TelegramBot,
  chatId: string,
  account: Account,
  message: string
) => {
  const accountInfo = `[${account.firstName} ${account.lastName} - ${account.email}]`;
  const fullMessage = `${accountInfo} ${message}`;

  try {
    await bot.sendMessage(chatId, fullMessage);
    console.log(fullMessage);
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
  }
};

const startBooking = async (page: Page, acc: Account, bot: TelegramBot) => {
  try {
    const chatId = acc.user.telegramId;
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

    /* await page.setRequestInterception(true);

    page.on("request", (req) => {
      const resourceType = req.resourceType();

      if (
        resourceType === "image" ||
        resourceType === "stylesheet" ||
        resourceType === "font" ||
        resourceType === "media" ||
        resourceType === "other"
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });
 */

    await sendAccountLog(bot, chatId, acc, "🚀 Starting booking process...");

    await page.goto("https://www.goethe.de/ins/dk/de/spr/prf/gzb1.cfm", {
      waitUntil: "domcontentloaded",
    });

    while (attempts < MAX_RETRIES) {
      try {
        console.log(`🔁 Attempt ${attempts + 1} of ${MAX_RETRIES}`);

        available = await checkAppointments(page);

        if (available.length > 0) {
          const successMessage = `✅ Appointments found:\n${available
            .map((slot: Slot) => `${slot.date} @ ${slot.location}`)
            .join("\n")}`;
          await sendAccountLog(bot, chatId, acc, successMessage);
          console.log(successMessage);
          console.log(available);
          break;
        } else {
          await sendAccountLog(
            bot,
            chatId,
            acc,
            "❌ No appointments found. Retrying in 3 seconds..."
          );
          console.log("❌ No appointments found. Retrying in 3 seconds...");
        }
      } catch (err) {
        const errorMessage = `❗ Error while checking appointments: ${
          err instanceof Error ? err.message : String(err)
        }`;
        await sendAccountLog(bot, chatId, acc, errorMessage);
        console.error("❗ Error while checking appointments:", err);
      }

      attempts++;
      await sleep(3000);
      await page.reload({ waitUntil: "domcontentloaded" });
    }

    if (available.length === 0) {
      await sendAccountLog(
        bot,
        chatId,
        acc,
        "❌ No appointments available after all attempts. Exiting..."
      );
      return;
    }

    const selector = `#${available[0].btnId}`;
    await page.click(selector);
    console.log(
      `🚀 Clicked book for ${available[0].date} @ ${available[0].location}`
    );

    const clickedMessage = `🚀 Clicked book for ${available[0].date} @ ${available[0].location}`;
    await sendAccountLog(bot, chatId, acc, clickedMessage);

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });

    await detectBookingError(page).then((errorDetected) => {
      if (errorDetected) {
        console.error("❗ Booking error detected. Exiting...");
      }
    });

    await selectAllCheckboxes(page);
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
    console.log("✅ Filled out login form");
    await sendAccountLog(bot, chatId, acc, "✅ Filled out login form");

    // Submit the form
    await page.click('input[type="submit"][name="submit"]');
    console.log("🚀 Submitted login form");

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector('input[data-field-name="name"]', {
      visible: true,
    });
    await page.type('input[data-field-name="name"]', acc.firstName);
    await page.type('input[data-field-name="surname"]', acc.lastName);
    console.log("✅ Filled out name and surname");

    const day = acc.details.dob.day;
    await page.select(
      'select[name="accountPanel:basicData:body:dateBirth:daySelector"]',
      String(day - 1)
    );
    console.log("✅ Selected birth day");

    const month = acc.details.dob.month;
    const year = acc.details.dob.year;
    const yearValue = year - 1925;
    await page.evaluate((monthValue: number) => {
      const monthSelect = document.querySelector(
        'select[name="accountPanel:basicData:body:dateBirth:monthSelector"]'
      ) as HTMLSelectElement;
      if (monthSelect) {
        monthSelect.value = String(monthValue); // January
        monthSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, month - 1);
    console.log("✅ Selected birth month (first time)");

    await page.evaluate((year) => {
      const yearValue = document.querySelector(
        'select[name="accountPanel:basicData:body:dateBirth:yearSelector"]'
      ) as HTMLSelectElement;
      if (yearValue) {
        yearValue.value = String(year);
        yearValue.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, yearValue);
    console.log("✅ Selected birth year (first time)");

    await delay(1000);

    await page.evaluate((monthValue: number) => {
      const monthSelect = document.querySelector(
        'select[name="accountPanel:basicData:body:dateBirth:monthSelector"]'
      ) as HTMLSelectElement;
      if (monthSelect) {
        monthSelect.value = String(monthValue);
        monthSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, month - 1);
    console.log("✅ Selected birth month (second time)");

    await delay(1000);
    await page.evaluate((year) => {
      const yearValue = document.querySelector(
        'select[name="accountPanel:basicData:body:dateBirth:yearSelector"]'
      ) as HTMLSelectElement;
      if (yearValue) {
        yearValue.value = String(year);
        yearValue.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, yearValue);
    console.log("✅ Selected birth year (second time)");

    await page.click("button.cs-button--arrow_next");
    console.log('✅ Clicked "weiter" after DOB');

    await sendAccountLog(bot, chatId, acc, "✅ Filled out DOB form");

    /*   await page.waitForNavigation({
        waitUntil: "domcontentloaded",
        }); */

    await page.waitForSelector(
      "input[name='accountPanel:furtherData:body:postalCode:inputContainer:input']"
    );
    console.log("✅ Address form loaded");

    await page.type(
      "input[name='accountPanel:furtherData:body:postalCode:inputContainer:input']",
      acc.details.address.postalCode
    );
    await page.type(
      "input[name='accountPanel:furtherData:body:city:inputContainer:input']",
      acc.details.address.city
    );
    await page.type(
      "input[name='accountPanel:furtherData:body:street:inputContainer:input']",
      acc.details.address.street
    );
    await page.type(
      "input[name='accountPanel:furtherData:body:houseNo:inputContainer:input']",
      acc.details.address.houseNo
    );
    await page.type(
      "input[name='accountPanel:furtherData:body:mobilePhone:input2Container:input2']",
      acc.details.phone.number
    );

    const placeOfBirthInput = await page.$(
      "input[name='accountPanel:furtherData:body:birthplace:inputContainer:input']"
    );

    if (placeOfBirthInput) {
      await placeOfBirthInput.type(acc.details.address.city);
    }

    const motivationSelect = await page.$("select#id4d");

    if (motivationSelect) {
      await page.evaluate(() => {
        const motivationValue = document.querySelector(
          "select#id4d"
        ) as HTMLSelectElement;
        if (motivationValue) {
          motivationValue.value = "BookingReasonOther";
          motivationValue.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    }
    console.log("✅ Filled out contact details");
    await sendAccountLog(bot, chatId, acc, "✅ Filled out contact details");


    await page.click("button.cs-button--arrow_next");
    console.log('✅ Clicked "Next Button" after address');

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });

    console.log("✅ Navigated to payment page");
    await sendAccountLog(bot, chatId, acc, "✅ Navigate to the payment page");


    await page.click("button.cs-button--arrow_next");

    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
    });

    await sendAccountLog(bot, chatId, acc, "✅ Appointment booked successfully!");
    

    return 
  } catch (err) {
    console.error("Error in startBooking:", err);
  }
};

export default startBooking;
