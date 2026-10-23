#!/usr/bin/env node
// Command-line access to the dashboard for AI agents (and you), run on this
// machine, e.g. `ssh legion 'node ~/CampusDashboard/scripts/agent.js courses'`.
// Talks to the running server on loopback with AGENT_TOKEN from .env (see
// the "Agent token" block in server.js), so everything goes through the same
// API, Moodle client and file sync as the web UI. Output is JSON unless noted.
//
//   status                      Moodle connection + active semester
//   semesters                   all semesters
//   courses                     courses in the active semester (summary)
//   course <code>               one course item in full: deadlines, grades,
//                               files, notes (fuzzy code match)
//   deadlines [days=30]         homework/exams due in the next N days (text)
//   files <code>                the course's files, absolute paths (text)
//   moodle-courses              courses Moodle lists for you
//   sync [code]                 Fetch what's new on Moodle (files, deadlines,
//                               grades) into the dashboard, like the editor's
//                               Sync button, and wait for it. Prints the new
//                               or changed files (absolute paths) and the
//                               deadlines per course. Files already synced
//                               aren't downloaded again.
//   zip <code> [out.zip | -]    Everything in one Moodle course as a zip
//                               (original files, assignment texts, pages,
//                               grades and a manifest.json), like the LMS
//                               Downloader extension's button; "-" writes it
//                               to stdout. Downloads every file each time.
//
// From another machine, over ssh (the files live on this one):
//   ssh legion 'node ~/CampusDashboard/scripts/agent.js sync EE341'
//   rsync -a legion:<path printed by sync or files> ./
//   ssh legion 'node ~/CampusDashboard/scripts/agent.js zip EE341 -' > ee341.zip
//
// --sem <id> targets another semester than the active one.

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return { ...env, ...process.env };
}

const ENV  = loadEnv();
const BASE = `http://127.0.0.1:${ENV.PORT || 3000}`;
if (!ENV.AGENT_TOKEN) die('AGENT_TOKEN is not set in .env');

function die(msg) { console.error(msg); process.exit(1); }

let SEM = '';
async function api(method, url, body) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(BASE + url + (SEM && url === '/api/data' ? `${sep}sem=${SEM}` : ''), {
    method,
    headers: { Authorization: `Bearer ${ENV.AGENT_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${method} ${url}: HTTP ${res.status} ${data.error || ''}${data.reconnect ? ' (reconnect Moodle on the Account page)' : ''}`);
  return data;
}

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const courseItems = data => data.sections.flatMap(s => s.type === 'courses' ? s.items : []);

function findCourse(data, code) {
  const q = norm(code);
  const items = courseItems(data);
  const hits = items.filter(i => norm(i.code).startsWith(q)) ;
  const hit = hits.length ? hits : items.filter(i => norm(i.code).includes(q) || norm(i.name).includes(q));
  if (hit.length !== 1) die(hit.length ? `"${code}" matches: ${hit.map(i => i.code).join(', ')}` : `No course matches "${code}"`);
  return hit[0];
}

// ── Commands ──────────────────────────────────────────────────
async function owner() { return (await api('GET', '/auth/me')).username || ENV.AGENT_USER; }
const docPath = async rel => rel ? path.join(ROOT, 'userdata', await owner(), rel) : '';

const commands = {
  async status() {
    const [moodle, sems] = await Promise.all([api('GET', '/api/moodle/status'), api('GET', '/api/semesters')]);
    const active = sems.semesters.find(s => s.id === sems.active);
    return { moodle, activeSemester: active };
  },

  semesters: () => api('GET', '/api/semesters'),

  async courses() {
    const data = await api('GET', '/api/data');
    return courseItems(data).map(c => ({
      code: c.code, name: c.name, moodleId: c.moodleId || null,
      syllabus: c.syllabus || '', homework: (c.homework || []).length, exams: (c.exams || []).length,
      resources: (c.resources || []).length, slides: (c.slides || []).length,
      materialsDir: (c.resources || []).map(r => r.file).find(f => f && f.startsWith('docs/materials/'))
        ?.split('/').slice(0, 3).join('/') || null,
    }));
  },

  async course(code) {
    if (!code) die('usage: course <code>');
    return findCourse(await api('GET', '/api/data'), code);
  },

  async deadlines(days = '30') {
    const data = await api('GET', '/api/data');
    const today = new Date().toISOString().slice(0, 10);
    const until = new Date(Date.now() + Number(days) * 86400000).toISOString().slice(0, 10);
    const rows = [];
    for (const c of courseItems(data)) {
      for (const h of c.homework || []) if (h.deadline) rows.push([h.deadline, c.code, 'HW', h.title, h.url || '']);
      for (const e of c.exams || []) if (e.date) rows.push([e.date, c.code, 'EXAM', `${e.type || ''} ${e.room || ''}`.trim(), '']);
    }
    rows.sort((a, b) => a[0].localeCompare(b[0]));
    const lines = rows.filter(r => r[0] >= today && r[0] <= until).map(r => r.filter(Boolean).join('  '));
    return lines.join('\n') || `Nothing due in the next ${days} days.`;
  },

  async files(code) {
    if (!code) die('usage: files <code>');
    const c = findCourse(await api('GET', '/api/data'), code);
    const out = [];
    if (c.syllabus) out.push(`syllabus\t${await docPath(c.syllabus)}`);
    for (const k of ['slides', 'resources', 'homework']) {
      for (const r of c[k] || []) if (r.file) out.push(`${k}\t${r.notes || ''}\t${await docPath(r.file)}`);
    }
    for (const e of c.exams || []) if (e.sampleFile) out.push(`exams\t${e.type || ''}\t${await docPath(e.sampleFile)}`);
    return out.join('\n');
  },

  'moodle-courses': () => api('GET', '/api/moodle/courses'),

  // Same run as the editor's Sync button, waited for. Prints, per course,
  // the files that are new or changed (absolute paths) and the deadlines.
  async sync(code) {
    const startedAt = Date.now();
    await api('POST', '/api/moodle/browser-sync', code ? { course: code } : {});
    console.error(`Syncing ${code || 'all courses'} from Moodle …`);
    let st;
    do {
      await new Promise(r => setTimeout(r, 2000));
      st = await api('GET', '/api/moodle/browser-sync');
    } while (st.running || !(st.finishedAt >= startedAt));
    const r = st.lastResult || {};
    if (r.error || r.skipped) die(`sync ${r.error ? `failed: ${r.error}` : `skipped: ${r.skipped}`}`);
    for (const u of r.updates || []) u.newFiles = await Promise.all(u.newFiles.map(docPath));
    return { courses: r.courses, failed: r.failed, updates: r.updates };
  },

  async zip(code, out) {
    if (!code) die('usage: zip <code> [out.zip]');
    const res = await fetch(`${BASE}/api/moodle/zip?course=${encodeURIComponent(code)}`, {
      headers: { Authorization: `Bearer ${ENV.AGENT_TOKEN}` },
    });
    if (!res.ok) die(`zip ${code}: HTTP ${res.status} ${(await res.json().catch(() => ({}))).error || ''}`);
    const name = (/filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'course.zip';
    const data = Buffer.from(await res.arrayBuffer());
    if (out === '-') { process.stdout.write(data); process.exit(0); }
    const dest = path.resolve(out || name);
    fs.writeFileSync(dest, data);
    return dest;
  },
};

(async () => {
  const argv = process.argv.slice(2);
  const si = argv.indexOf('--sem');
  if (si >= 0) { SEM = argv[si + 1] || ''; argv.splice(si, 2); }
  const [cmd, ...rest] = argv;
  if (!commands[cmd]) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 33).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
  const out = await commands[cmd](...rest);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
})().catch(e => die(e.message));
