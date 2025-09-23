import { Page } from "puppeteer";
import { Account } from "../types";
import { AccountDocument } from "../models/accountSchema";

async function typeIfEmpty(page: Page, selector: string, value: string) {
  const element = await page.$(selector);
  if (!element) return;

  const existingValue = await page.$eval(selector, (el: any) =>
    el.value.trim()
  );

  if (existingValue && existingValue.length > 0) {
    console.log(
      `ℹ️ Skipping ${selector}, already filled with "${existingValue}"`
    );
    return;
  }

  await page.type(selector, value);
  console.log(`✅ Filled ${selector} with "${value}"`);
}

export const submitAddressForm = async (page: Page, acc: AccountDocument) => {
  const addressForm = await page.$(
    "input[name='accountPanel:furtherData:body:postalCode:inputContainer:input']"
  );

  if (!addressForm) {
    console.log("ℹ️ Address form not present, skipping...");
    return;
  }
  console.log("✅ Address form loaded");

  await typeIfEmpty(
    page,
    "input[name='accountPanel:furtherData:body:postalCode:inputContainer:input']",
    acc.details.address.postalCode
  );
  await typeIfEmpty(
    page,
    "input[name='accountPanel:furtherData:body:city:inputContainer:input']",
    acc.details.address.city
  );
  await typeIfEmpty(
    page,
    "input[name='accountPanel:furtherData:body:street:inputContainer:input']",
    acc.details.address.street
  );
  await typeIfEmpty(
    page,
    "input[name='accountPanel:furtherData:body:houseNo:inputContainer:input']",
    acc.details.address.houseNo
  );
  await typeIfEmpty(
    page,
    "input[name='accountPanel:furtherData:body:mobilePhone:input2Container:input2']",
    acc.details.phone.number
  );

  const placeOfBirthInput = await page.$(
    "input[name='accountPanel:furtherData:body:birthplace:inputContainer:input']"
  );
  if (placeOfBirthInput) {
    const existingBirthplace = await page.$eval(
      "input[name='accountPanel:furtherData:body:birthplace:inputContainer:input']",
      (el: any) => el.value.trim()
    );

    if (!existingBirthplace) {
      await placeOfBirthInput.type(acc.details.address.city);
      console.log(`✅ Filled birthplace with "${acc.details.address.city}"`);
    } else {
      console.log(`ℹ️ Skipping birthplace, already "${existingBirthplace}"`);
    }
  }

  const motivationSelect = await page.$("select#id4d");
  if (motivationSelect) {
    await page.evaluate(() => {
      const motivationValue = document.querySelector(
        "select#id4d"
      ) as HTMLSelectElement;
      if (motivationValue && !motivationValue.value) {
        motivationValue.value = "BookingReasonOther";
        motivationValue.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    console.log("✅ Set motivation select to BookingReasonOther");
  }
};
