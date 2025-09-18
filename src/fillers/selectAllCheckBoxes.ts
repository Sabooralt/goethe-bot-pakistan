import { Page } from "puppeteer";

const selectAllCheckboxes = async (page: Page) => {
  try {
    await page.waitForSelector('input[type="checkbox"]', { timeout: 3000 });

    const checkboxCount = await page.$$eval(
      'input[type="checkbox"]',
      (checkboxes: HTMLInputElement[]) => {
        let count = 0;
        checkboxes.forEach((checkbox) => {
          if (!checkbox.disabled && !checkbox.checked) {
            checkbox.click();
            count++;
          }
        });
        return count;
      }
    );

    console.log(`✅ Selected ${checkboxCount} checkbox(es).`);
  } catch (err) {
    console.log("ℹ️ No checkboxes found or available to select.");
  }
};

export default selectAllCheckboxes;