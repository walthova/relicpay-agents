const { chromium } = require("playwright-core");
(async () => {
  const out = process.argv[2];
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--window-size=1920,1080", "--hide-scrollbars"] });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir: out, size: { width: 1920, height: 1080 } },
  });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3100/story?autoplay=1", { waitUntil: "networkidle" });
  await page.waitForTimeout(Number(process.env.DUR ?? 120000));
  await ctx.close();
  await browser.close();
})();
