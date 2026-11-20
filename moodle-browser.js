// ── Moodle sign-in through a real browser ───────────────────────
// The webservice REST API (moodle.js) is blocked for servers by the
// university (403 on webservice/rest/server.php), while ordinary site
// browsing with a logged-in session is not. This signs in like a person
// would (Microsoft Entra ID SSO, then an authenticator code) and saves the
// Moodle session cookie; everything else (course zips, grades) is fetched
// with it over plain HTTP (moodle-http.js, moodle-zip.js).
//
// The sign-in runs in its own process (`node moodle-browser.js login`), so
// the password and TOTP key are read only there, never by the web server.
// They come from MOODLE_LOGIN_FILE (default ~/.config/campdash/moodle-login,
// KEY=VALUE lines, readable only by you), or else from the environment:
//   MOODLE_USERNAME, MOODLE_PASSWORD, MOODLE_TOTP_SECRET
// MOODLE_TOTP_SECRET is the key of an "other authenticator app" sign-in
// method on the account; its 6-digit code is entered at the MFA step.
//
// The browser is the system's Chrome (no `playwright install` needed) with a
// fresh profile each time: a normal window without automation flags on
// MOODLE_LOGIN_DISPLAY (e.g. ":0"), or headless when that is empty. Only the
// Moodle cookies are kept.
//
// The server signs in by itself when the session has expired. After a failed
// attempt it stops (no retry loop that could lock the account) until a manual
// `node moodle-browser.js login` (`campdash login`) succeeds. Without sign-in
// details nothing signs in; the session file can then come from elsewhere
// (campdash copies the LMS cookie from Chrome on your laptop).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Run directly (not required by server.js): settings come from .env.
if (require.main === module) {
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
}

const MOODLE_URL = (process.env.MOODLE_URL || '').trim().replace(/\/+$/, '');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const USERDATA = path.join(__dirname, 'userdata');
const SESSION_STATE_PATH = path.join(USERDATA, '.moodle-browser-session.json');
const FAILED_PATH = path.join(USERDATA, '.moodle-login-failed.json');
const FAILED_SHOT_PATH = path.join(USERDATA, '.moodle-login-failed.png');

class MoodleBrowserError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onMoodle = (url) => url.startsWith(MOODLE_URL) && !url.includes('login.microsoftonline');

function loginFilePath() {
  const file = process.env.MOODLE_LOGIN_FILE || '~/.config/campdash/moodle-login';
  return file.replace(/^~(?=\/|$)/, os.homedir());
}

function readCredentials() {
  const file = loginFilePath();
  const values = {};
  if (fs.existsSync(file)) {
    if (fs.statSync(file).mode & 0o077) {
      throw new MoodleBrowserError(`${file} can be read by other users; run chmod 600 on it`, 'NO_CREDENTIALS');
    }
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const get = (key) => values[key] || process.env[key] || '';
  return {
    file,
    username: get('MOODLE_USERNAME'),
    password: get('MOODLE_PASSWORD'),
    totpSecret: get('MOODLE_TOTP_SECRET').replace(/[\s=]/g, '').toUpperCase(),
  };
}

// RFC 6238 code (SHA-1, 6 digits, 30 s steps: what Microsoft's "other
// authenticator app" method uses) for the given 30-second step.
function totp(secret, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new MoodleBrowserError('MOODLE_TOTP_SECRET is not a base32 key', 'NO_CREDENTIALS');
    bits += v.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

async function login(page, { username, password, totpSecret }) {
  await page.goto(`${MOODLE_URL}/login/index.php`, { waitUntil: 'domcontentloaded' });

  // Email step. fill() doesn't always trigger the input-validation JS that
  // enables the Next button, so submit with Enter instead of clicking it.
  await page.waitForSelector('#i0116', { timeout: 30000 });
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
  if (await useMyPassword.isVisible().catch(() => false)) {
    await useMyPassword.click();
    await page.waitForTimeout(1500);
  }
  await page.waitForSelector('#i0118', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.fill('#i0118', password);
  await page.press('#i0118', 'Enter');
  await page.waitForTimeout(1500);

  // Then: the second factor, "Stay signed in?", or straight back to Moodle.
  let lastStep = -1, codesEntered = 0;
  for (let i = 0; i < 10 && !onMoodle(page.url()); i++) {
    const screens = {
      codeInput: page.locator('input[name="otc"], #idTxtBx_SAOTCC_OTC').first(),
      codeChoice: page.locator('text=/Use a verification code/i').first(),
      pushWait: page.locator('text=/Approve sign.?in/i').first(),
      otherWay: page.locator('#signInAnotherWay').or(page.getByText(/can.t use my Microsoft Authenticator app/i)).first(),
      staySignedIn: page.locator('text=Stay signed in').first(),
      error: page.locator('#usernameError, #passwordError').first(),
    };
    await Promise.race([
      ...Object.values(screens).map((l) => l.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})),
      page.waitForURL((u) => onMoodle(u.toString()), { timeout: 15000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(1500);
    if (onMoodle(page.url())) break;
    const visible = (name) => screens[name].isVisible().catch(() => false);

    if (await visible('error')) {
      throw new MoodleBrowserError(`Login rejected: ${(await screens.error.textContent()).trim()}`, 'LOGIN_FAILED');
    }
    if (await visible('codeInput')) {
      if (!totpSecret) throw new MoodleBrowserError('Microsoft asks for an authenticator code and MOODLE_TOTP_SECRET is not set', 'LOGIN_FAILED');
      // A rejected code gets one more try with the next code, then stop:
      // repeated wrong codes can lock the account. A code is never reused.
      if (codesEntered === 2) throw new MoodleBrowserError('Microsoft rejected the authenticator code twice; check MOODLE_TOTP_SECRET', 'LOGIN_FAILED');
      let step = Math.floor(Date.now() / 30000);
      if (step === lastStep) {
        await sleep(30000 - (Date.now() % 30000) + 500);
        if (!(await visible('codeInput'))) continue;
        step = Math.floor(Date.now() / 30000);
      }
      lastStep = step;
      codesEntered++;
      await screens.codeInput.fill(totp(totpSecret, step));
      await screens.codeInput.press('Enter');
      continue;
    }
    if (await visible('codeChoice')) { await screens.codeChoice.click(); continue; }
    // The Authenticator push (the account's default method): switch to the code.
    if (await visible('pushWait') && await visible('otherWay')) { await screens.otherWay.click(); continue; }
    if (await visible('staySignedIn')) { await page.click('#idSIButton9'); continue; }
    throw new MoodleBrowserError('Unexpected screen during the Microsoft sign-in', 'LOGIN_FAILED');
  }
  if (!onMoodle(page.url())) throw new MoodleBrowserError('Did not get back to Moodle after signing in', 'LOGIN_FAILED');
}

async function signIn() {
  const creds = readCredentials();
  if (!creds.username || !creds.password) {
    throw new MoodleBrowserError(`No Moodle sign-in details (MOODLE_USERNAME/MOODLE_PASSWORD in ${creds.file})`, 'NO_CREDENTIALS');
  }
  const { chromium } = require('playwright-core');
  const display = process.env.MOODLE_LOGIN_DISPLAY || '';
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: !display,
    // A normal-looking Chrome: no "controlled by automated software" flag.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    env: display
      ? { ...process.env, DISPLAY: display, XAUTHORITY: process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority') }
      : process.env,
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      try {
        await login(page, creds);
      } catch (e) {
        // Microsoft's sign-in pages are sometimes just slow to show a step;
        // one retry absorbs that. Rejections are not retried.
        if (e instanceof MoodleBrowserError) throw e;
        console.warn(`[moodle-login] retrying once after: ${e.message}`);
        await login(page, creds);
      }
    } catch (e) {
      await page.screenshot({ path: FAILED_SHOT_PATH }).catch(() => {});
      throw e;
    }
    // Keep only Moodle's cookies; Microsoft's could sign in elsewhere.
    const host = new URL(MOODLE_URL).hostname;
    const cookies = (await context.cookies()).filter((c) => {
      const d = c.domain.replace(/^\./, '');
      return host === d || host.endsWith('.' + d);
    });
    const tmp = SESSION_STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ cookies, origins: [] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SESSION_STATE_PATH);
  } finally {
    await browser.close();
  }
}

// `login`: signs in unless the saved session still works (--force: always).
// `login --auto` (the server, after the session expired): signs in, unless an
// earlier automatic attempt failed and no manual one has succeeded since.
async function cli(args) {
  const auto = args.includes('--auto');
  if (auto && fs.existsSync(FAILED_PATH)) {
    const failed = JSON.parse(fs.readFileSync(FAILED_PATH, 'utf8'));
    throw new MoodleBrowserError(`automatic sign-in is paused since it failed on ${new Date(failed.at).toLocaleString('en-GB')} (${failed.message}); run campdash login`, 'LOGIN_PAUSED');
  }
  if (!auto && !args.includes('--force')) {
    const moodleHttp = require('./moodle-http');
    try {
      await moodleHttp.getPage('/my/');
      return 'Already signed in to Moodle (--force signs in again)';
    } catch (e) {
      if (!(e instanceof moodleHttp.SessionExpiredError)) throw e;
    }
  }
  try {
    await signIn();
  } catch (e) {
    if (e.code !== 'NO_CREDENTIALS') fs.writeFileSync(FAILED_PATH, JSON.stringify({ at: Date.now(), message: e.message }));
    throw e;
  }
  fs.rmSync(FAILED_PATH, { force: true });
  fs.rmSync(FAILED_SHOT_PATH, { force: true });
  return 'Signed in to Moodle';
}

// Called by the server when Moodle says the session expired: signs in again
// in a child process. Concurrent callers share one attempt.
let refreshing = null;
function refreshSession() {
  if (refreshing) return refreshing;
  refreshing = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, 'login', '--auto'], { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 5 * 60000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() || `exit code ${code}`;
      console.log(`[moodle-login] ${last}`);
      if (code === 0) resolve();
      else reject(new MoodleBrowserError(`Moodle session expired and signing in again failed: ${last}`, 'LOGIN_FAILED'));
    });
  }).finally(() => { refreshing = null; });
  return refreshing;
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd !== 'login') {
    console.error('usage: node moodle-browser.js login [--force]');
    process.exit(2);
  }
  cli(args).then((msg) => console.log(msg), (e) => { console.log(e.message); process.exitCode = 1; });
}

module.exports = { MoodleBrowserError, refreshSession };
