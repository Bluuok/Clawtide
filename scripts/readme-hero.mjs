// Render deterministic browser frames; encode them with encode-hero.py.
// node scripts/readme-hero.mjs <playwright-module> <frame-directory>
import { pathToFileURL } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const directory = process.argv[3];
await mkdir(directory, { recursive: true });
const art = (
  await readFile(new URL('../web/public/images/tidal-sculpture.png', import.meta.url))
).toString('base64');
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({
  viewport: { width: 1200, height: 560 },
  deviceScaleFactor: 1,
});
await page.setContent(`<style>
*{box-sizing:border-box}body{margin:0;background:#f6f5ef;color:#173f35;font-family:Arial,sans-serif}
main{height:560px;display:grid;grid-template-columns:58fr 42fr;padding:24px;gap:24px}
section{padding:36px;display:flex;flex-direction:column;justify-content:center}
.brand{font:36px Georgia,serif;margin-bottom:55px}.eyebrow{font-size:11px;letter-spacing:3px;color:#547367}
h1{font:58px/1.12 Georgia,serif;letter-spacing:-2px;margin:24px 0}#word{color:#438778}.cursor{color:#438778;font-weight:normal}
p{font-size:15px;line-height:1.7;color:#547367;max-width:360px}.foot{margin-top:35px;font-size:10px;letter-spacing:2px}
img{width:100%;height:512px;object-fit:cover;object-position:center bottom;border-radius:16px}
</style><main><section><div class="brand">≈ clawtide</div><div class="eyebrow">YOUR DIGITAL WORKSPACE</div><h1>Make room for<br><span id="word">focus.</span><span class="cursor">|</span></h1><p>A thoughtful home for your digital workers.<br>Self-hosted. Quietly capable. Yours.</p><div class="foot">CONVERSATIONS / WORKERS / SCHEDULES</div></section><img src="data:image/png;base64,${art}"></main>`);
await page.locator('img').evaluate((img) => img.decode());
let frame = 0;
for (const word of ['focus.', 'ideas.', 'what matters.']) {
  for (let n = 0; n <= word.length; n++) {
    await page.locator('#word').evaluate(
      (el, value) => {
        el.textContent = value;
      },
      word.slice(0, n),
    );
    await page.screenshot({ path: `${directory}/${String(frame++).padStart(3, '0')}.png` });
  }
  // Hold the complete phrase; durations are encoded separately.
  await page.screenshot({ path: `${directory}/${String(frame++).padStart(3, '0')}-hold.png` });
  for (let n = word.length - 1; n >= 0; n--) {
    await page.locator('#word').evaluate(
      (el, value) => {
        el.textContent = value;
      },
      word.slice(0, n),
    );
    await page.screenshot({ path: `${directory}/${String(frame++).padStart(3, '0')}.png` });
  }
}
await browser.close();
console.log(`Rendered ${frame} frames into ${directory}`);
