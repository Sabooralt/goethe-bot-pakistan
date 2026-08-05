import { Page, Locator } from "playwright-core";
import { ModuleKey, ModuleSchema } from "./getModuleStatus";

const MODULE_SELECTORS: Record<ModuleKey, string> = {
    read: 'input[id=" reading "]',
    hear: 'input[id=" listening "]',
    write: 'input[id=" writing "]',
    speak: 'input[id=" speaking "]',
};

async function uncheck(checkbox: Locator) {
    await checkbox.evaluate((el: HTMLInputElement) => {
        el.checked = false;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

export async function selectModules(
    page: Page,
    desired: ModuleSchema
): Promise<void> {
    for (const key of Object.keys(desired) as ModuleKey[]) {
        const checkbox = page.locator(MODULE_SELECTORS[key]);

        if ((await checkbox.count()) === 0) continue;
        if (await checkbox.isDisabled()) continue;

        if (!desired[key] && (await checkbox.isChecked())) {
            await uncheck(checkbox);
        }
    }
}