// ── Moodle over plain HTTP ───────────────────────────────────────
// Reads Moodle pages and files with the session cookie the headless login
// saved (moodle-browser.js), without starting a browser: one request per
// page instead of a page load's dozens. The webservice API (account tokens)
// is blocked for servers by the university; ordinary pages accept the
// session cookie like they do from a browser. When the session has expired
// this throws SessionExpiredError and the caller signs in again through the
// browser.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
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

// One request with the session cookie, to Moodle only (the cookie must not
// go anywhere else). Redirects are not followed, so a bounce to the login
// page shows up as SessionExpiredError instead of a login page.
async function request(pathOrUrl, { method = 'GET', headers = {}, body, timeout = 30000 } = {}) {
  const url = new URL(pathOrUrl, MOODLE_URL + '/');
  if (url.origin !== new URL(MOODLE_URL).origin) throw new Error(`Not a Moodle URL: ${url.href}`);
  const res = await fetch(url, {
    method, body,
    headers: { Cookie: cookieHeader(), 'User-Agent': USER_AGENT, ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
  });
  const location = res.headers.get('location') || '';
  if (res.status >= 300 && res.status < 400 && /\/login\/|microsoftonline/.test(location)) {
    throw new SessionExpiredError('Moodle session expired');
  }
  return res;
}

async function getPage(pathAndQuery) {
  const res = await request(pathAndQuery);
  if (res.status >= 300 && res.status < 400) throw new Error(`Unexpected redirect to ${res.headers.get('location')}`);
  if (!res.ok) throw new Error(`Moodle returned HTTP ${res.status}`);
  const html = await res.text();
  if (/<body[^>]+id="page-login-/.test(html)) throw new SessionExpiredError('Moodle session expired');
  return html;
}

// Where a link redirects to (absolute URL), without following it; null when
// it answers with a page instead.
async function redirectTarget(pathAndQuery) {
  const res = await request(pathAndQuery);
  await res.body?.cancel();
  if (res.status >= 300 && res.status < 400) return new URL(res.headers.get('location'), MOODLE_URL + '/').href;
  if (!res.ok) throw new Error(`Moodle returned HTTP ${res.status}`);
  return null;
}

function filenameFrom(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  let name = m ? m[1] : new URL(url).pathname.split('/').pop();
  try { name = decodeURIComponent(name); } catch {}
  return name;
}

// Streams a Moodle file (pluginfile.php URL, or a link that redirects to one)
// to destPath. Returns { filename, size, modified (unix), type }, or
// { tooLarge: true, size } without downloading when it is over maxBytes.
async function download(url, destPath, { maxBytes = Infinity } = {}) {
  let res = await request(url, { timeout: 10 * 60000 });
  for (let i = 0; i < 3 && res.status >= 300 && res.status < 400; i++) {
    await res.body?.cancel();
    url = new URL(res.headers.get('location'), url).href;
    res = await request(url, { timeout: 10 * 60000 });
  }
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Moodle returned HTTP ${res.status}`); }
  const size = Number(res.headers.get('content-length')) || 0;
  if (size > maxBytes) { await res.body?.cancel(); return { tooLarge: true, size }; }
  const type = res.headers.get('content-type') || '';
  const filename = filenameFrom(res, url);
  // A web page where a file was expected: the login page, or an error page.
  if (/text\/html/i.test(type) && !/\.html?$/i.test(filename)) {
    const html = await res.text();
    if (/<body[^>]+id="page-login-/.test(html)) throw new SessionExpiredError('Moodle session expired');
    throw new Error('Moodle answered with a web page instead of the file');
  }
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  } catch (e) {
    try { fs.unlinkSync(destPath); } catch {}
    throw e;
  }
  const modified = Math.floor(new Date(res.headers.get('last-modified') || 0).getTime() / 1000) || 0;
  return { filename, size: size || fs.statSync(destPath).size, modified, type };
}

// ── Moodle's own page API ───────────────────────────────────────
// The JSON API Moodle's pages call themselves (lib/ajax/service.php): session
// cookie plus the page's sesskey. Only functions Moodle marks for page use
// answer here, e.g. the course list; most others say "servicenotavailable".
let sesskeyCache = { cookie: null, key: null };

async function sesskey() {
  const cookie = cookieHeader();
  if (sesskeyCache.cookie === cookie) return sesskeyCache.key;
  const key = ((await getPage('/my/')).match(/"sesskey":"([^"]+)"/) || [])[1];
  if (!key) throw new Error('Could not find the sesskey on the Moodle page');
  sesskeyCache = { cookie, key };
  return key;
}

async function ajax(methodname, args = {}) {
  const res = await request(`/lib/ajax/service.php?sesskey=${encodeURIComponent(await sesskey())}&info=${methodname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ index: 0, methodname, args }]),
  });
  if (!res.ok) throw new Error(`Moodle returned HTTP ${res.status}`);
  const [r] = await res.json();
  if (r && r.error) {
    const ex = r.exception || {};
    if (/requirelogin|invalidsesskey/i.test(ex.errorcode || '')) {
      sesskeyCache = { cookie: null, key: null };
      throw new SessionExpiredError('Moodle session expired');
    }
    throw new Error(ex.message || `Moodle error in ${methodname}`);
  }
  return r.data;
}

const plain = (s) => parse(String(s || '')).text.trim();

// The courses Moodle shows as "In progress": [{ id, shortname, fullname }].
async function enrolledCourses() {
  const data = await ajax('core_course_get_enrolled_courses_by_timeline_classification',
    { classification: 'inprogress', limit: 0, offset: 0, sort: 'fullname' });
  return (data.courses || []).map(c => ({ id: c.id, shortname: plain(c.shortname), fullname: plain(c.fullname) }));
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

module.exports = {
  SessionExpiredError, request, getPage, redirectTarget, download, ajax, enrolledCourses, parseUserGrades, courseGrades,
};
