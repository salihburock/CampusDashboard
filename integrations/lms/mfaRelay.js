const config = require('./config');

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tells the relay which number to tap on the Authenticator app (the relay's
// background poller has already detected the pending push and read the
// on-screen button options via ADB/uiautomator — we just supply the number
// Microsoft displayed in the browser). Retries a few times: the relay
// returns approved:false with 409 if its poller hasn't picked up the pending
// notification yet, which clears up within a couple of seconds.
async function approveMfa(number) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${config.mfaRelayUrl()}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MFA-Token': config.mfaRelayToken(),
        },
        body: JSON.stringify({ number }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(`Could not reach MFA relay at ${config.mfaRelayUrl()}: ${err.message} (is this machine's IP in the relay's allowlist?)`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.approved === true) return data;

    lastError = new Error(`MFA relay did not approve number ${number}: HTTP ${res.status} ${JSON.stringify(data)}`);
    if (attempt < MAX_ATTEMPTS) {
      console.log(`[mfa-relay] attempt ${attempt}/${MAX_ATTEMPTS} not approved yet, retrying in ${RETRY_DELAY_MS}ms...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

module.exports = { approveMfa };
