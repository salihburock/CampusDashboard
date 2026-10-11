// ── Moodle LMS connection ─────────────────────────────────────
// Lets a user pull their courses, upcoming deadlines and grades from the
// university's Moodle into the dashboard. Adapted from Mcp4Lms
// (https://github.com/threos/mcp4lms).
//
// How the token is obtained: a bookmarklet that runs on the Moodle page
// (where the user is already logged in) asks Moodle's mobile-app launch
// page for a token, the same way the official Moodle app does, and hands
// it to /account in the URL fragment (never sent to any server). The
// account page strips the fragment and POSTs the token here.
//
// The token is stored per user in userdata/<user>/moodle.json, encrypted
// with AES-256-GCM under a key derived from SESSION_SECRET. Only the
// read-only web service functions on the allowlist below can be called.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ALLOWED_FUNCTIONS = new Set([
  'core_webservice_get_site_info',
  'core_enrol_get_users_courses',
  'core_calendar_get_action_events_by_timesort',
  'gradereport_user_get_grade_items',
  'core_course_get_contents',
]);

const MOODLE_URL = (process.env.MOODLE_URL || '').trim().replace(/\/+$/, '');

function normalizeSiteUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

class MoodleError extends Error {
  constructor(message, code) { super(message); this.code = code; }
  get isAuthError() { return this.code === 'invalidtoken' || this.code === 'accessexception'; }
}

// Moodle REST expects PHP-style form params: ids[0]=1&ids[1]=2, opts[a]=b.
function flatten(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out);
    else out.append(key, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return out;
}

async function call(token, wsfunction, params = {}) {
  if (!ALLOWED_FUNCTIONS.has(wsfunction)) throw new MoodleError(`Function not allowed: ${wsfunction}`);
  const body = flatten(params);
  body.set('wstoken', token);
  body.set('wsfunction', wsfunction);
  body.set('moodlewsrestformat', 'json');
  let res;
  try {
    res = await fetch(`${MOODLE_URL}/webservice/rest/server.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'campus-dashboard' },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new MoodleError(`Could not reach Moodle: ${e.message}`);
  }
  if (!res.ok) throw new MoodleError(`Moodle returned HTTP ${res.status}`);
  const data = await res.json();
  if (data && typeof data === 'object' && 'exception' in data) {
    throw new MoodleError(data.message || 'Moodle error', data.errorcode);
  }
  return data;
}

// ── Token storage ─────────────────────────────────────────────
function tokenKey() {
  return Buffer.from(crypto.hkdfSync('sha256', process.env.SESSION_SECRET, 'campus-dashboard',
    'campus-dashboard/moodle-token/v1', 32));
}

function encryptToken(owner, token) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv);
  c.setAAD(Buffer.from(owner));
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function decryptToken(owner, stored) {
  const buf = Buffer.from(stored, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', tokenKey(), buf.subarray(0, 12));
  d.setAAD(Buffer.from(owner));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

function connFile(owner) { return path.join(__dirname, 'userdata', owner, 'moodle.json'); }

function loadConnection(owner) {
  try { return JSON.parse(fs.readFileSync(connFile(owner), 'utf8')); }
  catch { return null; }
}

// The connection with its token decrypted, or null when there is none (or
// SESSION_SECRET changed since it was stored, which makes it unreadable).
function unlock(owner) {
  const conn = loadConnection(owner);
  if (!conn || normalizeSiteUrl(conn.siteUrl) !== normalizeSiteUrl(MOODLE_URL)) return null;
  try { return { ...conn, token: decryptToken(owner, conn.token) }; }
  catch { return null; }
}

// Verify a token against the configured site and store it.
// siteId/passport come from the bookmarklet: Moodle's launch page returns
// md5(wwwroot + passport) next to the token, which confirms where it came from.
async function connect(owner, { token, siteId, passport }) {
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9]{16,128}$/.test(token)) throw new MoodleError('That does not look like a Moodle token');
  const info = await call(token, 'core_webservice_get_site_info');
  if (normalizeSiteUrl(info.siteurl) !== normalizeSiteUrl(MOODLE_URL)) {
    throw new MoodleError('The token belongs to a different Moodle site');
  }
  if (siteId || passport) {
    const expected = crypto.createHash('md5').update(info.siteurl + String(passport || '')).digest('hex');
    if (expected !== siteId) throw new MoodleError('The token did not come from this Moodle site');
  }
  const conn = {
    siteUrl: MOODLE_URL,
    sitename: info.sitename,
    userId: info.userid,
    fullname: info.fullname,
    token: encryptToken(owner, token),
    connectedAt: new Date().toISOString(),
  };
  fs.writeFileSync(connFile(owner), JSON.stringify(conn, null, 2));
  return publicStatus(conn);
}

function disconnect(owner) {
  try { fs.unlinkSync(connFile(owner)); } catch {}
}

function publicStatus(conn) {
  return {
    configured: !!MOODLE_URL,
    siteUrl: MOODLE_URL || null,
    connected: !!conn,
    sitename: conn ? conn.sitename : null,
    fullname: conn ? conn.fullname : null,
    connectedAt: conn ? conn.connectedAt : null,
  };
}

function status(owner) {
  return publicStatus(MOODLE_URL ? unlock(owner) : null);
}

// ── Formatting helpers ────────────────────────────────────────
const NAMED_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripHtml(html, max = 300) {
  if (!html) return '';
  const text = decodeEntities(String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// Local calendar date (the dashboard stores deadlines as YYYY-MM-DD).
function ymd(unix) {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Data ──────────────────────────────────────────────────────
function requireConn(owner) {
  if (!MOODLE_URL) throw new MoodleError('Moodle is not configured on this server (MOODLE_URL)');
  const conn = unlock(owner);
  if (!conn) throw new MoodleError('Not connected to Moodle', 'notconnected');
  return conn;
}

async function listCourses(owner) {
  const conn = requireConn(owner);
  const courses = await call(conn.token, 'core_enrol_get_users_courses', { userid: conn.userId });
  const now = Date.now() / 1000;
  return courses.map(c => ({
    id: c.id,
    code: decodeEntities(c.shortname || ''),
    name: decodeEntities(c.fullname || c.shortname || ''),
    // "Current" = visible, already started (or starting within a month) and not ended.
    current: !c.hidden && (!c.startdate || c.startdate <= now + 30 * 86400) && (!c.enddate || c.enddate > now),
  }));
}

// Upcoming items the user still has to act on (assignments, quizzes, …),
// grouped by course id. Moodle leaves out what is already submitted.
async function upcomingEvents(token, courseIds) {
  const byCourse = {};
  const from = Math.floor(Date.now() / 1000) - 86400;
  let after;
  for (let page = 0; page < 5; page++) {
    const res = await call(token, 'core_calendar_get_action_events_by_timesort',
      { timesortfrom: from, limitnum: 50, aftereventid: after });
    const events = res.events || [];
    for (const ev of events) {
      const cid = ev.course && ev.course.id;
      if (!courseIds.has(cid)) continue;
      (byCourse[cid] = byCourse[cid] || []).push({
        moodleId: `${ev.modulename || 'event'}:${ev.instance || ev.id}`,
        title: decodeEntities(ev.activityname || ev.name || ''),
        deadline: ymd(ev.timesort),
        notes: ev.modulename && ev.modulename !== 'assign'
          ? ev.modulename.charAt(0).toUpperCase() + ev.modulename.slice(1)
          : '',
      });
    }
    if (events.length < 50) break;
    after = events[events.length - 1].id;
  }
  return byCourse;
}

// Graded items only; categories are left out. Matches the dashboard's
// { item, grade, range, percentage, weight, feedback } grade rows.
async function courseGrades(token, userId, courseId) {
  const res = await call(token, 'gradereport_user_get_grade_items', { courseid: courseId, userid: userId });
  const items = (res.usergrades && res.usergrades[0] && res.usergrades[0].gradeitems) || [];
  return items
    .filter(g => g.itemtype !== 'category' && g.gradeformatted && g.gradeformatted !== '-')
    .map(g => ({
      item: g.itemtype === 'course' ? 'Course total' : decodeEntities(g.itemname || ''),
      grade: decodeEntities(g.gradeformatted),
      range: decodeEntities(g.rangeformatted || ''),
      percentage: decodeEntities(g.percentageformatted || ''),
      weight: decodeEntities(g.weightformatted || ''),
      feedback: stripHtml(g.feedback),
    }));
}

// Courses (by Moodle id) with their upcoming deadlines and, optionally, grades.
async function fetchCourses(owner, courseIds, { grades = false } = {}) {
  const conn = requireConn(owner);
  const all = await listCourses(owner);
  const wanted = all.filter(c => courseIds.includes(c.id));
  const events = await upcomingEvents(conn.token, new Set(wanted.map(c => c.id)));
  const out = [];
  for (const c of wanted) {
    const course = { moodleId: c.id, code: c.code, name: c.name, homework: events[c.id] || [] };
    if (grades) {
      try { course.grades = await courseGrades(conn.token, conn.userId, c.id); }
      catch (e) { if (e.isAuthError) throw e; course.gradesError = e.message; }
    }
    out.push(course);
  }
  return out;
}

// Flat list of downloadable files across all of a course's sections/modules
// -- { section, module, filename, fileurl, filesize, mimetype }. fileurl is
// a Moodle pluginfile URL that still needs the token appended to be fetched
// (see downloadFile).
async function courseFiles(owner, courseId) {
  const conn = requireConn(owner);
  const sections = await call(conn.token, 'core_course_get_contents', { courseid: courseId });
  const files = [];
  for (const sec of sections || []) {
    for (const mod of sec.modules || []) {
      for (const f of mod.contents || []) {
        if (f.type !== 'file' || !f.fileurl) continue;
        files.push({
          section: decodeEntities(sec.name || 'General'),
          module: decodeEntities(mod.name || ''),
          filename: decodeEntities(f.filename || ''),
          fileurl: f.fileurl,
          filesize: f.filesize || 0,
          mimetype: f.mimetype || '',
        });
      }
    }
  }
  return files;
}

// Downloads one file from a URL returned by courseFiles. Moodle file URLs
// take the token as a query param rather than wsfunction/wstoken, so this
// doesn't go through call(); the host is checked against MOODLE_URL first
// since the token would otherwise leak to wherever fileurl points.
async function downloadFile(owner, fileurl) {
  const conn = requireConn(owner);
  const u = new URL(fileurl);
  if (normalizeSiteUrl(u.origin) !== normalizeSiteUrl(new URL(MOODLE_URL).origin)) {
    throw new MoodleError('Refusing to send the token to a non-Moodle host');
  }
  u.searchParams.set('token', conn.token);
  let res;
  try { res = await fetch(u, { signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw new MoodleError(`Could not download file: ${e.message}`); }
  if (!res.ok) throw new MoodleError(`Could not download file (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  MoodleError, status, connect, disconnect, listCourses, fetchCourses, courseFiles, downloadFile,
};
