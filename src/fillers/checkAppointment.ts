import puppeteer, { Page } from "puppeteer";
import { Slot } from "../types";

const checkAppointments = async (page: Page) => {
  const available = await page.$$eval("table.pr-finder tbody tr", (rows) => {
   
    const slots: Slot[] = [];
    let currentDate = "";

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as HTMLTableRowElement;

      // a) Date header row
      const dateHdr = row.querySelector("h5.pr-datum");
      if (dateHdr) {
        currentDate = dateHdr.textContent?.trim() || "";
        continue;
      }

      // b) Detail row with possible button
      const btn = row.querySelector(
        "button.btnGruen:not([disabled])"
      ) as HTMLButtonElement;
      if (btn) {
        const location =
          row.querySelector(".pr-ort-text")?.textContent?.trim() ?? "";
        const price = row.querySelector(".pr-preis")?.textContent?.trim() ?? "";
        slots.push({
          date: currentDate,
          location,
          price,
          btnId: btn.id,
        });
      }
    }

    return slots;
  });

  return available;
};

export default checkAppointments;
