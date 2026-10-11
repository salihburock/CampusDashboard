// Run on ns with Playwright installed in ./sis-node/node_modules.
const { chromium } = require('./sis-node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const codes = process.argv.slice(2);
const output = path.join(__dirname, 'syllabi');
const catalog = 'https://sis.ozyegin.edu.tr/OZU_GWT/WEB/CourseCatalogOfferUI?locale=en';

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const results = {};
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    for (const code of codes) {
      try {
        await page.goto(catalog, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const term = page.locator('input[name="TERMCODE"]');
        await term.waitFor();
        if (await term.inputValue() !== 'Fall 2026/27') throw new Error('Unexpected SIS term');
        // Preserve L suffix for labs and the full cross-listed number.
        // Moodle combines undergraduate/graduate sections; SIS lists the
        // undergraduate member separately (ME 412-512.A -> ME 412.A).
        const catalogCode = code.replace(/(\d{3})-\d{3}(?=\.)/, '$1');
        const query = catalogCode.replace(/\.[A-Za-z0-9]+$/, '');
        await page.locator('input[name="SEARCHSET"]').fill(query);
        await page.locator('td').filter({ hasText: /^Search$/ }).last().click();
        // Match the section before selecting its PDF, even with multiple results.
        const label = page.getByText(catalogCode, { exact: true }).first();
        await label.waitFor();
        const row = label.locator('xpath=ancestor::tr[@role="listitem"][1]');
        // SmartClient renders action buttons outside its table, positioned
        // over each record. Resolve against the actual row bounds at runtime.
        await page.waitForTimeout(500);
        const bounds = await row.boundingBox();
        const icons = page.locator('img[src$="pdf_with_attachments.png"]');
        let icon;
        for (let i = 0; i < await icons.count(); i++) {
          const box = await icons.nth(i).boundingBox();
          if (box && box.y >= bounds.y && box.y < bounds.y + bounds.height) {
            if (icon) throw new Error('Ambiguous PDF actions for section');
            icon = icons.nth(i);
          }
        }
        if (!icon) {
          results[code] = null;
          console.error(`[SIS] ${code}: no syllabus PDF published for this section`);
          continue;
        }
        await page.evaluate(() => {
          window.__syllabusUrls = [];
          window.open = url => { window.__syllabusUrls.push(url); return null; };
        });
        await icon.click();
        await page.waitForFunction(() => window.__syllabusUrls.length > 0);
        const url = await page.evaluate(() => window.__syllabusUrls[0]);
        const absolute = new URL(url, catalog);
        if (absolute.origin !== new URL(catalog).origin) throw new Error('Unexpected PDF host');
        const base64 = await page.evaluate(async url => {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) throw new Error(`PDF HTTP ${r.status}`);
          const bytes = new Uint8Array(await r.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          return btoa(binary);
        }, absolute.href);
        const bytes = Buffer.from(base64, 'base64');
        if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('SIS returned a non-PDF response');
        const filename = `sis-${code.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}.pdf`;
        fs.writeFileSync(path.join(output, filename), bytes);
        results[code] = filename;
        console.error(`[SIS] ${code}: ${bytes.length} bytes`);
      } catch (error) {
        console.error(`[SIS] ${code}: ${error.message}`);
      }
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(results));
})().catch(error => { console.error(error); process.exitCode = 1; });
