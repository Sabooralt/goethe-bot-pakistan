import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { execSync } from "child_process";

puppeteer.use(StealthPlugin());

const TARGET_URL = "https://www.goethe.de/ins/pk/en/spr/prf/gzb2.cfm";
const API_URL = "https://www.goethe.de/rest/examfinder/exams/institute/O%2010000366?category=E005&type=ER&countryIsoCode=pk&locationName=&count=10&start=1&langId=1&timezone=47&isODP=0&sortField=startDate&sortOrder=ASC&dataMode=0&langIsoCodes=en";

const PROXY_HOST = process.env.GERMANY_PROXY_HOST;
const PROXY_USER = process.env.GERMANY_PROXY_USERNAME;
const PROXY_PASS = process.env.GERMANY_PROXY_PASSWORD;

const test = async () => {
  console.log("Step 1: Launching browser to get Akamai cookies...");

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: "/usr/bin/google-chrome",
    userDataDir: "./profile_test",
    env: { DISPLAY: ":2" },
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      ...(PROXY_HOST ? [`--proxy-server=${PROXY_HOST}`] : []),
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();

  if (PROXY_USER && PROXY_PASS) {
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
  }

  console.log("Navigating to Goethe page...");
  await page.goto(TARGET_URL, { waitUntil: "networkidle0", timeout: 30000 });

  // Extract all cookies
  const cookies = await page.cookies();
  console.log(`\nExtracted ${cookies.length} cookies:`);
  cookies.forEach(c => console.log(`  ${c.name}=${c.value.substring(0, 30)}...`));

  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join("; ");

  await browser.close();
  console.log("\nBrowser closed");
  console.log("─".repeat(50));

  // Step 2: Test curl-impersonate with cookies
  console.log("Step 2: Testing curl-impersonate with extracted cookies...");

  const proxyArg = PROXY_HOST && PROXY_USER && PROXY_PASS
    ? `-x "http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}"`
    : "";

  try {
    const result = execSync(
      `curl-impersonate-chrome \
        -H "Accept: application/json, text/plain, */*" \
        -H "Accept-Language: en-US,en;q=0.9,de;q=0.8" \
        -H "Cache-Control: no-cache" \
        -H "Referer: ${TARGET_URL}" \
        -H "Sec-Fetch-Dest: empty" \
        -H "Sec-Fetch-Mode: cors" \
        -H "Sec-Fetch-Site: same-origin" \
        -H "Cookie: ${cookieString}" \
        ${proxyArg} \
        "${API_URL}"`,
      { maxBuffer: 1024 * 1024 }
    ).toString();

    console.log("─".repeat(50));
    try {
      const data = JSON.parse(result) as any;
      console.log("✅ SUCCESS");
      console.log(`DATA entries: ${data?.DATA?.length ?? "N/A"}`);
      console.log(`First entry: ${JSON.stringify(data?.DATA?.[0])?.substring(0, 200)}`);
    } catch {
      console.log("❌ Response is not JSON:");
      console.log(result.substring(0, 500));
    }
  } catch (error) {
    console.log("❌ curl-impersonate error:", (error as Error).message);
  }
};

test().catch(console.error);