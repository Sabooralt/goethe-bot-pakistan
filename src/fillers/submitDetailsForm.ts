import { Page } from "puppeteer";
import { AccountDocument } from "../models/accountSchema";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const submitDetailsForm = async (page: Page, acc: AccountDocument) => {
  const inputNameField = await page.$('input[data-field-name="name"]');

  if (!inputNameField) {
    console.log("ℹ️ Contact form not present, skipping...");
    return;
  }

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

  return;
};
