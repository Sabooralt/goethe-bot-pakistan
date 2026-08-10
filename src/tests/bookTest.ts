import dotenv from "dotenv";
import { proxyPool, USE_PROXIES } from "../proxyPool";
import { Camoufox, LaunchOptions } from "camoufox-js";
import { getProxyIp } from "./getIp";

dotenv.config();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const testProxyRotation = async (browserNumber: number = 2) => {
  const proxyHost = "p.webshare.io:80";
  const username = "gzeckesj-rotate";
  const password = "ooi25in29758";

  let proxy: any = null;
  let proxyUrl = "";
  if (USE_PROXIES) {
    proxy = proxyPool.getNextProxy();
    if (proxy) {
      proxyUrl = `${proxy.host}:${proxy.port}`;
      console.log(`[proxy] Proxy ${proxyUrl} → Browser ${browserNumber}`);
    }
  }

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

  console.log("\n=== TEST 1: Same context, repeated requests ===");
  console.log("Purpose: baseline — confirm IP is stable within a single context.\n");

  const context1 = await browser.newContext({
    extraHTTPHeaders: { Connection: "close" },
  });
  const page1 = await context1.newPage();

  const ipsWithinContext1: string[] = [];
  for (let i = 0; i <= 2; i++) {
    const ip = await getProxyIp(page1);
    console.log(`[Context 1 | Request ${i}] IP: ${ip}`);
    ipsWithinContext1.push(ip);
    await delay(1000);
  }

  await context1.close();
  console.log("[Context 1] Closed.\n");

  console.log("=== TEST 2: New context, no proxy override ===");
  console.log("Purpose: does closing + reopening a context alone rotate the IP?\n");

  const context2 = await browser.newContext({
    extraHTTPHeaders: { Connection: "close" },
  });
  const page2 = await context2.newPage();

  const ip2 = await getProxyIp(page2);
  console.log(`[Context 2 | after reopen, no proxy override] IP: ${ip2}`);

  await context2.close();
  console.log("[Context 2] Closed.\n");

  console.log("=== TEST 3: New context, explicit proxy override ===");
  console.log("Purpose: does Camoufox/Playwright even accept a context-level");
  console.log("proxy override that differs from the launch-level one?\n");

  let context3;
  let proxyOverrideAccepted = true;
  try {
    context3 = await browser.newContext({
      extraHTTPHeaders: { Connection: "close" },
      proxy: {
        server: proxyHost,
        username: `${username}-sess${Date.now()}`, // force new session if provider supports it
        password: password,
      },
    });
  } catch (err) {
    proxyOverrideAccepted = false;
    console.log(`[Context 3] newContext() with proxy override threw: ${(err as Error).message}`);
    context3 = await browser.newContext({
      extraHTTPHeaders: { Connection: "close" },
    });
  }

  const page3 = await context3.newPage();
  const ip3 = await getProxyIp(page3);
  console.log(`[Context 3 | explicit proxy override, new session id] IP: ${ip3}`);

  await context3.close();
  console.log("[Context 3] Closed.\n");

  console.log("=== RESULTS ===");
  console.log(`Context 1 IPs (should be identical to each other): ${ipsWithinContext1.join(", ")}`);
  console.log(`Context 1 → Context 2 (no override) changed?      ${ipsWithinContext1[0] !== ip2}`);
  console.log(`Context 1 → Context 3 (explicit override) changed? ${ipsWithinContext1[0] !== ip3}`);
  console.log(`Context-level proxy override accepted without error: ${proxyOverrideAccepted}`);

  const withinContextStable = new Set(ipsWithinContext1).size === 1;
  console.log(`\nIP stable within a single context: ${withinContextStable}`);

  if (!withinContextStable) {
    console.log("⚠️ IP changed even within the SAME context — your proxy endpoint");
    console.log("   rotates per-request regardless of context/session, which changes");
    console.log("   the whole strategy (you don't need context recreation to rotate at all).");
  } else if (ipsWithinContext1[0] !== ip2) {
    console.log("✅ Closing/reopening context (no proxy override) DOES rotate the IP.");
    console.log("   Your existing recreateContext() approach is sufficient — no need");
    console.log("   to touch context-level proxy config.");
  } else {
    console.log("❌ Closing/reopening context alone did NOT rotate the IP.");
    console.log("   Your proxy is sticky at the connection/session level tied to the");
    console.log("   browser process. You'll need explicit per-context proxy override");
    console.log(`   (worked: ${proxyOverrideAccepted}) or a full browser relaunch to rotate.`);
  }

  await browser.close();
};

testProxyRotation(2);