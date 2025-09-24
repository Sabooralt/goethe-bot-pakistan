import { Page } from "puppeteer";

interface AccountModules {
  read: boolean;
  hear: boolean;
  write: boolean;
  speak: boolean;
}

export const selectAvailableModules = async (
  page: Page,
  modules: AccountModules
) => {
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
          const moduleId = checkbox.id.trim().toLowerCase();
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

      return false;
    } else {
      console.log("✅ All required modules selected successfully.");
      return true
    }
  } catch (err) {
    console.log("ℹ️ No checkboxes found or available to select.");
    return false
  }
};
