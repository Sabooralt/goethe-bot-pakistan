import puppeteer from "puppeteer";
import fs from "fs";

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Intercept network requests
  page.on("response", async (response) => {
    const url = response.url();

    // Check if it's the API endpoint you care about
    if (url.includes("examfinderv3/exams/institute")) {
      try {
        const data = await response.json();

        const filename = `goethe-api-${
          new Date().toISOString().split("T")[0]
        }.json`;
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));

        console.log(`✅ Saved API response to ${filename}`);
      } catch (err) {
        console.error("Failed to parse response:", err);
      }
    }
  });

  // Navigate to the Goethe exam finder webpage
  await page.goto("https://www.goethe.de/ins/in/en/spr/prf/gzb2.cfm", {
    waitUntil: "networkidle2",
  });

  await new Promise((res) => setTimeout(res, 5000));

  await browser.close();
})();
