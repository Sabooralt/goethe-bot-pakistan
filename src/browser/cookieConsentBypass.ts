import { Page } from "playwright-core";

export const CookieConsentBypass = async (page: Page, status: boolean) => {

    if (!status) {
        return;
    }
    await page.addInitScript(() => {
        localStorage.setItem(
            "uc_gcm",
            JSON.stringify({
                adsDataRedaction: true,
                adPersonalization: "denied",
                adStorage: "denied",
                adUserData: "denied",
                analyticsStorage: "denied",
            })
        );

        localStorage.setItem("uc_ui_version", "3.73.0");
        localStorage.setItem("uc_user_interaction", "true");

        localStorage.setItem(
            "uc_settings",
            JSON.stringify({
                controllerId:
                    "42e213448633d19d017343f77368ef4ab462b0ca1fb10607c313393260b08f21",
                id: "rTbKQ4Qc-",
                services: [],
            })
        );
    });
};