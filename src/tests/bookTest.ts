import dotenv from "dotenv";
import {Camoufox ,LaunchOptions} from "camoufox"
import { enginePath, launchStealthContext, stealthPrefs, writeProfile } from "../helper/stealth";

dotenv.config();

const startBooking = async (browserNumber: number = 2) => {
  const oid = process.env.TEST_OID;

  if (!oid) {
    throw new Error("TEST_OID is missing from .env");
  }

  const bookingUrl = `https://goethe.de/coe/?lang=en&oid=${oid}`;
  const seed = Math.floor(Math.random() * 1_000_000);

  const args: LaunchOptions = {
    headless: false,
    geoip: true,
    os: "linux",
    humanize: 1.5,

    env: {
      DISPLAY: `:${browserNumber}`,
    },
  };
  const browser = await Camoufox(args);

  


  

  const page = await browser.newPage();

 

  

  let response;

  try {
    response = await page.goto(bookingUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch (error) {
    console.error("\n❌ NAVIGATION ERROR");

    console.error(error);
  }




  
 
};

startBooking(2).catch((error) => {
  console.error(error);
  process.exit(1);
});
