import { Page } from "puppeteer";
const detectBookingError = async (page: Page): Promise<boolean> => {
  try {
    await page.waitForSelector(
      "main.cs-checkout .cs-layer__text.cs-layer__text--error",
      { visible: true, timeout: 3000 }
    );
    return true; 
  } catch {
    return false; 
  }
};

export default detectBookingError;