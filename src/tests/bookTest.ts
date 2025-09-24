import puppeteer, { Page } from "puppeteer";

interface AccountModules {
  read: boolean;
  hear: boolean;
  write: boolean;
  speak: boolean;
}

const selectAvailableModules = async (page: Page, modules: AccountModules) => {
  try {
    await page.waitForSelector("input.cs-checkbox__input", { timeout: 5000 });

    const unavailableModules = await page.$$eval(
      "input.cs-checkbox__input",
      (checkboxes: HTMLInputElement[], modules: AccountModules) => {
        const moduleMapping: { [key: string]: boolean } = {
          reading: modules.read,
          listening: modules.hear,
          writing: modules.write,
          speaking: modules.speak,
        };

        const notAvailable: string[] = [];

        checkboxes.forEach((checkbox) => {
          const moduleId = checkbox.id.trim().toLowerCase(); // "reading", "listening", etc.
          if (moduleMapping[moduleId]) {
            if (!checkbox.disabled) {
              if (!checkbox.checked) checkbox.click();
            } else {
              notAvailable.push(moduleId);
            }
          }
        });

        return notAvailable;
      },
      modules
    );

    if (unavailableModules.length > 0) {
      console.log(
        `⚠️ Some required modules are fully booked: ${unavailableModules.join(
          ", "
        )}`
      );
    } else {
      console.log("✅ All required modules selected successfully.");
    }
  } catch (err) {
    console.log("ℹ️ No checkboxes found or available to select.");
  }
};

const run = async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  const url =
    "https://goethe.de/coe?lang=en&oid=3085ec9e114b04d3f051fd379fd7de77c60c9d0c93b01270f8390db66e41fb90"; // Replace with your website

  await page.goto(url, { waitUntil: "networkidle2" });

  // Example account modules
  const accountModules: AccountModules = {
    read: true,
    hear: true,
    write: true,
    speak: true,
  };

  await selectAvailableModules(page, accountModules);

  // Optional: proceed to booking/submit
  // await page.click('#submit-button');

  // await browser.close();
};

run().catch(console.error);
