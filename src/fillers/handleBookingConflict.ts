import { Page } from "playwright-core";

export const handleBookingConflict = async (
  page: Page
): Promise<boolean> => {
  try {
    const overlay = page
      .locator(".cs-overlay__container")
      .filter({
        hasText: "Another booking session you initiated is still active.",
      });

    if (await overlay.count() === 0) {
      return false;
    }

    if (!(await overlay.isVisible())) {
      return false;
    }

    console.log(
      "⚠️ Booking conflict detected, discarding other booking..."
    );

    const discardOtherButton = overlay.getByRole("button", {
      name: "Discard other booking",
      exact: true,
    });

    await discardOtherButton.click();

    await overlay.waitFor({
      state: "hidden",
      timeout: 15000,
    });

    console.log("✅ Other booking discarded");

    return true;
  } catch (error: any) {
    console.error(
      "❌ Error handling booking conflict:",
      error?.message || error
    );

    return false;
  }
};