// ── Moodle sign-in through a real browser ───────────────────────
// The webservice REST API (moodle.js) is blocked for servers by the
// university (403 on webservice/rest/server.php), while ordinary site
// browsing with a logged-in session is not. Everything (course zips,
// grades) is fetched over plain HTTP (moodle-http.js, moodle-zip.js) with the
// Moodle session cookie in userdata/.moodle-browser-session.json; this file
// renews that cookie when Moodle says it expired.
//
// Moodle's session is short-lived, but it is renewed through Microsoft's
// sign-in (Entra ID SSO), whose own "Stay signed in" cookie lasts much longer
// and only works in a browser. So the server keeps a Chrome profile of its
// own (MOODLE_BROWSER_PROFILE, default ~/.config/campdash/chrome-profile) and
// renews in two steps:
//   1. A plain Chrome (started like a person would, nothing driving it)
//      opens the LMS with that profile; while Microsoft still knows the
//      browser it signs in without a password. Chrome is closed normally and
//      the new Moodle cookie is read from the profile (browser_cookie3).
//   2. Only if that didn't sign in (first run, or Microsoft forgot the
//      browser), a scripted sign-in types the password and the authenticator
//      code into the same profile and answers "Stay signed in?" with yes.
// Chrome is shown on MOODLE_LOGIN_DISPLAY (e.g. ":0"), headless when empty.
//
// Step 2's details come from MOODLE_LOGIN_FILE (default
// ~/.config/campdash/moodle-login, KEY=VALUE lines, readable only by you),
// or else the environment: MOODLE_USERNAME, MOODLE_PASSWORD and
// MOODLE_TOTP_SECRET (the key of an "other authenticator app" sign-in
// method). The renewal runs in its own process (`node moodle-browser.js
// login`), so the web server never reads them.
//
// The server renews by itself when the session has expired. After a failed
// attempt it stops (no retry loop that could lock the account or keep
// loading the LMS) until a manual `node moodle-browser.js login`
// (`campdash login`) succeeds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

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

const home = (p) => p.replace(/^~(?=\/|$)/, os.homedir());
const PROFILE_DIR = home(process.env.MOODLE_BROWSER_PROFILE || '~/.config/campdash/chrome-profile');

class MoodleBrowserError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onMoodle = (url) => url.startsWith(MOODLE_URL) && !url.includes('login.microsoftonline');

function chromeEnv() {
  const display = process.env.MOODLE_LOGIN_DISPLAY || '';
  return display
    ? { ...process.env, DISPLAY: display, XAUTHORITY: process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority') }
    : process.env;
}

function readCredentials() {
  const file = home(process.env.MOODLE_LOGIN_FILE || '~/.config/campdash/moodle-login');
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

// ── Step 1: a plain Chrome ──────────────────────────────────────

// Opens url in Chrome with the profile, nothing driving it, waits, then
// closes it like closing the window does (SIGTERM is a normal shutdown), so
// Chrome writes its cookies to disk.
async function browserVisit(url, profileDir = PROFILE_DIR, waitMs = 20000) {
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const args = [`--user-data-dir=${profileDir}`, '--password-store=basic', '--no-first-run', '--no-default-browser-check', '--new-window'];
  if (!process.env.MOODLE_LOGIN_DISPLAY) args.push('--headless=new');
  const chrome = spawn(CHROME_PATH, [...args, url], { env: chromeEnv(), stdio: 'ignore' });
  const exited = new Promise((resolve) => chrome.on('exit', resolve));
  await Promise.race([sleep(waitMs), exited]);
  chrome.kill('SIGTERM');
  if (!(await Promise.race([exited.then(() => true), sleep(15000).then(() => false)]))) chrome.kill('SIGKILL');
}

// The profile's cookies for host, decrypted by browser_cookie3 (Python).
function readBrowserCookies(host, profileDir = PROFILE_DIR) {
  const file = ['Default/Network/Cookies', 'Default/Cookies'].map((f) => path.join(profileDir, f))
    .filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!file) return [];
  const py = 'import json, sys, browser_cookie3\n' +
    'jar = browser_cookie3.chrome(cookie_file=sys.argv[1], domain_name=sys.argv[2])\n' +
    'print(json.dumps([{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path, ' +
    '"secure": bool(c.secure), "expires": c.expires or -1} for c in jar]))';
  const r = spawnSync('python3', ['-c', py, file, host], { encoding: 'utf8' });
  if (r.status) throw new Error(`reading Chrome's cookies failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  return JSON.parse(r.stdout);
}

// ── Step 2: the scripted sign-in ────────────────────────────────

// Types a value key by key like a person (about 100 words a minute, with
// longer pauses around "." and "@") and submits it with Enter. With fill(),
// which sets the value without key presses, Microsoft's page submitted the
// email as empty (seen live).
async function typeAndSubmit(page, field, value) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await field.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    for (const ch of value) {
      const slow = ch === '.' || ch === '@';
      if (slow) await sleep(250 + Math.random() * 250);
      await page.keyboard.type(ch);
      await sleep(slow ? 250 + Math.random() * 250 : 80 + Math.random() * 80);
    }
    await sleep(400 + Math.random() * 400);
    if ((await field.inputValue().catch(() => '')) === value) {
      await page.keyboard.press('Enter');
      return;
    }
  }
  throw new MoodleBrowserError("Microsoft's sign-in page didn't keep the typed value", 'LOGIN_FAILED');
}

async function login(page, { username, password, totpSecret }) {
  await page.goto(`${MOODLE_URL}/login/index.php`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const nameRx = new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  // Microsoft's screens come in varying order (it remembers this profile's
  // account, may skip the password or ask for the second factor in different
  // ways), so act on whichever is showing until back on Moodle.
  // Fields the user can see. The email screen also holds an off-screen
  // decoy #i0118 (class moveOffScreen, for the browser's password autofill)
  // that counts as "visible"; taking it for the password screen typed the
  // password into it and submitted an empty email (seen live).
  const field = (sel) => page.locator(sel.split(',').map((s) => `${s.trim()}:not(.moveOffScreen):not([aria-hidden="true"])`).join(', ')).first();
  let lastStep = -1, codesEntered = 0, emailsEntered = 0, passwordsEntered = 0;
  for (let i = 0; i < 15 && !onMoodle(page.url()); i++) {
    const screens = {
      error: page.locator('#usernameError, #passwordError').first(),
      password: field('#i0118'),
      email: field('#i0116'),
      // "Use my password" (method list) or "Use your password instead" (the
      // passwordless "Approve sign in" screen Microsoft may go to first).
      usePassword: page.locator('#idA_PWD_SwitchToPassword').or(page.getByText(/^\s*Use (my|your) password/i)).first(),
      codeInput: field('input[name="otc"], #idTxtBx_SAOTCC_OTC'),
      codeChoice: page.locator('text=/Use a verification code/i').first(),
      pushWait: page.locator('text=/Approve sign.?in/i').first(),
      otherWay: page.locator('#signInAnotherWay').or(page.getByText(/can.t use my Microsoft Authenticator app|other ways to sign in/i)).first(),
      staySignedIn: page.locator('text=Stay signed in').first(),
      account: page.locator(`[data-test-id="${username}"]`).or(page.getByRole('button', { name: nameRx })).first(),
    };
    // Client-rendered (SPA): wait for a screen rather than snapshot the DOM.
    await Promise.race([
      ...Object.values(screens).map((l) => l.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {})),
      page.waitForURL((u) => onMoodle(u.toString()), { timeout: 15000 }).catch(() => {}),
    ]);
    // Screens animate in; "visible" passes mid-animation, before they take input.
    await page.waitForTimeout(1500);
    if (onMoodle(page.url())) break;
    const visible = (name) => screens[name].isVisible().catch(() => false);
    // After acting on a screen, wait for it to leave: screens slide out
    // slowly, and seeing the old one again meant acting on it twice (seen
    // live: the email submitted a second time mid-transition, empty).
    const leave = (name) => screens[name].waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

    if (await visible('error')) {
      throw new MoodleBrowserError(`Login rejected: ${(await screens.error.textContent().catch(() => '') || '').trim()}`, 'LOGIN_FAILED');
    }
    if (await visible('password')) {
      if (passwordsEntered++) throw new MoodleBrowserError('Microsoft asked for the password again', 'LOGIN_FAILED');
      await typeAndSubmit(page, screens.password, password);
      await leave('password');
      continue;
    }
    if (await visible('email')) {
      if (emailsEntered++) throw new MoodleBrowserError('Microsoft asked for the email again', 'LOGIN_FAILED');
      await typeAndSubmit(page, screens.email, username);
      await leave('email');
      continue;
    }
    if (await visible('usePassword')) { await screens.usePassword.click(); await leave('usePassword'); continue; }
    if (await visible('codeInput')) {
      if (!totpSecret) throw new MoodleBrowserError('Microsoft asks for an authenticator code and MOODLE_TOTP_SECRET is not set', 'LOGIN_FAILED');
      // A rejected code gets one more try with the next code, then stop:
      // repeated wrong codes can lock the account. A code is never reused.
      if (codesEntered === 2) throw new MoodleBrowserError('Microsoft rejected the authenticator code twice; check MOODLE_TOTP_SECRET', 'LOGIN_FAILED');
      let step = Math.floor(Date.now() / 30000);
      // Typing takes a second or two: don't start a code about to expire.
      if (step === lastStep || 30000 - (Date.now() % 30000) < 4000) {
        await sleep(30000 - (Date.now() % 30000) + 500);
        if (!(await visible('codeInput'))) continue;
        step = Math.floor(Date.now() / 30000);
      }
      lastStep = step;
      codesEntered++;
      await typeAndSubmit(page, screens.codeInput, totp(totpSecret, step));
      await leave('codeInput');
      continue;
    }
    if (await visible('codeChoice')) { await screens.codeChoice.click(); await leave('codeChoice'); continue; }
    // The Authenticator push (the account's default method): switch to the code.
    if (await visible('pushWait') && await visible('otherWay')) { await screens.otherWay.click(); await leave('pushWait'); continue; }
    // Yes: Microsoft then remembers this browser, which step 1 relies on.
    if (await visible('staySignedIn')) { await page.click('#idSIButton9'); await leave('staySignedIn'); continue; }
    // "Pick an account" (checked last: other screens show the email too).
    if (await visible('account')) { await screens.account.click(); await leave('account'); continue; }
    throw new MoodleBrowserError('Unexpected screen during the Microsoft sign-in', 'LOGIN_FAILED');
  }
  if (!onMoodle(page.url())) throw new MoodleBrowserError('Did not get back to Moodle after signing in', 'LOGIN_FAILED');
}

async function scriptedSignIn(creds) {
  const { chromium } = require('playwright-core');
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME_PATH,
    headless: !process.env.MOODLE_LOGIN_DISPLAY,
    // Playwright turns Chrome's sandbox off by default (--no-sandbox, with a
    // warning bar); keep it on like a normal Chrome.
    chromiumSandbox: true,
    // A normal-looking Chrome: no "controlled by automated software" flag.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    env: chromeEnv(),
  });
  try {
    const page = context.pages()[0] || await context.newPage();
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
    return await context.cookies();
  } finally {
    await context.close();
  }
}

// ── Renewal ─────────────────────────────────────────────────────

// Keeps only Moodle's cookies: Microsoft's stay in the Chrome profile.
function saveSession(cookies) {
  const host = new URL(MOODLE_URL).hostname;
  const mine = cookies.filter((c) => {
    const d = c.domain.replace(/^\./, '');
    return host === d || host.endsWith('.' + d);
  });
  const tmp = SESSION_STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ cookies: mine, origins: [] }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSION_STATE_PATH);
}

async function sessionWorks() {
  const moodleHttp = require('./moodle-http');
  try {
    await moodleHttp.getPage('/my/');
    return true;
  } catch (e) {
    if (e instanceof moodleHttp.SessionExpiredError) return false;
    throw e;
  }
}

// Whether Microsoft's "Stay signed in" cookie is in the profile and not
// expired: without it, opening the LMS can't sign in (and is skipped).
function microsoftRemembers() {
  if (!fs.existsSync(PROFILE_DIR)) return false;
  return readBrowserCookies('login.microsoftonline.com')
    .some((c) => c.name === 'ESTSAUTHPERSISTENT' && (c.expires === -1 || c.expires * 1000 > Date.now()));
}

async function signIn() {
  if (microsoftRemembers()) {
    await browserVisit(`${MOODLE_URL}/my/`);
    saveSession(readBrowserCookies(new URL(MOODLE_URL).hostname));
    if (await sessionWorks()) return 'Signed in to Moodle (the browser was still signed in to Microsoft)';
  }
  const creds = readCredentials();
  if (!creds.username || !creds.password) {
    throw new MoodleBrowserError(`The browser isn't signed in to Microsoft and there are no sign-in details (MOODLE_USERNAME/MOODLE_PASSWORD in ${creds.file})`, 'NO_CREDENTIALS');
  }
  saveSession(await scriptedSignIn(creds));
  return 'Signed in to Moodle (password and authenticator code)';
}

// `login`: renews unless the saved session still works (--force: always).
// `login --auto` (the server, after the session expired): renews, unless an
// earlier automatic attempt failed and no manual one has succeeded since.
async function cli(args) {
  const auto = args.includes('--auto');
  if (auto && fs.existsSync(FAILED_PATH)) {
    const failed = JSON.parse(fs.readFileSync(FAILED_PATH, 'utf8'));
    throw new MoodleBrowserError(`automatic sign-in is paused since it failed on ${new Date(failed.at).toLocaleString('en-GB')} (${failed.message}); run campdash login`, 'LOGIN_PAUSED');
  }
  if (!auto && !args.includes('--force') && await sessionWorks()) {
    return 'Already signed in to Moodle (--force renews anyway)';
  }
  let result;
  try {
    result = await signIn();
  } catch (e) {
    fs.writeFileSync(FAILED_PATH, JSON.stringify({ at: Date.now(), message: e.message }));
    throw e;
  }
  fs.rmSync(FAILED_PATH, { force: true });
  fs.rmSync(FAILED_SHOT_PATH, { force: true });
  return result;
}

// Called by the server when Moodle says the session expired: renews it in a
// child process. Concurrent callers share one attempt.
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

module.exports = { MoodleBrowserError, refreshSession, browserVisit, readBrowserCookies };
