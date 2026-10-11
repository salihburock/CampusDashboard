const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return value;
}

module.exports = {
  lmsUsername: () => required('LMS_USERNAME'),
  lmsPassword: () => required('LMS_PASSWORD'),
  mfaRelayUrl: () => required('MFA_RELAY_URL').replace(/\/+$/, ''),
  mfaRelayToken: () => required('MFA_RELAY_TOKEN'),
  headful: process.env.LMS_HEADFUL === 'true',
};
