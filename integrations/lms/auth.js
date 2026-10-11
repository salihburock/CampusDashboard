const fs = require('fs');
const path = require('path');
const config = require('./config');
const { approveMfa } = require('./mfaRelay');

const DEBUG_DIR = path.join(__dirname, 'debug');

// Dumps a screenshot + HTML snapshot of the current page. Selectors on
// Microsoft's login pages are effectively undocumented and can shift, so
// every failure path calls this to leave something to inspect instead of
// just an opaque timeout error.
async function dumpDebug(page, label) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `${stamp}-${label}.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${stamp}-${label}.html`), await page.content());
    console.error(`Debug artifacts written to integrations/lms/debug/${stamp}-${label}.{png,html}`);
  } catch (err) {
    console.error('Failed to write debug artifacts:', err.message);
  }
}

// Microsoft's login pages sometimes transition (federation redirect, or
// switching from a disabled to an enabled button) *during* the click, which
// makes Playwright's actionability retries chase a moving target and time
// out even though the click already landed. Don't let that be fatal — the
// caller checks what state the page is actually in afterwards.
async function clickSubmit(page) {
  const btn = page.locator('#idSIButton9, button[type="submit"], input[type="submit"]').first();
  await btn.waitFor({ timeout: 15000 });
  await btn.click({ timeout: 10000 }).catch(() => {});
}

// Races several locators and returns the key of whichever becomes visible
// first, or null if none do within the timeout.
async function waitForAny(locatorsByKey, timeout) {
  const promises = Object.entries(locatorsByKey).map(([key, locator]) =>
    locator.waitFor({ timeout }).then(() => key)
  );
  try {
    return await Promise.any(promises);
  } catch {
    return null;
  }
}

// Microsoft's number-matching MFA screen shows a 2-digit number and waits
// for the same number to be tapped in Authenticator. If the device/session
// is already trusted this screen never appears, which is fine. A "Verify
// your identity" method-chooser (Authenticator / code / text / call) can
// appear first — e.g. after the password fallback, or as a retry following
// a prior failed verification — so click through it if present.
async function handleMfaIfPresent(page) {
  const numberLocator = page.locator('#idRemoteNGC_DisplaySign, #idRichContext_DisplaySign').first();
  const chooserTile = page.locator('[aria-label="Approve a request on my Microsoft Authenticator app"]').first();

  let state = await waitForAny({ mfa: numberLocator, chooser: chooserTile }, 15000);
  if (state === 'chooser') {
    await chooserTile.click();
    console.log('[step] clicked Authenticator tile on method-chooser screen');
    state = await waitForAny({ mfa: numberLocator }, 20000);
  }
  if (state !== 'mfa') return;

  const numberText = ((await numberLocator.textContent()) || '').trim();
  const number = parseInt(numberText, 10);
  if (Number.isNaN(number)) {
    await dumpDebug(page, 'mfa-number-parse-failed');
    throw new Error(`Could not parse MFA number from "${numberText}"`);
  }

  // Give the relay's background poller a moment to notice the pending
  // Authenticator notification via ADB before we ask it to approve.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`MFA prompt: approving number ${number} via relay...`);
  await approveMfa(number);

  await numberLocator.waitFor({ state: 'detached', timeout: 60000 }).catch(async () => {
    await dumpDebug(page, 'mfa-not-cleared');
    throw new Error('Relay reported approval but the MFA prompt never cleared in the browser');
  });
}

// "Stay signed in?" (KMSI) prompt — click No, since sessions aren't persisted
// between runs anyway (see project decision: fresh MFA every run).
async function handleStaySignedIn(page) {
  const noBtn = page.locator('#idBtn_Back');
  const appeared = await noBtn.waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  if (appeared) await noBtn.click();
}

async function loginToLms(page) {
  await page.goto('https://lms.ozyegin.edu.tr/login/index.php', { waitUntil: 'networkidle' });

  const emailInput = page.locator('input[type="email"], input[name="loginfmt"]').first();
  await emailInput.waitFor({ timeout: 20000 });
  await emailInput.fill(config.lmsUsername());
  console.log(`[step] email filled, url=${page.url()}`);
  await clickSubmit(page);
  console.log(`[step] after email submit, url=${page.url()}`);

  // Depending on the account, Next either leads to a password field or
  // (passwordless / Authenticator-first accounts) straight to the MFA
  // number-match screen — branch on whichever actually shows up.
  // NOTE: Microsoft's login page has a hidden decoy password input
  // (id="i0118", class="moveOffScreen", aria-hidden="true") present from
  // the very first screen, used for browser-autofill detection. It's
  // technically visible per plain CSS so a bare input[type=password]
  // selector matches it instantly and always wins the race below —
  // excluding aria-hidden fields is what makes this only match the real,
  // user-facing password field.
  const passwordInput = page.locator('input[type="password"]:not([aria-hidden="true"])').first();
  const mfaNumberLocator = page.locator('#idRemoteNGC_DisplaySign, #idRichContext_DisplaySign').first();
  const chooserTile = page.locator('[aria-label="Approve a request on my Microsoft Authenticator app"]').first();
  const notSentHeading = page.getByText("Request wasn't sent", { exact: false }).first();
  // "Use my password" (chooser tile) or "Use your password instead" (link
  // shown on the MFA/notSent screens) — both switch to the password flow.
  const passwordFallback = page.getByText(/Use (my|your) password/i).first();

  let state = await waitForAny(
    { password: passwordInput, mfa: mfaNumberLocator, chooser: chooserTile, notSent: notSentHeading },
    30000
  );
  console.log(`[step] state after email=${state}, url=${page.url()}`);

  // The Authenticator push is unreliable on this account's device right
  // now, so prefer the password fallback over the push flow whenever it's
  // offered, instead of retrying the push.
  if (state === 'chooser' || state === 'notSent') {
    await passwordFallback.click();
    console.log(`[step] clicked password fallback from state=${state}`);
    state = await waitForAny({ password: passwordInput, mfa: mfaNumberLocator }, 30000);
    console.log(`[step] state after password fallback=${state}, url=${page.url()}`);
  }

  if (state === 'password') {
    await passwordInput.fill(config.lmsPassword());
    await clickSubmit(page);
    console.log(`[step] after password submit, url=${page.url()}`);
  } else if (state !== 'mfa') {
    await dumpDebug(page, 'unexpected-state-after-email');
    throw new Error(`Unexpected state after submitting email: ${state}`);
  }

  await handleMfaIfPresent(page);
  console.log(`[step] after handleMfaIfPresent, url=${page.url()}`);
  await handleStaySignedIn(page);
  console.log(`[step] after handleStaySignedIn, url=${page.url()}`);

  // Match on hostname only — the Microsoft login URL itself contains
  // "lms.ozyegin.edu.tr" inside its redirect_uri query param, so a plain
  // substring/regex match on the full URL falsely matches before login
  // actually completes.
  await page.waitForURL((url) => url.hostname === 'lms.ozyegin.edu.tr', { timeout: 30000 });
}

module.exports = { loginToLms, dumpDebug };
