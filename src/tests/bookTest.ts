import dotenv from "dotenv";
import {Camoufox ,LaunchOptions} from "camoufox"

dotenv.config();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


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

  


  
const context = await browser.newContext();


  const page = await context.newPage();




 console.log("1st Context opened!");

 await page.goto(bookingUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
 
 await delay(7000);
 await context.close(); 

 console.log("1st Context closed!");

 await browser.newContext();

 console.log("new context launched!");

 const newPage = await browser.newPage();

 await newPage.goto(bookingUrl,{waitUntil: "domcontentloaded"});

 console.log("navigated in new context")




  

  




  
 
};

startBooking(2).catch((error) => {
  console.error(error);
  process.exit(1);
});
