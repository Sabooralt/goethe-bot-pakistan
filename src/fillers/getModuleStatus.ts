import { Page } from "playwright-core";

export type ModuleKey = "read" | "hear" | "write" | "speak";
export type ModuleSchema = Record<ModuleKey, boolean>;

const MODULE_SELECTORS: Record<ModuleKey, string> = {
    read: 'input[id=" reading "]',
    hear: 'input[id=" listening "]',
    write: 'input[id=" writing "]',
    speak: 'input[id=" speaking "]',
};

export async function getModuleStatus(
    page: Page
): Promise<ModuleSchema> {
    const status: ModuleSchema = {
        read: false,
        hear: false,
        write: false,
        speak: false,
    };

    for (const key of Object.keys(status) as ModuleKey[]) {
        const checkbox = page.locator(MODULE_SELECTORS[key]);

        if ((await checkbox.count()) === 0) {
            continue;
        }

        status[key] = !(await checkbox.isDisabled());
    }

    return status;
}