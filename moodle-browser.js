// ── Moodle login via headless browser ───────────────────────────
// The webservice REST API (moodle.js) is blocked for servers by the
// university (403 on webservice/rest/server.php), while ordinary site
// browsing with a logged-in session is not. This signs in like a person
// would and saves the session cookies; everything else (course zips,
// grades) is fetched with them over plain HTTP (moodle-http.js,
// moodle-zip.js).
//
// Drives the system's installed Chrome (not Playwright's bundled browser —
// avoids needing `playwright install` / sudo on a box where apt access is
// unavailable) with a real login (Microsoft Entra ID SSO), and persists the
// session (cookies) across runs so most syncs don't need to log in again.
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

// Signs in again (only if the saved session has expired) so plain HTTP
// requests (moodle-http.js, moodle-zip.js) have a fresh session cookie. The
// browser is open only for the login, then closed: short-lived on a
// RAM-constrained box, not a persistent process.
async function refreshSession() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  try {
    const contextOptions = {};
    if (fs.existsSync(SESSION_STATE_PATH)) contextOptions.storageState = SESSION_STATE_PATH;
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await ensureSession(context, page);
    await context.storageState({ path: SESSION_STATE_PATH }).catch(() => {});
  } finally {
    await browser.close();
  }
}

module.exports = { MoodleBrowserError, refreshSession };
