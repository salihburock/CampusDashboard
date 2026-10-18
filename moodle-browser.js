// ── Moodle via headless browser ─────────────────────────────────
// Fallback for when the webservice REST API (moodle.js) is blocked
// server-side (403 on webservice/rest/server.php, confirmed institution-side
// IP restriction) while ordinary site browsing from the same host is not.
//
// Drives the system's installed Chrome (not Playwright's bundled browser —
// avoids needing `playwright install` / sudo on a box where apt access is
// unavailable) with a real login (Microsoft Entra ID SSO), persists the
// session (cookies) across runs so most syncs don't need to log in again,
// and scrapes course pages the same way the OzU LMS Downloader browser
// extension does, since that's known to work against this exact Moodle
// instance.
//
// Credentials: MOODLE_USERNAME / MOODLE_PASSWORD in .env. Only used to log
// in when the saved session has expired. MFA is not expected on every
// login (per account settings); if it is hit, the run aborts rather than
// hanging or retrying blindly.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const MOODLE_URL = (process.env.MOODLE_URL || '').trim().replace(/\/+$/, '');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const SESSION_STATE_PATH = path.join(__dirname, 'userdata', '.moodle-browser-session.json');
const MFA_RELAY_URL = (process.env.MFA_RELAY_URL || '').trim().replace(/\/+$/, '');
const MFA_RELAY_TOKEN = process.env.MFA_RELAY_TOKEN || '';

class MoodleBrowserError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Approves a Microsoft Authenticator number-match prompt via the mfa-relay
// service (self-hosted, ADB-taps a registered Android device/emulator —
// see ~/gits/mfa-relay on ns). Not a bypass: it's the account's own second
// factor, automated by the account owner. Returns true once the relay
// reports the tap went through; the caller still waits for Moodle itself to
// confirm the login succeeded.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The relay's background poller needs a moment to pick up the push
// notification after it lands on the device, so the first /approve call
// often finds "no active prompt" yet — retry like the user's own `2fa`
// shell helper does (up to 5 tries, 1.5s apart).
async function approveViaRelay(number) {
  if (!MFA_RELAY_URL || !MFA_RELAY_TOKEN) return false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${MFA_RELAY_URL}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MFA-Token': MFA_RELAY_TOKEN },
        body: JSON.stringify({ number }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.approved === true) {
        console.log(`[moodle-browser] mfa-relay approved on attempt ${attempt}/5`);
        return true;
      }
      console.warn(`[moodle-browser] mfa-relay attempt ${attempt}/5: ${JSON.stringify(data)}`);
    } catch (e) {
      console.warn(`[moodle-browser] mfa-relay attempt ${attempt}/5 failed:`, e.message);
    }
    if (attempt < 5) await sleep(1500);
  }
  return false;
}

function debugShot(page, name) {
  try {
    const dir = path.join(__dirname, 'userdata', '.moodle-browser-debug');
    fs.mkdirSync(dir, { recursive: true });
    return page.screenshot({ path: path.join(dir, `${name}-${Date.now()}.png`) }).catch(() => {});
  } catch { return Promise.resolve(); }
}

async function login(page) {
  const username = process.env.MOODLE_USERNAME;
  const password = process.env.MOODLE_PASSWORD;
  if (!username || !password) throw new MoodleBrowserError('MOODLE_USERNAME/MOODLE_PASSWORD not set', 'NO_CREDENTIALS');

  await page.goto(`${MOODLE_URL}/login/index.php`, { waitUntil: 'domcontentloaded' });

  // Microsoft Entra ID: email step. fill() doesn't always trigger the
  // input-validation JS that enables the Next button, so submit with
  // Enter instead of clicking it.
  await page.waitForSelector('#i0116', { timeout: 20000 });
  await page.fill('#i0116', username);
  await page.press('#i0116', 'Enter');

  // Some accounts get a "Choose a way to sign in" interstitial before the
  // password field, defaulting to an Authenticator push; force password.
  // Client-rendered (SPA), so actively wait rather than snapshot the DOM.
  const useMyPassword = page.locator('text=Use my password').first();
  const passwordField = page.locator('#i0118').first();
  await Promise.race([
    useMyPassword.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {}),
    passwordField.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {}),
  ]);
  // Microsoft's SPA animates screens in (opacity transition); Playwright's
  // "visible" check passes mid-animation, before the element is really
  // interactable. Give the transition time to finish.
  await page.waitForTimeout(1500);
  await debugShot(page, 'step1-chooser');
  if (await useMyPassword.isVisible().catch(() => false)) {
    await useMyPassword.click();
    await page.waitForTimeout(1500);
    await debugShot(page, 'step1b-after-click');
  }
  await page.waitForSelector('#i0118', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1500);
  await debugShot(page, 'step2-password-field');
  await page.fill('#i0118', password);
  await page.press('#i0118', 'Enter');
  await page.waitForTimeout(1500);
  await debugShot(page, 'step3-after-submit');

  // From here: straight back to Moodle, a "Stay signed in?" interstitial
  // (click Yes for a longer-lived session cookie), or an Authenticator
  // approval prompt — not on every login per account policy, so wait it
  // out (ticking "Don't ask again for 30 days") rather than failing
  // instantly; a human may be able to approve it, especially on a
  // manually-triggered run.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  for (let i = 0; i < 8; i++) {
    const onMoodle = page.url().startsWith(MOODLE_URL) && !page.url().includes('login.microsoftonline');
    if (onMoodle) break;

    // The post-password screen is client-rendered (SPA), so an instant
    // isVisible() check races the render; actively wait for one of the
    // outcomes instead of snapshotting the DOM immediately.
    const staySignedInLoc = page.locator('text=Stay signed in').first();
    const approvingLoc = page.locator('text=/Approve sign.?in/i').first();
    const chooserLoc = page.locator('text=Approve a request on my Microsoft Authenticator app').first();
    const errorLoc = page.locator('#usernameError, #passwordError, .alert-error').first();
    await Promise.race([
      staySignedInLoc.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {}),
      approvingLoc.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {}),
      chooserLoc.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {}),
      errorLoc.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {}),
      page.waitForURL((url) => url.toString().startsWith(MOODLE_URL) && !url.toString().includes('login.microsoftonline'), { timeout: 10000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(1500);
    await debugShot(page, `loop${i}-settled`);

    if (page.url().startsWith(MOODLE_URL) && !page.url().includes('login.microsoftonline')) break;

    // This is the mandatory second-factor chooser (Authenticator is the
    // only option besides it); click through to the real approve screen.
    if (await chooserLoc.isVisible().catch(() => false)) {
      await chooserLoc.click();
      await page.waitForTimeout(1500);
      continue;
    }

    const staySignedIn = await staySignedInLoc.isVisible().catch(() => false);
    if (staySignedIn) {
      await page.click('#idSIButton9');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      continue;
    }

    const approving = await approvingLoc.isVisible().catch(() => false);
    if (approving) {
      let code = await page.locator('#idRichContext_DisplaySign, [data-testid="displaySign"]').first().textContent({ timeout: 2000 }).catch(() => null);
      if (!code) {
        const bodyText = await page.locator('body').textContent().catch(() => '');
        const m = bodyText.match(/Enter the number if prompted\.?\s*(\d{2})/) || bodyText.match(/\b(\d{2})\b\s*\n?\s*Didn/);
        code = m ? m[1] : null;
      } else {
        code = code.trim();
      }
      console.log(`[moodle-browser] Authenticator approval needed${code ? ` — code ${code}` : ' (no code found)'}`);

      const dontAskAgain = page.locator('text=/Don.t ask again for \\d+ days/i').first();
      if (await dontAskAgain.isVisible().catch(() => false)) await dontAskAgain.click().catch(() => {});

      let relayApproved = false;
      if (code && /^\d{1,3}$/.test(code)) relayApproved = await approveViaRelay(Number(code));
      await debugShot(page, 'mfa-pending');
      // Don't wait for the final Moodle URL in isolation here — approval
      // can land on an intermediate screen first (e.g. "Stay signed in?",
      // still on login.microsoftonline.com), which the top of this loop
      // already knows how to handle. Let it, instead of timing out while
      // sitting on a screen that isn't actually stuck.
      if (!relayApproved && i === 4) {
        await debugShot(page, 'mfa-approved-but-stuck');
        throw new MoodleBrowserError('Authenticator approval was not confirmed by the relay', 'MFA_REQUIRED');
      }
      continue;
    }

    const errorText = await errorLoc.textContent({ timeout: 1000 }).catch(() => null);
    if (errorText) throw new MoodleBrowserError(`Login rejected: ${errorText.trim()}`, 'LOGIN_FAILED');

    // Anything else at this point ("pick an account", unexpected screen)
    // we can't drive headlessly.
    await debugShot(page, 'mfa-or-unexpected');
    throw new MoodleBrowserError('Hit an MFA or unrecognized screen during login', 'MFA_REQUIRED');
  }

  if (!page.url().startsWith(MOODLE_URL)) {
    await debugShot(page, 'login-stuck');
    throw new MoodleBrowserError('Did not land back on Moodle after login', 'LOGIN_FAILED');
  }
}

async function ensureSession(context, page) {
  await page.goto(`${MOODLE_URL}/my/`, { waitUntil: 'domcontentloaded' });
  const loggedIn = page.url().startsWith(MOODLE_URL) && !page.url().includes('/login/');
  if (loggedIn) return;
  // Microsoft's login SPA is occasionally just slow to render a step (seen
  // live, not an MFA/credentials issue) — one retry absorbs that instead of
  // failing the whole sync over a transient page load.
  try {
    await login(page);
  } catch (e) {
    if (e instanceof MoodleBrowserError && (e.code === 'MFA_REQUIRED' || e.code === 'LOGIN_FAILED' || e.code === 'NO_CREDENTIALS')) throw e;
    console.warn('[moodle-browser] login attempt 1 failed, retrying once:', e.message);
    await login(page);
  }
  await context.storageState({ path: SESSION_STATE_PATH });
}

async function listEnrolledCourses(page) {
  await page.goto(`${MOODLE_URL}/my/courses.php`, { waitUntil: 'domcontentloaded' });
  // The course cards are client-rendered after load; domcontentloaded
  // fires before they exist.
  await page.waitForSelector('a[href*="/course/view.php?id="]', { timeout: 20000 }).catch(() => {});
  const courses = await page.$$eval('a[href*="/course/view.php?id="]', (links) => {
    const seen = new Map();
    for (const a of links) {
      const m = a.href.match(/[?&]id=(\d+)/);
      if (!m) continue;
      const id = m[1];
      const name = (a.getAttribute('title') || a.textContent || '').trim();
      if (name && !seen.has(id)) seen.set(id, { id: Number(id), name });
    }
    return [...seen.values()];
  });
  return courses;
}

const SELECTORS = {
  sections: ['ul.weeks li.section', 'ul.topics li.section', 'li[id^="section-"]'],
  sectionTitle: ['.sectionname', '.course-section-header', '[aria-label]'],
  resources: '.activity.resource a, .modtype_resource a',
  folders: '.activity.folder a, .modtype_folder a',
  assignments: '.activity.assign a, .modtype_assign a',
};

// Moodle appends a hidden accessibility hint to .instancename/.fp-filename
// ("File", "Folder", …) as a sibling text/span node; textContent() on the
// whole element picks that up too, corrupting the real filename (matches
// the OzU extension's own childNodes[0] workaround for the same markup).
async function firstTextNode(locator) {
  const text = await locator.evaluate((el) => (el.childNodes[0] && el.childNodes[0].textContent) || el.textContent, undefined, { timeout: 1000 }).catch(() => null);
  return text ? text.trim() : null;
}

// A resource link's title isn't its filename ("L2 - Metrics" for
// L2-key-metrics.pdf). mod/resource/view.php redirects to the pluginfile
// URL, whose last path segment (or Content-Disposition) is the real name,
// extension included.
function realFilename(res) {
  const cd = res.headers()['content-disposition'] || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  let name = m ? m[1] : '';
  if (!name) {
    try {
      const u = new URL(res.url());
      if (u.pathname.includes('/pluginfile.php/')) name = u.pathname.split('/').pop();
    } catch {}
  }
  try { name = decodeURIComponent(name); } catch {}
  return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : null;
}

async function findAllText(page, selectorList) {
  for (const sel of selectorList) {
    const count = await page.locator(sel).count();
    if (count > 0) return sel;
  }
  return null;
}

// Scrapes one course page for resource/folder/assignment-attachment links,
// shaped like moodle.js's courseFiles() so they can go through the same
// syncMoodleFiles() pipeline: { section, module, filename, fileurl,
// filesize, timemodified, mimetype, assignId? }.
async function discoverCourseFiles(context, page, courseId) {
  await page.goto(`${MOODLE_URL}/course/view.php?id=${courseId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SELECTORS.sections.join(', '), { timeout: 15000 }).catch(() => {});

  const sectionSel = await findAllText(page, SELECTORS.sections);
  const sections = sectionSel ? await page.locator(sectionSel).all() : [page.locator('body')];

  const files = [];
  for (const section of sections) {
    let sectionName = 'General';
    for (const sel of SELECTORS.sectionTitle) {
      const t = await section.locator(sel).first().textContent({ timeout: 1000 }).catch(() => null);
      if (t && t.trim()) { sectionName = t.trim(); break; }
    }

    const resourceLinks = await section.locator(SELECTORS.resources).all();
    for (const link of resourceLinks) {
      const href = await link.getAttribute('href').catch(() => null);
      const name = await firstTextNode(link.locator('.instancename').first()) || await firstTextNode(link);
      if (!href || !name) continue;
      files.push({ section: sectionName, module: name, filename: name, fileurl: href, filesize: 0, timemodified: 0, mimetype: '' });
    }

    const folderLinks = await section.locator(SELECTORS.folders).all();
    for (const link of folderLinks) {
      const href = await link.getAttribute('href').catch(() => null);
      if (!href) continue;
      try {
        await page.goto(href, { waitUntil: 'domcontentloaded' });
        const fileLinks = await page.locator('.fp-filename-icon a, .file-picker a').all();
        for (const fl of fileLinks) {
          const fHref = await fl.getAttribute('href').catch(() => null);
          const fName = await firstTextNode(fl.locator('.fp-filename').first()) || await firstTextNode(fl);
          if (!fHref || !fName) continue;
          files.push({ section: sectionName, module: fName, filename: fName, fileurl: fHref, filesize: 0, timemodified: 0, mimetype: '' });
        }
      } catch (e) {
        console.warn(`[moodle-browser] folder scrape failed (${href}):`, e.message);
      } finally {
        await page.goto(`${MOODLE_URL}/course/view.php?id=${courseId}`, { waitUntil: 'domcontentloaded' });
      }
    }
  }

  // Assignment intro attachments: visit each assignment's own page and pick
  // up any pluginfile.php links in the activity description (not the
  // submission area, which the student view doesn't expose anyway).
  const assignLinks = await page.locator(SELECTORS.assignments).all();
  const assignHrefs = [];
  for (const link of assignLinks) {
    const href = await link.getAttribute('href').catch(() => null);
    const name = await firstTextNode(link.locator('.instancename').first()) || await firstTextNode(link);
    const idMatch = href && href.match(/[?&]id=(\d+)/);
    if (href && idMatch) assignHrefs.push({ href, id: idMatch[1], name: name || '' });
  }
  for (const a of assignHrefs) {
    try {
      await page.goto(a.href, { waitUntil: 'domcontentloaded' });
      const attachLinks = await page.locator('.activity-description a[href*="pluginfile.php"], .box.py-3.generalbox a[href*="pluginfile.php"]').all();
      for (const al of attachLinks) {
        const fHref = await al.getAttribute('href').catch(() => null);
        const fName = await al.textContent().catch(() => '');
        if (!fHref || !fName) continue;
        files.push({
          section: 'Assignments', module: a.name, filename: fName.trim(), fileurl: fHref,
          filesize: 0, timemodified: 0, mimetype: '', assignId: a.id,
        });
      }
    } catch (e) {
      console.warn(`[moodle-browser] assignment scrape failed (${a.href}):`, e.message);
    }
  }
  await page.goto(`${MOODLE_URL}/course/view.php?id=${courseId}`, { waitUntil: 'domcontentloaded' });

  // Fill in size/last-modified via HEAD, so unchanged files are recognized
  // as such by syncMoodleFiles' cache instead of being re-downloaded every
  // run. Best-effort: a failed HEAD just leaves a stable 0:0 stamp.
  await Promise.all(files.map(async (f) => {
    try {
      const res = await context.request.head(f.fileurl, { timeout: 10000 });
      const len = res.headers()['content-length'];
      const mod = res.headers()['last-modified'];
      if (len) f.filesize = Number(len) || 0;
      if (mod) f.timemodified = Math.floor(new Date(mod).getTime() / 1000) || 0;
      const real = realFilename(res);
      if (real) f.filename = real;
    } catch {}
  }));

  return files;
}

// Downloads a file using the browser context's authenticated cookies
// (drop-in replacement for moodle.js's token-based downloadFile, same
// signature minus `owner`).
async function downloadViaContext(context, fileurl, destPath) {
  const res = await context.request.get(fileurl, { timeout: 10 * 60 * 1000 });
  if (!res.ok()) throw new MoodleBrowserError(`Could not download file (HTTP ${res.status()})`);
  fs.writeFileSync(destPath, await res.body());
}

// Runs `onCourse(course, files, downloadFn)` for every enrolled course.
// Keeps the browser open for the whole run and closes it at the end —
// short-lived on a RAM-constrained box, not a persistent process.
async function withSession(fn) {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  try {
    const contextOptions = {};
    if (fs.existsSync(SESSION_STATE_PATH)) contextOptions.storageState = SESSION_STATE_PATH;
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await ensureSession(context, page);
    await context.storageState({ path: SESSION_STATE_PATH }).catch(() => {});
    return await fn(context, page);
  } finally {
    await browser.close();
  }
}

async function syncAllCourses(onCourse) {
  return withSession(async (context, page) => {
    const courses = await listEnrolledCourses(page);
    console.log(`[moodle-browser] logged in, ${courses.length} courses`);
    for (const [i, course] of courses.entries()) {
      try {
        console.log(`[moodle-browser] [${i + 1}/${courses.length}] ${course.name}: scanning`);
        const files = await discoverCourseFiles(context, page, course.id);
        console.log(`[moodle-browser] [${i + 1}/${courses.length}] ${course.name}: ${files.length} files found, syncing`);
        await onCourse(course, files, (_, url, dest) => downloadViaContext(context, url, dest));
      } catch (e) {
        console.error(`[moodle-browser] course ${course.id} (${course.name}) failed:`, e.message);
      }
    }
  });
}

module.exports = { MoodleBrowserError, syncAllCourses, withSession, listEnrolledCourses, discoverCourseFiles };
