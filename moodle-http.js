// ── Moodle over plain HTTP ───────────────────────────────────────
// Reads Moodle pages with the session cookie the headless login saved
// (moodle-browser.js), without starting a browser: one request per page
// instead of a page load's dozens. Only the webservice API is blocked for
// this server; ordinary pages accept the session cookie. When the session
// has expired this throws SessionExpiredError and the caller signs in again
// through the browser.

const fs = require('fs');
const path = require('path');
const { parse } = require('node-html-parser');

const MOODLE_URL = (process.env.MOODLE_URL || '').trim().replace(/\/+$/, '');
const SESSION_STATE_PATH = path.join(__dirname, 'userdata', '.moodle-browser-session.json');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

class SessionExpiredError extends Error {}

function cookieHeader() {
  let state;
  try { state = JSON.parse(fs.readFileSync(SESSION_STATE_PATH, 'utf8')); } catch { throw new SessionExpiredError('No saved Moodle session'); }
  const host = new URL(MOODLE_URL).hostname;
  return (state.cookies || [])
    .filter(c => { const d = c.domain.replace(/^\./, ''); return host === d || host.endsWith('.' + d); })
    .map(c => `${c.name}=${c.value}`).join('; ');
}

async function getPage(pathAndQuery) {
  const res = await fetch(MOODLE_URL + pathAndQuery, {
    headers: { Cookie: cookieHeader(), 'User-Agent': USER_AGENT },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  const location = res.headers.get('location') || '';
  if (res.status >= 300 && res.status < 400) {
    if (/\/login\/|microsoftonline/.test(location)) throw new SessionExpiredError('Moodle session expired');
    throw new Error(`Unexpected redirect to ${location}`);
  }
  if (!res.ok) throw new Error(`Moodle returned HTTP ${res.status}`);
  const html = await res.text();
  if (/<body[^>]+id="page-login-/.test(html)) throw new SessionExpiredError('Moodle session expired');
  return html;
}

function cellText(el) {
  if (!el) return '';
  for (const n of el.querySelectorAll('.action-menu, .visually-hidden, .accesshide, .sr-only')) n.remove();
  return el.text.replace(/\s+/g, ' ').trim();
}

// The user grade report as [{item, grade, range, percentage, weight,
// feedback}], the same shape the webservice sync produced (ungraded "-"
// items left out). Category header rows have no grade cell and are skipped.
function parseUserGrades(html) {
  const table = parse(html).querySelector('table.user-grade');
  if (!table) return [];
  const grades = [];
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.parentNode && tr.parentNode.tagName === 'THEAD') continue;
    const nameCell = tr.querySelector('.column-itemname');
    const gradeCell = tr.querySelector('.column-grade');
    if (!nameCell || !gradeCell) continue;
    const item = cellText(nameCell.querySelector('.rowtitle') || nameCell);
    const grade = cellText(gradeCell);
    if (!item || !grade || grade === '-') continue;
    grades.push({
      item,
      grade,
      range: cellText(tr.querySelector('.column-range')),
      percentage: cellText(tr.querySelector('.column-percentage')),
      weight: cellText(tr.querySelector('.column-weight')),
      feedback: cellText(tr.querySelector('.column-feedback')),
    });
  }
  return grades;
}

async function courseGrades(courseId, userId) {
  const url = userId
    ? `/course/user.php?mode=grade&id=${Number(courseId)}&user=${Number(userId)}`
    : `/grade/report/user/index.php?id=${Number(courseId)}`;
  return parseUserGrades(await getPage(url));
}

module.exports = { SessionExpiredError, getPage, parseUserGrades, courseGrades };
