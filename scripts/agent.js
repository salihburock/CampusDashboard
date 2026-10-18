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
//   course <code>               one course item in full (fuzzy code match)
//   deadlines [days=30]         homework/exams due in the next N days (text)
//   files <code>                the course's files, absolute paths (text)
//   moodle-courses              courses Moodle lists for you
//   sync [--grades] [--files] [code ...]
//                               Sync from Moodle like the editor's button.
//                               Without codes: current Moodle courses plus
//                               ones already synced. --files downloads new
//                               or changed course files (slow).
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

// ── Merge (ported from admin.js mergeMoodleCourses / mergeMoodleFiles) ──
const DEFAULT_COURSE = { code: '', name: '', credits: '', faculty: '', syllabus: '', slides: [], homework: [], exams: [], resources: [], notes: '' };

function mergeMoodleCourses(state, fetched, withGrades) {
  let section = state.sections.find(s => s.type === 'courses');
  if (!section) {
    section = { title: 'Courses', type: 'courses', collapsed: false, visibility: 'private', items: [] };
    state.sections.push(section);
  }
  let added = 0, deadlines = 0;
  for (const mc of fetched) {
    let course = courseItems(state).find(i => i.moodleId === mc.moodleId);
    const cat = mc.catalog;
    if (!course) {
      course = section.items.find(i => !i.moodleId && norm(i.code) &&
        (norm(mc.code).startsWith(norm(i.code)) || (cat && norm(cat.code) === norm(i.code))));
    }
    if (!course) {
      course = JSON.parse(JSON.stringify(DEFAULT_COURSE));
      course.code = cat ? cat.code : mc.code;
      course.name = mc.name;
      section.items.push(course);
      added++;
    }
    course.moodleId = mc.moodleId;
    if (!course.name) course.name = mc.name;
    if (cat) {
      if (!course.credits) course.credits = cat.credits;
      if (!course.faculty) course.faculty = cat.faculty;
      course.prerequisite = cat.prerequisite;
      course.corequisite = cat.corequisite;
      if (!course.notes) {
        course.notes = [cat.description,
          cat.prerequisite && 'Prerequisite: ' + cat.prerequisite,
          cat.corequisite && 'Corequisite: ' + cat.corequisite].filter(Boolean).join('\n');
      }
    }
    const old = new Map((course.homework || []).filter(h => h.moodleId).map(h => [h.moodleId, h]));
    const manual = (course.homework || []).filter(h => !h.moodleId);
    const synced = mc.homework.map(h => {
      const prev = old.get(h.moodleId);
      return { ...h, file: prev ? prev.file || '' : '', notes: prev ? prev.notes || '' : '' };
    });
    course.homework = [...manual, ...synced];
    deadlines += synced.length;
    if (withGrades && mc.grades) course.grades = mc.grades;
  }
  return { courses: fetched.length, added, deadlines };
}

function mergeMoodleFiles(state, moodleId, { syllabus, resources, homework }) {
  const course = courseItems(state).find(i => i.moodleId === moodleId);
  if (!course) return;
  if (syllabus) course.syllabus = syllabus;
  const extra = [];
  const filled = new Set();
  for (const h of homework || []) {
    const row = (course.homework || []).find(r => r.moodleId === `assign:${h.assignId}`);
    const ownFile = row && row.file && !row.file.startsWith('docs/materials/');
    if (row && !ownFile && !filled.has(row)) {
      row.file = h.file;
      filled.add(row);
    } else {
      extra.push({ title: h.title, file: h.file, notes: h.notes, moodleFileId: h.moodleFileId });
    }
  }
  const manual = (course.resources || []).filter(r => !r.moodleFileId);
  course.resources = [...manual, ...(resources || []), ...extra];
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

  async sync(...args) {
    const grades = args.includes('--grades'), files = args.includes('--files');
    const codes = args.filter(a => !a.startsWith('--'));
    const [moodleCourses, data] = await Promise.all([api('GET', '/api/moodle/courses'), api('GET', '/api/data')]);
    const synced = new Set(courseItems(data).map(i => i.moodleId).filter(Boolean));
    const picked = codes.length
      ? moodleCourses.filter(c => codes.some(q => norm(c.code).startsWith(norm(q)) || norm(c.code).includes(norm(q))))
      : moodleCourses.filter(c => c.current || synced.has(c.id));
    if (!picked.length) die('No Moodle courses matched');
    console.error(`Syncing: ${picked.map(c => c.code).join(', ')}`);

    const fetched = await api('POST', '/api/moodle/fetch', { courseIds: picked.map(c => c.id), grades });
    const counts = mergeMoodleCourses(data, fetched, grades);
    const fileStats = [];
    if (files) {
      for (const mc of fetched) {
        console.error(`Files: ${mc.code} …`);
        const res = await api('POST', '/api/moodle/files', { courseId: mc.moodleId, code: mc.code });
        mergeMoodleFiles(data, mc.moodleId, res);
        fileStats.push({ code: mc.code, ...res.stats });
      }
    }
    await api('PUT', '/api/data', data);
    return { ...counts, files: fileStats };
  },
};

(async () => {
  const argv = process.argv.slice(2);
  const si = argv.indexOf('--sem');
  if (si >= 0) { SEM = argv[si + 1] || ''; argv.splice(si, 2); }
  const [cmd, ...rest] = argv;
  if (!commands[cmd]) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 21).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
  const out = await commands[cmd](...rest);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
})().catch(e => die(e.message));
