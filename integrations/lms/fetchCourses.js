const { chromium } = require('playwright');
const config = require('./config');
const { loginToLms, dumpDebug } = require('./auth');

async function fetchCourseList(page) {
  await page.goto('https://lms.ozyegin.edu.tr/my/courses.php', { waitUntil: 'networkidle' });

  const courses = await page.$$eval(
    'a.aalink.coursename, .coursename a, .course-info-container a.aalink',
    (links) => links
      .map((a) => ({ name: a.textContent.trim(), url: a.href }))
      .filter((c) => c.name)
  );

  const seen = new Set();
  return courses.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

async function main() {
  // Playwright's bundled Chromium has a fingerprint Microsoft's sign-in risk
  // detection recognizes and responds to by silently refusing to deliver the
  // Authenticator push ("trouble verifying your account" / "request wasn't
  // sent") — confirmed by a manual login from a real browser getting a push
  // fine while this script's runs never did. Using the real, installed
  // Chrome build (channel: 'chrome') plus disabling the automation-control
  // flag avoids the most common signals.
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !config.headful,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    console.log('Logging into lms.ozyegin.edu.tr ...');
    await loginToLms(page);
    console.log('Logged in. Fetching course list...');

    const courses = await fetchCourseList(page);
    if (courses.length === 0) {
      await dumpDebug(page, 'no-courses-found');
      console.warn('No courses found on the page — check integrations/lms/debug/ to adjust selectors.');
    }
    console.log(JSON.stringify(courses, null, 2));
  } catch (err) {
    await dumpDebug(page, 'error');
    console.error('Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
