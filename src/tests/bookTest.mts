import dotenv from "dotenv";
import { AkamaiClient } from "@proofofbot/client-akamai";

dotenv.config();

const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const startBooking = async (browserNumber: number = 2) => {
  const proxyHost = process.env.GERMANY_PROXY_HOST!;
  const username = process.env.GERMANY_PROXY_USERNAME;
  const password = process.env.GERMANY_PROXY_PASSWORD;

  const auth = Buffer.from(
    `${username}:${password}`
  ).toString("base64");

  const bookingUrl = process.env.URL!;

  if (!bookingUrl) {
    throw new Error("URL is not defined");
  }

  console.log("=================================");
  console.log("Starting Akamai session");
  console.log("Target:", bookingUrl);
  console.log("Proxy:", proxyHost);
  console.log("=================================");

  /*
   * -------------------------------------------------------
   * AKAMAI CLIENT
   * -------------------------------------------------------
   */

  const akamai = await AkamaiClient.open({
    page_url: bookingUrl,
  });

  try {
    console.log("[AKAMAI] Solving...");

    const solved = await akamai.solve({});

    console.log("[AKAMAI] Solved");
    console.dir(solved, {
      depth: null,
    });

    /*
     * The package exposes the cookies belonging to the
     * Akamai session.
     *
     * In particular, the docs expose:
     *
     * solved.cookies.abck
     */

    console.log(
      "[AKAMAI] Cookies:"
    );

    console.dir(solved.cookies, {
      depth: null,
    });

    /*
     * -------------------------------------------------------
     * Inspect the page that Akamai actually loaded
     * -------------------------------------------------------
     */

    const akamaiPage = await akamai.page();

    console.log(
      "[AKAMAI] Page URL:",
      akamaiPage.url
    );

    console.log(
      "[AKAMAI] Fields:",
      akamaiPage.fields
    );

  } catch (error) {
    console.error(
      "[AKAMAI ERROR]",
      error
    );

    throw error;
  } finally {
    /*
     * Important:
     * Don't close the Akamai client until you're finished
     * using its session.
     */
    await akamai.close();

    console.log(
      "[AKAMAI] Session closed"
    );
  }
};

startBooking().catch((error) => {
  console.error(
    "[FATAL]",
    error
  );

  process.exit(1);
});