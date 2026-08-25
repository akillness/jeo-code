#!/usr/bin/env bun

import { chromium, type Browser, type Page } from "playwright";
import * as fs from "node:fs";

const DATA_URI =
  "data:text/html," +
  encodeURIComponent(
    `<!doctype html><html><body><h1>jeo browser verification</h1><p>local data URI smoke check</p></body></html>`,
  );

class VerificationFailure extends Error {
  constructor(
    public readonly hint: string,
    message: string,
  ) {
    super(message);
    this.name = "VerificationFailure";
  }
}

function failWithHint(detail: string, hint: string): never {
  throw new VerificationFailure(hint, detail);
}

function looksLikeMissingChromium(detail: string): boolean {
  return /(ENOENT|not.?found|no such file|executable|Could not find.*browser|failed to launch|launching browser|is not installed|incompatible|is not a valid executable)/i.test(
    detail,
  );
}

async function main(): Promise<void> {
  const executable = chromium.executablePath();
  if (!executable) {
    failWithHint(
      "Playwright reported no Chromium executable path.",
      "Run `bunx playwright install --with-deps chromium` and rerun this check.",
    );
  }
  if (!fs.existsSync(executable)) {
    failWithHint(
      `Expected Chromium binary at ${executable}, but it does not exist.`,
      "Run `bunx playwright install --with-deps chromium` and rerun this check.",
    );
  }

  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(DATA_URI, { waitUntil: "load" });
    const heading = await page.locator("h1").textContent();
    if (heading !== "jeo browser verification") {
      failWithHint(
        `data: URI rendered unexpected content: ${heading ?? "(missing heading)"}.`,
        "Verify Chromium started correctly and can render local pages.",
      );
    }

    const screenshot = await page.screenshot({ type: "png", fullPage: true });
    if (!screenshot || screenshot.byteLength <= 0) {
      failWithHint("Generated screenshot is empty.", "Verify Chromium can render pages and has write access to the runtime filesystem.");
    }

    console.log(`verify-browser: PASS: Chromium executable present: ${executable}`);
    console.log(`verify-browser: PASS: data: URI rendered and screenshot size ${screenshot.byteLength} bytes`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint =
      error instanceof VerificationFailure
        ? error.hint
        : looksLikeMissingChromium(detail)
          ? "Run `bunx playwright install --with-deps chromium` and rerun this check."
          : "Check the error details above; if Chromium was recently installed, rerun `bunx playwright install --with-deps chromium`.";

    console.error("verify-browser: FAIL");
    console.error(`verify-browser: ${detail}`);
    console.error(`verify-browser: Action: ${hint}`);
    process.exit(1);
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

await main();
