import { Page } from "playwright-core";
import type TelegramBot from "node-telegram-bot-api";
import path from "path";
import fs from "fs/promises";




export async function notifyBookingCompleted(
    page: Page,
    bot: TelegramBot,
    chatId: string,
    identifier: string,
): Promise<void> {
    try {
        const message =
            `🎯 *Booking Completed*\n\n` +
            `👤 ${identifier}\n`


        await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

        const screenshotDir = path.join(process.cwd(), "screenshots");
        await fs.mkdir(screenshotDir, { recursive: true });
        const screenshotPath = path.join(
            screenshotDir,
            `booking-${identifier.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}.png`
        );

        await page.screenshot({ path: screenshotPath as `${string}.png`, fullPage: true });
        await bot.sendPhoto(chatId, screenshotPath);

        console.log(`[notifyBookingCompleted] Sent booking completed notification + screenshot to ${chatId}`);
    } catch (error) {
        console.error("[notifyBookingCompleted] Failed to send notification:", error);
    }
}