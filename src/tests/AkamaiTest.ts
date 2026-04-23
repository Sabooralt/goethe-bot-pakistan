import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();
puppeteer.use(StealthPlugin());

async function run() {
    const proxyHost = process.env.GERMANY_PROXY_HOST;
    const username = process.env.GERMANY_PROXY_USERNAME;
    const password = process.env.GERMANY_PROXY_PASSWORD;

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: "/usr/bin/google-chrome",
        userDataDir: "./profile",
        env: {
            display: ":2",
        },
        args: [
            `--proxy-server=${proxyHost}`,
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--display=:2",

        ],
        defaultViewport: null,
    });

    const page = await browser.newPage();

    // Proxy authentication

    if (username && password) {
        await page.authenticate({
            username: username,
            password: password,
        })
    }


    const width = 1920 + Math.floor(Math.random() * 120);
    const height = 1080 + Math.floor(Math.random() * 80);
    await page.setViewport({ width, height });


    const url = "https://www.goethe.de/ins/pk/en/spr/prf/gzsd2.cfm";

    console.log("[browser] Opening page...");
    await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 60000,
    });

    console.log("[browser] Page loaded");

    // Give time for JS challenges (important for Akamai-like systems)
    await new Promise((res) => setTimeout(res, 8000));

    // Extract cookies
    const cookies = await page.cookies();

    fs.writeFileSync(
        "./cookies.json",
        JSON.stringify(cookies, null, 2)
    );

    console.log("[cookies] saved to cookies.json");

    // Example: call API from inside browser context
    /*  const data = await page.evaluate(async () => {
         const res = await fetch(
             "/rest/examfinder/exams/institute/O%2010000366?category=E007&type=ER&countryIsoCode=pk&count=10&start=1",
             {
                 credentials: "include",
             }
         );
         return res.json();
     });
 
     console.log("[api response]", data); */


}

run();