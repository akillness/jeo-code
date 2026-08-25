// playwriter-apply.ts
// ------------------------------------------------------------
// Playwriter automation script for filling out job application forms.
// ------------------------------------------------------------
// This script demonstrates how to reuse a running Chrome/Chromium
// session (via the Playwriter Chrome extension) to automate two
// application pages:
//   1. Hyundai Talent: https://talent.hyundai.com/apply/applyWrite.hc?recuYy=2026&recuType=N2&recuCls=220&returnType=my
//   2. Hanwha IN: https://www.hanwhain.com/portal/apply/recruit/apply/19169/2288208
//
// The script assumes you have already installed the Playwriter CLI
// (`npm install -g playwriter` or `npx playwriter@latest`) and the
// Playwriter Chrome extension is active on the target tabs.
//
// Usage:
//   $ npx playwriter@latest run scripts/playwriter-apply.ts
//
// The script will:
//   • Connect to the running browser session.
//   • Open each URL in a new tab (or reuse an existing one).
//   • Wait for the page to load.
//   • Fill in form fields based on placeholders you replace with
//     your actual career details.
//   • Optionally submit the form.
//
// IMPORTANT: Replace the placeholder selectors (e.g., "#name", "#experience")
// with the actual CSS selectors or XPath expressions that correspond to
// the input elements on the target pages. You can inspect the page in
// Chrome DevTools to find these selectors.
// ------------------------------------------------------------

import { Playwriter } from "playwriter";

// -----------------------------------------------------------------
// Helper: fill a field if it exists.
// -----------------------------------------------------------------
async function fillField(page: any, selector: string, value: string) {
  const element = await page.$(selector);
  if (element) {
    await element.focus();
    await page.evaluate((el) => (el.value = ""), element); // clear
    await page.type(selector, value);
    console.log(`Filled ${selector}`);
  } else {
    console.warn(`Selector not found: ${selector}`);
  }
}

// -----------------------------------------------------------------
// Main automation flow.
// -----------------------------------------------------------------
(async () => {
  // Connect to the running Chrome instance.
  const pw = new Playwriter();
  await pw.connect(); // connects to the extension bridge

  // -------------------------------------------------------------
  // 1. Hyundai Talent application
  // -------------------------------------------------------------
  const hyundaiUrl =
    "https://talent.hyundai.com/apply/applyWrite.hc?recuYy=2026&recuType=N2&recuCls=220&returnType=my";
  const hyundaiPage = await pw.newPage();
  await hyundaiPage.goto(hyundaiUrl, { waitUntil: "networkidle2" });

  // TODO: Replace the selectors below with the actual ones from the page.
  // Example placeholders – fill with your own career details.
  await fillField(hyundaiPage, "#applicantName", "<YOUR_FULL_NAME>");
  await fillField(hyundaiPage, "#email", "<YOUR_EMAIL>");
  await fillField(hyundaiPage, "#phone", "<YOUR_PHONE>");
  await fillField(
    hyundaiPage,
    "#careerSummary",
    "<SUMMARY_OF_YOUR_DETAILED_CAREER>",
  );
  // Add more fields as needed, following the same pattern.

  // Optionally submit the form (uncomment if you want to auto‑submit).
  // const submitBtn = await hyundaiPage.$("#submitButton");
  // if (submitBtn) await submitBtn.click();

  // -------------------------------------------------------------
  // 2. Hanwha IN application
  // -------------------------------------------------------------
  const hanwhaUrl =
    "https://www.hanwhain.com/portal/apply/recruit/apply/19169/2288208";
  const hanwhaPage = await pw.newPage();
  await hanwhaPage.goto(hanwhaUrl, { waitUntil: "networkidle2" });

  // TODO: Replace selectors for Hanwha IN form fields.
  await fillField(hanwhaPage, "#applicantName", "<YOUR_FULL_NAME>");
  await fillField(hanwhaPage, "#email", "<YOUR_EMAIL>");
  await fillField(hanwhaPage, "#phone", "<YOUR_PHONE>");
  await fillField(
    hanwhaPage,
    "#careerDetails",
    "<YOUR_DETAILED_CAREER_INFORMATION>",
  );

  // Optionally submit the Hanwha form.
  // const hanwhaSubmit = await hanwhaPage.$("#submitBtn");
  // if (hanwhaSubmit) await hanwhaSubmit.click();

  console.log("Automation script completed. Review the pages and submit manually if needed.");
  // Keep the browser open for manual review; close when done.
  // await pw.disconnect();
})();

// ------------------------------------------------------------
// End of playwriter-apply.ts
// ------------------------------------------------------------
