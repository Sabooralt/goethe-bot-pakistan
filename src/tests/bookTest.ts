import dotenv from "dotenv";
import { proxyPool, USE_PROXIES } from "../proxyPool";
import { Camoufox, LaunchOptions } from "camoufox-js";
import { getProxyIp } from "./getIp";
import { getModuleStatus, ModuleKey } from "../fillers/getModuleStatus";
import { CookieConsentBypass } from "../browser/cookieConsentBypass";
import { selectModules } from "../fillers/selectModules";

dotenv.config();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startBooking = async (browserNumber: number = 2) => {
  const proxyHost = process.env.GERMANY_PROXY_HOST!;
  const username = process.env.GERMANY_PROXY_USERNAME;
  const password = process.env.GERMANY_PROXY_PASSWORD;

  const MOCK_ACCOUNT = {
    email: "abdulsaboormillwala123@gmail.com",
    password: "Consolidation@340",
    modules: {
      hear: false,
      speak: false,
      write: true,
      read: false,
    }
  }



  const oid = process.env.TEST_OID;

  const bookingUrl = `https://goethe.de/coe/entry?oid=${oid}`;

  const args: LaunchOptions = {
    os: "windows",
    geoip: true,
    humanize: 1.5,
    locale: ["en-US", "en-GB"],
    block_images: false,
    block_webrtc: true,
    screen: {
      minWidth: 1024,
      maxWidth: 1920,
      minHeight: 768,
      maxHeight: 1080,
    },
    enable_cache: true,
    headless: false,
    proxy: {
      server: proxyHost,
      username: username,
      password: password,
    },
    fonts: ["Arial", "Times New Roman"],
    env: {
      DISPLAY: `:${browserNumber}`,
    },
  };

  const browser = await Camoufox(args);

  console.log("Browser opened!");


  const context1 = await browser.newContext({
    extraHTTPHeaders: { Connection: "close" },
  });
  const page = await context1.newPage();

  await CookieConsentBypass(page, true)
  await page.goto(bookingUrl);

  console.log("Url Reached!");
  const availableModules = await getModuleStatus(page);

  console.log(availableModules);

  const allRequiredAvailable = Object.entries(MOCK_ACCOUNT.modules).every(
    ([key, required]) => !required || availableModules[key as ModuleKey]
  );

  if (!allRequiredAvailable) {
    console.log("Required modules not available!")
    await delay(7200000);
    return;
  }

  await selectModules(page, MOCK_ACCOUNT.modules);

  console.log("Modules selected!");
}

startBooking();
