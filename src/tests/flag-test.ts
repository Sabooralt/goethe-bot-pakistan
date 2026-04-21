import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


async function test() {
    const browser = await puppeteer.launch({
        headless: false,
        env: { DISPLAY: ':1' },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',

            // Remove --disable-gpu and replace with software rendering
            '--use-gl=swiftshader',         // software WebGL — fixes WebGL red flags
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            '--use-angle=swiftshader-webgl',

            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-default-apps',
            '--disable-background-networking',
            '--disable-breakpad',
            '--disable-client-side-phishing-detection',
            '--disable-sync',
            '--force-color-profile=srgb',
            '--mute-audio',
            '--disable-extensions',
            '--disable-popup-blocking',

        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    // Test 1 — sannysoft
    console.log('Running sannysoft test...');
    await page.goto('https://bot.sannysoft.com', { waitUntil: 'networkidle0' });
    await delay(2000);
    console.log('✅ test1.png saved');

    // Test 2 — manual checks
    const results = await page.evaluate(() => ({
        webdriver: (navigator as any).webdriver,
        platform: navigator.platform,
        languages: navigator.languages,
        plugins: navigator.plugins.length,
        chrome: !!(window as any).chrome,
        userAgent: navigator.userAgent,
    }));

    console.log('\n--- Navigator ---');
    console.log('webdriver:', results.webdriver === undefined ? '✅ hidden' : '❌ ' + results.webdriver);
    console.log('platform:', results.platform);
    console.log('languages:', results.languages);
    console.log('plugins:', results.plugins > 0 ? '✅ ' + results.plugins : '❌ none');
    console.log('chrome:', results.chrome ? '✅ present' : '❌ missing');
    console.log('userAgent:', results.userAgent);

    // Test 3 — Goethe



}

test().catch(console.error);