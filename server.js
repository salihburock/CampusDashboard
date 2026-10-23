const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');
const { execFile } = require('child_process');
const AdmZip       = require('adm-zip');
const session      = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt       = require('bcryptjs');

// Load settings from .env (see .env.example)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const moodle = require('./moodle'); // reads MOODLE_URL, so after .env is loaded
const moodleBrowser = require('./moodle-browser');
const moodleHttp = require('./moodle-http');
const moodleZip = require('./moodle-zip');
const telegram = require('./telegram-bot');
const grading = require('./grading');
const { SUPPORTED_CONVERSIONS, ConversionError, convertFile, convertManyToPdf } = require('./converter');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Users ─────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function findUser(username) {
  return loadUsers().find(u => u.username === username);
}

// Bootstrap: create default user on first run
if (!fs.existsSync(USERS_FILE)) {
  const defaultPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(8).toString('hex');
  saveUsers([{
    username: 'admin',
    passwordHash: bcrypt.hashSync(defaultPassword, 10),
    createdAt: new Date().toISOString()
  }]);
  console.log('='.repeat(50));
  console.log('First run — default admin account created.');
  console.log(`  Username: admin`);
  console.log(`  Password: ${defaultPassword}`);
  console.log('Change this password after first login!');
  console.log('='.repeat(50));
}

// ── Per-user data directories ─────────────────────────────────
function ensureUserDirs(username) {
  const userDir = path.join(__dirname, 'userdata', username);
  const docsDir = path.join(userDir, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const dataFile = path.join(userDir, 'data.json');
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({ title: `${username}'s Dashboard`, sections: [] }, null, 2));
  }

  const regFile = path.join(userDir, 'docs-registry.json');
  if (!fs.existsSync(regFile)) {
    fs.writeFileSync(regFile, JSON.stringify({}, null, 2));
  }
}

// ── Semesters ─────────────────────────────────────────────────
function currentTermName() {
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth(); // m: 0-11
  if (m >= 1 && m <= 5) return `${y - 1}-${y} Spring`;
  if (m >= 6 && m <= 7) return `${y} Summer`;
  return `${y}-${y + 1} Fall`;
}
function semestersFile(owner)     { return path.join(__dirname, 'userdata', owner, 'semesters.json'); }
function semesterDataFile(owner, id) { return path.join(__dirname, 'userdata', owner, 'semesters', `${id}.json`); }
function newSemId() { return 'sem_' + crypto.randomBytes(5).toString('hex'); }

// Lazily migrate a user to the semester model (legacy data.json → first semester)
function ensureSemesters(owner) {
  const f = semestersFile(owner);
  if (fs.existsSync(f)) return;
  const userDir = path.join(__dirname, 'userdata', owner);
  const semDir  = path.join(userDir, 'semesters');
  if (!fs.existsSync(semDir)) fs.mkdirSync(semDir, { recursive: true });

  const id = newSemId();
  let data = { title: `${owner}'s Dashboard`, sections: [] };
  const legacy = path.join(userDir, 'data.json');
  if (fs.existsSync(legacy)) { try { data = JSON.parse(fs.readFileSync(legacy, 'utf8')); } catch {} }

  fs.writeFileSync(semesterDataFile(owner, id), JSON.stringify(data, null, 2));
  fs.writeFileSync(f, JSON.stringify({
    active: id,
    semesters: [{ id, name: currentTermName(), archived: false, createdAt: new Date().toISOString() }]
  }, null, 2));
}
function loadSemesters(owner) {
  ensureSemesters(owner);
  try { return JSON.parse(fs.readFileSync(semestersFile(owner), 'utf8')); }
  catch { return { active: null, semesters: [] }; }
}
function saveSemesters(owner, data) {
  fs.writeFileSync(semestersFile(owner), JSON.stringify(data, null, 2));
}
// Read the data file of a user's active semester (used for public listing)
function loadActiveData(owner) {
  const sems = loadSemesters(owner);
  return JSON.parse(fs.readFileSync(semesterDataFile(owner, sems.active), 'utf8'));
}

// Ensure dirs for all existing users on startup
for (const u of loadUsers()) { ensureUserDirs(u.username); ensureSemesters(u.username); }

// Ensure every user has a share token and a display name
(function ensureUserFields() {
  const users = loadUsers();
  let dirty = false;
  for (const u of users) {
    if (!u.shareToken) { u.shareToken = crypto.randomBytes(6).toString('hex'); dirty = true; }
    if (!u.displayName) { u.displayName = u.username; dirty = true; }
  }
  if (dirty) saveUsers(users);
})();

// What guests see instead of the raw username
function displayNameOf(user) {
  return (user && user.displayName) || (user && user.username) || '';
}

// ── Agent token ───────────────────────────────────────────────
// Lets scripts/agent.js, run on this machine over SSH, use the API as
// AGENT_USER without a password. Off unless AGENT_TOKEN and AGENT_USER are
// set in .env, and only accepted on direct loopback connections. Runs before
// the session middleware, which skips requests that already carry a session.
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const AGENT_USER  = process.env.AGENT_USER  || '';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
app.use((req, res, next) => {
  const auth = req.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return next();
  const given = Buffer.from(auth.slice(7)), want = Buffer.from(AGENT_TOKEN);
  const ok = AGENT_TOKEN && AGENT_USER && findUser(AGENT_USER)
    && LOOPBACK.has(req.socket.remoteAddress) && !req.get('x-forwarded-for')
    && given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) return res.status(401).json({ error: 'Invalid agent token' });
  req.session = { user: AGENT_USER };
  next();
});

// ── Session setup ─────────────────────────────────────────────
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Auth Middleware ───────────────────────────────────────────
// Note: /i18n.js must be public — login.html loads it while the visitor has no
// session yet; without it window.t is undefined and the guest picker breaks.
const publicPaths = ['/login.html', '/i18n.js', '/auth/login', '/auth/register', '/api/users'];
app.use((req, res, next) => {
  if (publicPaths.includes(req.path) || req.path.startsWith('/d/')) return next();
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login.html');
});

// ── Path Helper ───────────────────────────────────────────────
function getPaths(req) {
  const mode = req.session && req.session.mode;
  let owner;
  if (mode === 'guest') {
    owner = req.session.guestViewUser;
    if (!owner || !findUser(owner)) return null;
  } else {
    owner = req.session.user;
  }
  if (!owner) return null;

  ensureUserDirs(owner);
  const userDir = path.join(__dirname, 'userdata', owner);

  // Resolve which semester's data file to use.
  // Guests always see the active semester; owners may target a specific one via ?sem=.
  const sems = loadSemesters(owner);
  let semId = sems.active;
  if (mode !== 'guest' && req.query && req.query.sem &&
      sems.semesters.some(s => s.id === req.query.sem)) {
    semId = req.query.sem;
  }

  return {
    DATA_FILE:     semesterDataFile(owner, semId),
    DOCS_DIR:      path.join(userDir, 'docs'),
    REGISTRY_FILE: path.join(userDir, 'docs-registry.json'),
    owner,
    semId
  };
}

// Inject paths into req
app.use((req, res, next) => {
  if (req.session && req.session.user) {
    req.paths = getPaths(req);
    if (!req.paths && req.session.mode === 'guest') {
      req.session.destroy();
      return req.path.startsWith('/api/')
        ? res.status(401).json({ error: 'No user selected' })
        : res.redirect('/login.html');
    }
  }
  next();
});

// ── Guest write guard ─────────────────────────────────────────
function requireUser(req, res, next) {
  if (!req.session || req.session.mode === 'guest') {
    return res.status(403).json({ error: 'Read-only in guest mode' });
  }
  next();
}

// ── Registry helpers ──────────────────────────────────────────
function loadRegistry(paths) {
  try { return JSON.parse(fs.readFileSync(paths.REGISTRY_FILE, 'utf8')); }
  catch { return {}; }
}
function saveRegistry(reg, paths) {
  fs.writeFileSync(paths.REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

// Cross-device safe move
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else throw e;
  }
}

// ── Ollama auto-naming ────────────────────────────────────────
const OLLAMA_HOST  = process.env.OLLAMA_HOST  || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
// Optional OpenAI-compatible chat API, tried first for picking a course's
// syllabus from its filenames (only the course code and filenames are sent).
const LLM_API_URL   = (process.env.LLM_API_URL || '').replace(/\/+$/, '');
const LLM_API_KEY   = process.env.LLM_API_KEY || '';
const LLM_API_MODEL = process.env.LLM_API_MODEL || '';

const NAMING_PROMPT =
  'You are naming a university document file. Based on this document text, return ONLY ' +
  'a short kebab-case filename (no extension) following this exact structure:\n' +
  '- Syllabus:            syllabus-{coursecode}           e.g. syllabus-ee321\n' +
  '- Homework/Assignment: hw-{coursecode}-{number}        e.g. hw-math301-3\n' +
  '- Exam/Quiz/Test:      exam-{coursecode}-{type}        e.g. exam-cs101-midterm\n' +
  '- Lecture slides:      slides-{coursecode}-week{n}     e.g. slides-phys102-week5\n' +
  '- Lab:                 lab-{coursecode}-{number}       e.g. lab-chem201-2\n' +
  '- Formula/reference:   ref-{coursecode}                e.g. ref-math301\n' +
  '- Other:               {type}-{coursecode}             e.g. notes-ee321\n' +
  'Use the course code visible in the document. Return ONLY the filename, nothing else.';

function extractPdfText(filePath) {
  return new Promise(resolve => {
    execFile('pdftotext', ['-f', '1', '-l', '3', filePath, '-'], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(stdout.slice(0, 100).trim() || null);
    });
  });
}

async function ollamaNamePdf(filePath) {
  try {
    const text = await extractPdfText(filePath);
    if (!text || text.length < 10) return null;
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: NAMING_PROMPT + '\n\nDocument text:\n' + text,
        stream: false,
        options: { num_predict: 30, temperature: 0.1 }
      })
    });
    if (!res.ok) return { error: 'api' };
    const json = await res.json();
    const raw = json.response?.trim() || '';
    const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return clean.length >= 3 ? clean : null;
  } catch (e) { return { error: 'network' }; }
}

async function geminiNamePdf(filePath) {
  if (!GEMINI_KEY) return null;
  try {
    const text = await extractPdfText(filePath);
    if (!text || text.length < 10) return null;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: NAMING_PROMPT + '\n\nDocument text:\n' + text }] }],
          generationConfig: { maxOutputTokens: 30, temperature: 0.1 }
        })
    });
    const json = await res.json();
    if (!res.ok) return { error: 'api' };
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return clean.length >= 3 ? clean : null;
  } catch (e) { return { error: 'network' }; }
}

async function autoNamePdf(filePath) {
  try {
    const ping = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (ping.ok) return ollamaNamePdf(filePath);
  } catch {}
  if (GEMINI_KEY) return geminiNamePdf(filePath);
  return null;
}

// ── Moodle file sync: filename-only classification ─────────────
// Course codes/names coming out of Moodle aren't always clean ("CS 321.A",
// "İşletim Sistemleri (Güz)", ...) and the file that's actually the syllabus
// isn't always named anything close to "syllabus". Rather than hardcode
// regexes for every variation, an LLM agent reads just the course code and
// the list of filenames (no downloads needed yet) and returns a safe folder
// slug plus which file, if any, looks like the syllabus.
const FILE_ORG_PROMPT =
  'You are organizing a university course\'s files for local storage. You will get a course ' +
  'code (possibly messy, e.g. with section letters, diacritics, or in another language) and a ' +
  'numbered list of filenames found in that course on Moodle.\n' +
  'Reply with ONLY a JSON object, no other text, no markdown fences:\n' +
  '{"slug": "lowercase-ascii-folder-name-for-this-course", "syllabusIndex": <number or -1>}\n' +
  '- slug: short, filesystem-safe (letters/digits/dashes only), derived from the course code, ' +
  'e.g. "CS 321.A" -> "cs321a".\n' +
  '- syllabusIndex: the index of the file that is the course syllabus / outline / "ders izlencesi" ' +
  '(judge by filename alone), or -1 if none of the filenames look like a syllabus.';

function regexFallbackClassify(code, filenames) {
  const slug = String(code || 'course').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'course';
  const syllabusIndex = filenames.findIndex(f => /syllabus|izlence|course.?outline/i.test(f));
  return { slug, syllabusIndex };
}

function parseClassifyResponse(raw, filenames) {
  const match = String(raw || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  const slug = String(parsed.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '');
  const idx = Number(parsed.syllabusIndex);
  if (!slug) return null;
  return { slug, syllabusIndex: Number.isInteger(idx) && idx >= 0 && idx < filenames.length ? idx : -1 };
}

async function classifyCourseFilesWithLlm(code, filenames) {
  const prompt = `${FILE_ORG_PROMPT}\n\nCourse code: ${code}\nFiles:\n` +
    filenames.map((f, i) => `${i}: ${f}`).join('\n');
  if (LLM_API_URL && LLM_API_KEY && LLM_API_MODEL) {
    try {
      const res = await fetch(`${LLM_API_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
        body: JSON.stringify({
          model: LLM_API_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024, // reasoning models spend part of this before answering
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const parsed = parseClassifyResponse((await res.json()).choices?.[0]?.message?.content, filenames);
        if (parsed) return parsed;
      } else {
        console.error(`Syllabus LLM API returned HTTP ${res.status}, falling back`);
      }
    } catch (e) { console.error('Syllabus LLM API failed, falling back:', e.message); }
  }
  try {
    const ping = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (ping.ok) {
      const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL, prompt, stream: false, options: { num_predict: 80, temperature: 0.1 }
        })
      });
      if (res.ok) {
        const parsed = parseClassifyResponse((await res.json()).response, filenames);
        if (parsed) return parsed;
      }
    }
  } catch {}
  if (GEMINI_KEY) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 80, temperature: 0.1 }
        })
      });
      if (res.ok) {
        const json = await res.json();
        const parsed = parseClassifyResponse(json.candidates?.[0]?.content?.parts?.[0]?.text, filenames);
        if (parsed) return parsed;
      }
    } catch {}
  }
  return regexFallbackClassify(code, filenames);
}

function sanitizeSegment(name) {
  return String(name || '').replace(/[^a-zA-Z0-9.\-_]/g, '_').replace(/^\.+/, '_') || 'file';
}

// Office files are turned into PDFs on sync so they open in the dashboard's
// PDF viewer (LibreOffice, see converter.js); if that fails the original
// file is kept. Files over MOODLE_MAX_FILE_MB (default 200) are skipped.
const MOODLE_TO_PDF = new Set(['doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'odp']);
const MOODLE_MAX_FILE_BYTES = (Number(process.env.MOODLE_MAX_FILE_MB) || 200) * 1024 * 1024;

// What earlier syncs saved, so unchanged files aren't downloaded and
// converted again: files[moodleFileId] = { stamp, file } and the LLM's
// slug/syllabus choice per course file list.
function moodleManifestPath(paths) { return path.join(path.dirname(paths.DOCS_DIR), 'moodle-files.json'); }
function loadMoodleManifest(paths) {
  try { return { files: {}, courses: {}, ...JSON.parse(fs.readFileSync(moodleManifestPath(paths), 'utf8')) }; }
  catch { return { files: {}, courses: {} }; }
}

// Runs fn over items, at most `limit` at a time.
async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

const md5 = s => crypto.createHash('md5').update(s).digest('hex');

// Lists a course's Moodle files, asks the LLM agent which one is the
// syllabus and what folder slug to use, downloads what is new or changed
// (converting Office files to PDF), and returns
//   { syllabus: "docs/..." | null,
//     resources: [{title, file, notes, moodleFileId}],
//     homework:  [{assignId, title, file, notes, moodleFileId}],
//     stats: { downloaded, unchanged, converted, skipped: [names], failed: [names],
//              added: ["docs/..." of the files downloaded this time] } }
// for the frontend to merge into the course item. homework holds the files
// of assignments, so they can go onto the matching homework row.
async function syncMoodleFiles(paths, code, moodleFiles, downloadFile = (owner, url, dest) => moodle.downloadFile(owner, url, dest)) {
  const stats = { downloaded: 0, unchanged: 0, converted: 0, skipped: [], failed: [], added: [] };
  if (!moodleFiles.length) return { syllabus: null, resources: [], homework: [], stats };
  const manifest = loadMoodleManifest(paths);

  const names = moodleFiles.map(f => f.filename);
  const listKey = md5(code + '\n' + moodleFiles.map(f => `${f.filename} ${f.fileurl.split('?')[0]}`).join('\n'));
  let cls = manifest.courses[listKey];
  if (!cls) {
    const { slug, syllabusIndex } = await classifyCourseFilesWithLlm(code, names);
    cls = manifest.courses[listKey] = {
      slug: /^[a-z0-9-]+$/.test(slug) ? slug : regexFallbackClassify(code, []).slug,
      syllabusUrl: syllabusIndex >= 0 ? moodleFiles[syllabusIndex].fileurl : null,
    };
  }
  // The folder name comes from the course code when there is one, so it
  // stays the same across syncs; the LLM's slug is only for messy names.
  const slug = courseSlug(code) || cls.slug;
  // A small model sometimes calls the only file it sees the syllabus, even
  // week-2 slides; don't accept a pick that is plainly coursework.
  const picked = moodleFiles.find(f => f.fileurl === cls.syllabusUrl);
  const syllabusUrl = picked && !looksLikeCoursework(picked.filename) ? picked.fileurl : null;

  // Where each file goes, and whether a copy from an earlier sync can stay.
  const plan = moodleFiles.map(f => {
    const id = md5(f.fileurl.split('?')[0]).slice(0, 12);
    const name = sanitizeSegment(f.filename);
    const ext = path.extname(name).slice(1).toLowerCase();
    const syllabus = f.fileurl === syllabusUrl;
    const sectionDir = sanitizeSegment(f.section);
    // dir is relative to the docs root; the file name is settled after conversion
    const dir = syllabus ? '' : `materials/${slug}/${sectionDir}`;
    const baseName = syllabus ? `syllabus-${slug}` : name.slice(0, name.length - (ext ? ext.length + 1 : 0));
    // A file the course zip skipped as already synced brings its old stamp.
    const stamp = f.stamp || `${f.timemodified}:${f.filesize}`;
    const prev = manifest.files[id];
    // The name must match too (not just stamp/folder), or a rename (e.g. a
    // corrected filename) would never replace the copy from an earlier sync.
    const expected = ext ? [`${baseName}.${ext}`, `${baseName}.pdf`] : [baseName];
    const reuse = prev && prev.stamp === stamp && path.posix.dirname(prev.file) === path.posix.join('docs', dir || '.')
      && expected.includes(path.posix.basename(prev.file))
      && fs.existsSync(path.join(paths.DOCS_DIR, prev.file.replace(/^docs\//, '')));
    return { f, id, name, ext, syllabus, dir, baseName, stamp, file: reuse ? prev.file : null };
  });

  // Download what's new or changed, 4 at a time, into a scratch dir.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle_sync_'));
  try {
    const todo = plan.filter(p => !p.file);
    stats.unchanged = plan.length - todo.length;
    await mapLimit(todo, 4, async (p, i) => {
      if (p.f.filesize > MOODLE_MAX_FILE_BYTES) { stats.skipped.push(p.f.filename); return; }
      p.tmp = path.join(work, `${i}${p.ext ? '.' + p.ext : ''}`);
      try { await downloadFile(paths.owner, p.f.fileurl, p.tmp); stats.downloaded++; }
      catch (e) { console.error(`Moodle file download failed (${p.f.filename}):`, e.message); stats.failed.push(p.f.filename); p.tmp = null; }
    });

    // One LibreOffice run for all of this course's Office files.
    const office = todo.filter(p => p.tmp && MOODLE_TO_PDF.has(p.ext));
    const pdfs = office.length ? await convertManyToPdf(office.map(p => p.tmp), work) : new Map();
    for (const p of todo.filter(p => p.tmp)) {
      let src = p.tmp, ext = p.ext;
      if (pdfs.get(p.tmp)) { src = pdfs.get(p.tmp); ext = 'pdf'; stats.converted++; }
      else if (MOODLE_TO_PDF.has(p.ext)) console.error(`Moodle file conversion failed (${p.f.filename}), keeping the original`);
      const rel = path.posix.join(p.dir, `${p.baseName}${ext ? '.' + ext : ''}`);
      fs.mkdirSync(path.join(paths.DOCS_DIR, p.dir), { recursive: true });
      moveFile(src, path.join(paths.DOCS_DIR, rel));
      p.file = `docs/${rel}`;
      stats.added.push(p.file);
      manifest.files[p.id] = { stamp: p.stamp, file: p.file };
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.writeFileSync(moodleManifestPath(paths), JSON.stringify(manifest, null, 2));
  }

  let syllabus = null;
  const resources = [], homework = [];
  for (const p of plan.filter(p => p.file)) {
    if (p.syllabus) { syllabus = p.file; continue; }
    const entry = {
      title: p.f.assignId ? `${p.f.module} — ${p.f.filename}` : p.f.filename,
      file: p.file,
      notes: p.f.section || '',
      moodleFileId: p.id,
    };
    if (p.f.assignId) homework.push({ assignId: p.f.assignId, module: p.f.module, ...entry });
    else resources.push(entry);
  }
  return { syllabus, resources, homework, stats };
}

// ── Course catalog ────────────────────────────────────────────
let COURSE_CATALOG = {};
function unescapeXml(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function loadCourseCatalog() {
  try {
    const xmlPath = path.join(__dirname, 'coursecatalog.xml');
    if (!fs.existsSync(xmlPath)) return;
    const xml = fs.readFileSync(xmlPath, 'utf8');
    const rows = {};
    const cellRe = /<gnm:Cell Row="(\d+)" Col="(\d+)"[^>]*>([^]*?)<\/gnm:Cell>/g;
    let m;
    while ((m = cellRe.exec(xml)) !== null) {
      const r = parseInt(m[1]), c = parseInt(m[2]);
      if (!rows[r]) rows[r] = {};
      rows[r][c] = unescapeXml(m[3]);
    }
    for (const [ri, row] of Object.entries(rows)) {
      if (parseInt(ri) === 0 || !row[0]) continue;
      COURSE_CATALOG[row[0]] = {
        code: row[0] || '',
        title: row[1] || '',
        credits: row[2] ? row[2].replace(/\.00$/, '') : '',
        faculty: row[3] || '',
        corequisite: row[4] || '',
        prerequisite: row[5] || '',
        description: row[6] || '',
      };
    }
  } catch (e) { console.warn('Could not load course catalog:', e.message); }
}
loadCourseCatalog();

// Finds the catalog entry for a course code as Moodle writes it: section
// letters, terms and missing spaces are ignored ("CS 321.A", "CS321-A_Fall",
// "cs 321" → "CS 321"). Falls back to a code found in the course name.
const CATALOG_CODE_RE = /([A-Za-zÇĞİÖŞÜçğıöşü]{2,6})\s*-?\s*(\d{3,4}[A-Za-z]?)/g;
// "CS 321.A : Programming Paradigms" -> "cs321", "EE 341L.C" -> "ee341l".
function courseSlug(text) {
  const m = String(text || '').match(new RegExp(CATALOG_CODE_RE.source));
  if (!m) return null;
  return (m[1] + m[2]).toLocaleLowerCase('tr-TR').replace(/ı/g, 'i')
    .normalize('NFD').replace(/[^a-z0-9]/g, '') || null;
}

function looksLikeCoursework(name) {
  return !/syllabus|izlence|outline/i.test(name) &&
    /week|hafta|lecture|slide|homework|\bhw\d|\blab|quiz|exam|midterm|final|chapter|\bch\d/i.test(name);
}

function catalogLookup(...texts) {
  const index = catalogLookup.index || (catalogLookup.index = Object.fromEntries(
    Object.values(COURSE_CATALOG).map(c => [c.code.replace(/\s+/g, '').toUpperCase(), c])));
  for (const text of texts) {
    for (const m of String(text || '').matchAll(CATALOG_CODE_RE)) {
      const key = (m[1] + m[2]).toLocaleUpperCase('tr-TR').replace(/İ/g, 'I');
      if (index[key]) return index[key];
      if (index[key.slice(0, -1)] && /[A-Z]$/.test(key)) return index[key.slice(0, -1)]; // "CS321A" → "CS 321"
    }
  }
  return null;
}

// ── Multer setups ─────────────────────────────────────────────
const docsStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.paths.DOCS_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, safe);
  }
});
const uploadDocs = multer({
  storage: docsStorage,
  fileFilter: (req, file, cb) => cb(null, path.extname(file.originalname).toLowerCase() === '.pdf'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

const tmpStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `syl_${Date.now()}_${safe}`);
  }
});
const uploadSyllabus = multer({ storage: tmpStorage, limits: { fileSize: 50 * 1024 * 1024 } });

const convStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `conv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safe}`);
  }
});
const uploadConv = multer({ storage: convStorage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Auth Routes ───────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password, guest, viewUser } = req.body;

  if (guest) {
    if (!viewUser) return res.status(400).json({ error: 'viewUser required' });
    if (!findUser(viewUser)) return res.status(400).json({ error: 'User not found' });
    req.session.user = 'guest';
    req.session.mode = 'guest';
    req.session.guestViewUser = viewUser;
    return res.json({ ok: true });
  }

  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = findUser(username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.user = username;
  req.session.mode = 'user';
  ensureUserDirs(username);
  res.json({ ok: true });
});

app.post('/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username: 3–20 chars, lowercase letters/numbers/underscores only' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = loadUsers();
  if (users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  users.push({
    username,
    displayName: username,
    passwordHash: bcrypt.hashSync(password, 10),
    shareToken: crypto.randomBytes(6).toString('hex'),
    createdAt: new Date().toISOString()
  });
  saveUsers(users);
  ensureUserDirs(username);
  ensureSemesters(username);

  req.session.user = username;
  req.session.mode = 'user';
  res.json({ ok: true });
});

app.post('/auth/change-password', (req, res) => {
  if (!req.session || req.session.mode === 'guest') return res.status(403).json({ error: 'Forbidden' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const users = loadUsers();
  const user = users.find(u => u.username === req.session.user);
  if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  res.json({ ok: true });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});

app.get('/auth/me', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const viewing = req.session.guestViewUser || null;
  res.json({
    username:      req.session.user,
    displayName:   displayNameOf(findUser(req.session.user)),
    mode:          req.session.mode,
    guestViewUser: viewing,
    guestViewName: viewing ? displayNameOf(findUser(viewing)) : null
  });
});

app.post('/auth/display-name', (req, res) => {
  if (!req.session || req.session.mode === 'guest') return res.status(403).json({ error: 'Forbidden' });
  const name = String(req.body.displayName || '').trim();
  if (!name) return res.status(400).json({ error: 'Display name required' });
  if (name.length > 40) return res.status(400).json({ error: 'Display name must be 40 characters or fewer' });

  const users = loadUsers();
  const user = users.find(u => u.username === req.session.user);
  if (!user) return res.status(404).json({ error: 'Not found' });
  user.displayName = name;
  saveUsers(users);
  res.json({ ok: true, displayName: name });
});

// ── Share-token route (no auth required) ──────────────────────
app.get('/d/:token', (req, res) => {
  const user = loadUsers().find(u => u.shareToken === req.params.token);
  if (!user) return res.redirect('/login.html');
  req.session.user = 'guest';
  req.session.mode = 'guest';
  req.session.guestViewUser = user.username;
  req.session.guestViaLink = true;
  req.session.save(() => res.redirect('/'));
});

app.get('/api/share-info', (req, res) => {
  if (!req.session || req.session.mode === 'guest') return res.status(403).json({ error: 'Forbidden' });
  const user = loadUsers().find(u => u.username === req.session.user);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  res.json({ token: user.shareToken, url: `${proto}://${req.get('host')}/d/${user.shareToken}` });
});

// ── Public user list — only users with ≥1 public section ──────
// Returns { username, displayName }: the username is still needed to start the
// guest session, but the picker shows the display name.
app.get('/api/users', (req, res) => {
  const listed = loadUsers().filter(u => {
    try {
      const data = loadActiveData(u.username);
      return (data.sections || []).some(s => (s.visibility || (s.public ? 'public' : 'private')) === 'public');
    } catch { return false; }
  });
  res.json(listed.map(u => ({ username: u.username, displayName: displayNameOf(u) })));
});

// ── API Routes ────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(req.paths.DATA_FILE, 'utf8'));
    if (req.session.mode === 'guest') {
      const viaLink = req.session.guestViaLink === true;
      data.sections = (data.sections || []).filter(s => {
        const vis = s.visibility || (s.public ? 'public' : 'private');
        return vis === 'public' || (viaLink && vis === 'unlisted');
      });
    }
    res.json(data);
  } catch { res.status(500).json({ error: 'Could not read data file' }); }
});

app.put('/api/data', requireUser, (req, res) => {
  try { fs.writeFileSync(req.paths.DATA_FILE, JSON.stringify(req.body, null, 2)); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Could not write data file' }); }
});

// ── Semester management ───────────────────────────────────────
app.get('/api/semesters', requireUser, (req, res) => {
  const sems = loadSemesters(req.paths.owner);
  res.json({ ...sems, suggestedName: currentTermName() });
});

// Create a new semester (optionally archiving the current one)
app.post('/api/semesters', requireUser, (req, res) => {
  const owner = req.paths.owner;
  const sems  = loadSemesters(owner);
  const name  = (req.body.name || '').trim() || currentTermName();
  const id    = newSemId();

  fs.writeFileSync(semesterDataFile(owner, id), JSON.stringify({ title: name, sections: [] }, null, 2));

  if (req.body.archiveCurrent && sems.active) {
    const cur = sems.semesters.find(s => s.id === sems.active);
    if (cur) cur.archived = true;
  }
  sems.semesters.push({ id, name, archived: false, createdAt: new Date().toISOString() });
  sems.active = id;
  saveSemesters(owner, sems);
  res.json({ id, semesters: sems });
});

// Rename and/or set archived flag
app.patch('/api/semesters/:id', requireUser, (req, res) => {
  const sems = loadSemesters(req.paths.owner);
  const s = sems.semesters.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) s.name = req.body.name.trim();
  if (typeof req.body.archived === 'boolean') {
    s.archived = req.body.archived;
    // Never leave the active semester archived
    if (s.archived && sems.active === s.id) {
      const fallback = sems.semesters.find(x => !x.archived);
      if (fallback) sems.active = fallback.id;
    }
  }
  saveSemesters(req.paths.owner, sems);
  res.json(sems);
});

// Set as the active (current) semester — also unarchives it
app.post('/api/semesters/:id/activate', requireUser, (req, res) => {
  const sems = loadSemesters(req.paths.owner);
  const s = sems.semesters.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.archived = false;
  sems.active = s.id;
  saveSemesters(req.paths.owner, sems);
  res.json(sems);
});

app.delete('/api/semesters/:id', requireUser, (req, res) => {
  const owner = req.paths.owner;
  const sems  = loadSemesters(owner);
  if (sems.semesters.length <= 1) return res.status(400).json({ error: 'Cannot delete the only semester' });
  const idx = sems.semesters.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = sems.semesters.splice(idx, 1);
  try { fs.unlinkSync(semesterDataFile(owner, removed.id)); } catch {}
  if (sems.active === removed.id) sems.active = sems.semesters[0].id;
  saveSemesters(owner, sems);
  res.json(sems);
});

app.get('/api/courses', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  if (!q) return res.json([]);
  const qNorm = q.replace(/\s+/g, '');
  const results = Object.values(COURSE_CATALOG).filter(c => {
    const codeLow = c.code.toLowerCase();
    const codeNorm = codeLow.replace(/\s+/g, '');
    return codeLow.includes(q) || c.title.toLowerCase().includes(q) || (qNorm.length >= 2 && codeNorm.includes(qNorm));
  }).slice(0, limit);
  res.json(results);
});

app.get('/api/courses/:code', (req, res) => {
  const course = COURSE_CATALOG[req.params.code.toUpperCase()];
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json(course);
});

app.get('/api/docs', (req, res) => {
  const files = fs.readdirSync(req.paths.DOCS_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).map(f => ({ name: f, path: `docs/${f}` }));
  res.json(files);
});

app.post('/api/upload', requireUser, uploadDocs.array('pdf', 20), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No valid PDF files received' });
  res.json(req.files.map(f => ({ name: f.filename, path: `docs/${f.filename}` })));
});

app.delete('/api/docs/:filename', requireUser, (req, res) => {
  const filename = path.basename(req.params.filename);
  const file = path.join(req.paths.DOCS_DIR, filename);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const reg = loadRegistry(req.paths);
  const key = Object.keys(reg).find(k => reg[k].file === `docs/${filename}`);
  if (key) { delete reg[key]; saveRegistry(reg, req.paths); }
  res.json({ ok: true });
});

app.get('/api/docs/registry', (req, res) => res.json(loadRegistry(req.paths)));

const _staged = {};
app.get('/api/upload/stage-info', async (req, res) => {
  let ollama = false;
  try { const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) }); ollama = r.ok; } catch {}
  res.json({ ollama, gemini: !!GEMINI_KEY });
});

app.post('/api/upload/stage', requireUser, uploadSyllabus.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const id = crypto.randomBytes(8).toString('hex');
  _staged[id] = { tempPath: req.file.path, originalName: req.file.originalname, stagedAt: Date.now() };
  res.json({ id, originalName: req.file.originalname });
  autoNamePdf(req.file.path).then(result => {
    if (!_staged[id]) return;
    if (result && typeof result === 'object') { _staged[id].suggested = ''; _staged[id].geminiError = result.error; }
    else { _staged[id].suggested = result ?? ''; }
  });
});

app.get('/api/upload/stage/:id', (req, res) => {
  const s = _staged[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ originalName: s.originalName, suggested: s.suggested ?? null, geminiError: s.geminiError ?? null, ready: 'suggested' in s });
});

app.post('/api/upload/confirm', requireUser, async (req, res) => {
  const { id, name } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  const s = _staged[id];
  if (!s) return res.status(404).json({ error: 'Staging entry not found or expired' });
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!safeName) return res.status(400).json({ error: 'Invalid name' });
  try {
    let finalPath = path.join(req.paths.DOCS_DIR, `${safeName}.pdf`);
    if (path.extname(s.originalName).toLowerCase() === '.pdf') {
      moveFile(s.tempPath, finalPath);
    } else {
      const converted = await convertFile(s.tempPath, 'pdf', req.paths.DOCS_DIR);
      moveFile(converted, finalPath);
      try { fs.unlinkSync(s.tempPath); } catch {}
    }
    const reg = loadRegistry(req.paths);
    reg[safeName] = { name: safeName, file: `docs/${safeName}.pdf`, originalName: s.originalName, uploaded: new Date().toISOString().split('T')[0] };
    saveRegistry(reg, req.paths);
    delete _staged[id];
    res.json({ name: safeName, file: `docs/${safeName}.pdf` });
  } catch (e) {
    try { fs.unlinkSync(s.tempPath); } catch {}
    delete _staged[id];
    res.status(500).json({ error: e.message });
  }
});

// ── Moodle ────────────────────────────────────────────────────
function moodleFail(res, e) {
  if (!(e instanceof moodle.MoodleError)) {
    console.error('Moodle:', e);
    return res.status(500).json({ error: 'Moodle request failed' });
  }
  const reconnect = e.isAuthError || e.code === 'notconnected';
  res.status(reconnect ? 409 : 502).json({ error: e.message, reconnect });
}

app.get('/api/moodle/status', requireUser, (req, res) => res.json(moodle.status(req.paths.owner)));

app.post('/api/moodle/connect', requireUser, async (req, res) => {
  const { token, siteId, passport } = req.body || {};
  try { res.json(await moodle.connect(req.paths.owner, { token, siteId, passport })); }
  catch (e) { moodleFail(res, e); }
});

app.delete('/api/moodle/connect', requireUser, (req, res) => {
  moodle.disconnect(req.paths.owner);
  res.json(moodle.status(req.paths.owner));
});

app.get('/api/moodle/courses', requireUser, async (req, res) => {
  // The webservice is blocked for servers; the sync account lists its
  // courses through the login session instead.
  if (browserSyncAvailable(req)) {
    try {
      const courses = await moodleZip.withSession(() => moodleHttp.enrolledCourses());
      return res.json(courses.map(c => ({ id: c.id, code: c.shortname, name: c.fullname, current: true })));
    } catch (e) { return res.status(502).json({ error: e.message }); }
  }
  try { res.json(await moodle.listCourses(req.paths.owner)); }
  catch (e) { moodleFail(res, e); }
});

// Returns normalized course data; the editor merges it into the dashboard.
app.post('/api/moodle/fetch', requireUser, async (req, res) => {
  const ids = Array.isArray(req.body.courseIds) ? req.body.courseIds.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'No courses selected' });
  try {
    const courses = await moodle.fetchCourses(req.paths.owner, ids, { grades: req.body.grades === true });
    // Add the catalog's credits, faculty, prerequisites, … where it has the course.
    for (const c of courses) c.catalog = catalogLookup(c.code, c.name);
    res.json(courses);
  } catch (e) { moodleFail(res, e); }
});

// Downloads one course's Moodle files into this user's docs/, picking the
// syllabus out with the LLM agent (see syncMoodleFiles). Separate from
// /fetch since it's much slower (real downloads) and most re-syncs don't
// need it.
app.post('/api/moodle/files', requireUser, async (req, res) => {
  const courseId = Number(req.body.courseId);
  const code = String(req.body.code || '').slice(0, 64);
  if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'Missing courseId' });
  try {
    const files = await moodle.courseFiles(req.paths.owner, courseId);
    res.json(await syncMoodleFiles(req.paths, code, files));
  } catch (e) { moodleFail(res, e); }
});

// ── Moodle sync with the browser session ─────────────────────────
// The webservice REST API (moodle.js) is blocked for servers by the
// university, so this uses the session a headless Chrome login saved
// (moodle-browser.js): each course is fetched as a zip over plain HTTP
// (moodle-zip.js, like the LMS Downloader extension's button) and read
// locally. It has no HTTP request/session to piggyback paths off of, so it
// builds them straight from the semester store, and merges results into the
// stored course data itself (admin.js does this client-side for the
// webservice path; there's no browser open here).
function getPathsForOwner(owner) {
  ensureUserDirs(owner);
  const sems = loadSemesters(owner);
  const userDir = path.join(__dirname, 'userdata', owner);
  return {
    DATA_FILE: semesterDataFile(owner, sems.active),
    DOCS_DIR: path.join(userDir, 'docs'),
    REGISTRY_FILE: path.join(userDir, 'docs-registry.json'),
    owner,
  };
}

function emptyCourseItem() {
  return { code: '', name: '', credits: '', faculty: '', prerequisite: '', corequisite: '', notes: '',
    syllabus: '', resources: [], homework: [], exams: [], grades: null };
}

// The course module id a homework row points at (its view.php?id= link).
const rowCmid = (r) => (/^cm:(\d+)$/.exec(r.moodleId || '') || /[?&]id=(\d+)/.exec(r.url || '') || [])[1] || null;

// Homework rows from a course zip's manifest: assignments with a due date
// and quizzes with a closing date, from yesterday on, plus assignments of
// the last two weeks that were never submitted (overdue). Same shape as the
// webservice sync's rows.
function homeworkFromManifest(manifest) {
  const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('sv', { timeZone: 'Europe/Istanbul' });
  const rows = [];
  for (const sec of manifest.sections || []) {
    for (const a of sec.activities || []) {
      const label = a.type === 'assign' ? /^(due|son teslim)/i : a.type === 'quiz' ? /^(closes?|closed|kapan)/i : null;
      // Without a due date set in Moodle, use one written in the description
      // ("HW 1 is due 19.10.2026@17:00").
      const written = a.type === 'assign' && /\bdue\b[^0-9\n]{0,20}(\d{1,2})[./](\d{1,2})[./](\d{4})/i.exec(a.description || '');
      const due = (label && (a.dates || []).find(d => d.date && label.test(d.label)))
        || (written && { date: `${written[3]}-${written[2].padStart(2, '0')}-${written[1].padStart(2, '0')}` });
      if (!due) continue;
      const keep = due.date >= day(-1) || (a.type === 'assign' && !a.submitted && due.date >= day(-14));
      if (!keep) continue;
      rows.push({
        moodleId: `cm:${a.cmid}`,
        title: a.name,
        deadline: due.date,
        description: a.type === 'quiz' ? 'Quiz' : (a.description || '').replace(/\s+/g, ' ').slice(0, 300),
        url: a.url || '',
      });
    }
  }
  return rows.sort((x, y) => x.deadline.localeCompare(y.deadline));
}

// Finds or creates the course entry for a synced Moodle course, fills in
// catalog fields it's missing, and attaches synced files, deadlines and
// grades — same matching and precedence rules as admin.js's
// mergeMoodleCourses/mergeMoodleFiles.
function mergeBrowserCourse(data, { moodleId, code, name, catalog }, { syllabus, resources, homework }, { deadlines, grades } = {}) {
  data.sections = data.sections || [];
  let section = data.sections.find(s => s.type === 'courses');
  if (!section) {
    section = { title: 'Courses', type: 'courses', collapsed: false, visibility: 'private', items: [] };
    data.sections.push(section);
  }

  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const allCourses = () => data.sections.flatMap(s => s.type === 'courses' ? s.items : []);

  let course = allCourses().find(i => i.moodleId === moodleId);
  if (!course) {
    course = section.items.find(i => !i.moodleId && norm(i.code) &&
      (norm(code).startsWith(norm(i.code)) || (catalog && norm(catalog.code) === norm(i.code))));
  }
  let created = false;
  if (!course) {
    course = emptyCourseItem();
    course.code = catalog ? catalog.code : code;
    course.name = name;
    section.items.push(course);
    created = true;
  }
  course.moodleId = moodleId;
  if (!course.name) course.name = name;

  if (catalog) {
    if (!course.credits) course.credits = catalog.credits;
    if (!course.faculty) course.faculty = catalog.faculty;
    course.prerequisite = catalog.prerequisite;
    course.corequisite = catalog.corequisite;
    if (!course.notes) {
      course.notes = [catalog.description,
        catalog.prerequisite && 'Prerequisite: ' + catalog.prerequisite,
        catalog.corequisite && 'Corequisite: ' + catalog.corequisite].filter(Boolean).join('\n');
    }
  }

  // Deadlines: keep hand-added rows; replace synced ones, keeping any file or
  // notes added to them. Rows from the webservice sync are keyed by the
  // assignment's instance id, so they are matched by their link instead.
  if (deadlines) {
    const synced = (course.homework || []).filter(h => h.moodleId);
    const manual = (course.homework || []).filter(h => !h.moodleId);
    course.homework = [...manual, ...deadlines.map(h => {
      const prev = synced.find(r => r.moodleId === h.moodleId) || synced.find(r => rowCmid(r) === rowCmid(h));
      return { ...h, moodleId: prev ? prev.moodleId : h.moodleId, file: prev ? prev.file || '' : '', notes: prev ? prev.notes || '' : '' };
    })];
  }
  if (grades && grades.length) course.grades = grades;

  if (syllabus) course.syllabus = syllabus;
  const extra = [];
  const filled = new Set();
  for (const h of homework || []) {
    // Assignment files carry the assignment's page id (cmid); fall back to
    // the assignment's name.
    const row = (course.homework || []).find(r => rowCmid(r) === String(h.assignId))
      || (course.homework || []).find(r => h.module && r.title && r.title.trim() === h.module.trim());
    const ownFile = row && row.file && !row.file.startsWith('docs/materials/');
    if (row && !ownFile && !filled.has(row)) { row.file = h.file; filled.add(row); }
    else extra.push({ title: h.title, file: h.file, notes: h.notes, moodleFileId: h.moodleFileId });
  }
  const manual = (course.resources || []).filter(r => !r.moodleFileId);
  course.resources = [...manual, ...(resources || []), ...extra];

  return created;
}

const BROWSER_SYNC_OWNER = process.env.MOODLE_SYNC_OWNER || 'salih';
// What the editor polls while a run is going (one run at a time).
const browserSync = { running: false, step: '', startedAt: null, finishedAt: null, lastResult: null };

// Syncs one course ({ id, shortname, fullname } from Moodle's course list)
// through its zip: files the dashboard already has (by URL, which changes
// when the file does) are not downloaded again. Returns { merge, stats },
// merge being mergeBrowserCourse's arguments after `data`.
async function syncCourseFromZip(paths, course, onStep) {
  const manifest = loadMoodleManifest(paths);
  const knownStamp = (url) => {
    const prev = manifest.files[md5(url.split('?')[0]).slice(0, 12)];
    return prev && fs.existsSync(path.join(paths.DOCS_DIR, prev.file.replace(/^docs\//, ''))) ? prev.stamp : null;
  };
  const zipPath = path.join(os.tmpdir(), `moodle_${course.id}_${Date.now()}.zip`);
  try {
    onStep('fetching');
    const m = await moodleZip.withSession(() => moodleZip.buildZip(course, zipPath, {
      known: (url) => Boolean(knownStamp(url)), maxBytes: MOODLE_MAX_FILE_BYTES, onProgress: onStep,
    }));
    for (const err of m.errors) console.warn(`[moodle-sync] ${course.fullname}: ${err}`);
    const zip = moodleZip.readZip(zipPath);

    // The zip's files in syncMoodleFiles' shape; files left out of the zip
    // as known bring their old stamp, so they count as unchanged.
    const files = [];
    const byUrl = new Map();
    for (const sec of m.sections) {
      for (const a of sec.activities) {
        if (!['resource', 'folder', 'assign'].includes(a.type)) continue;
        for (const f of a.files) {
          if (!f.path && !f.skipped) continue;
          const name = f.name;
          files.push({
            section: sec.name, module: a.type === 'folder' ? name : a.name, filename: name, fileurl: f.url,
            filesize: f.size || 0, timemodified: f.modified || 0, mimetype: f.type || '',
            ...(f.skipped === 'known' ? { stamp: knownStamp(f.url) } : {}),
            ...(a.type === 'assign' ? { assignId: a.cmid } : {}),
          });
          byUrl.set(f.url, f);
        }
      }
    }
    const fromZip = async (owner, url, dest) => {
      const f = byUrl.get(url);
      if (f && f.path) fs.writeFileSync(dest, zip.read(f.path));
      else await moodleHttp.download(url, dest); // known, but its old copy can't be reused
    };

    onStep(`syncing ${files.length} files`);
    const catalog = catalogLookup(course.shortname, course.fullname);
    const code = catalog ? catalog.code : course.fullname;
    const result = await syncMoodleFiles(paths, code, files, fromZip);
    return {
      merge: [{ moodleId: course.id, code, name: course.fullname, catalog }, result,
        { deadlines: homeworkFromManifest(m), grades: m.grades }],
      stats: result.stats,
    };
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}

// only: a course code ("EE341") to sync just that course.
async function browserSyncAllCourses(only = null) {
  if (browserSync.running) return { skipped: 'already running' };
  if (!process.env.MOODLE_USERNAME || !process.env.MOODLE_PASSWORD) return { skipped: 'no credentials' };
  Object.assign(browserSync, { running: true, step: 'Starting', startedAt: Date.now(), finishedAt: null });
  // updates: per course, the files that are new or changed and the deadlines
  // (for agents asking what changed; see scripts/agent.js sync).
  const summary = { courses: 0, filesDownloaded: 0, filesConverted: 0, failed: [], updates: [] };
  try {
    const paths = getPathsForOwner(BROWSER_SYNC_OWNER);
    const merges = [];
    browserSync.step = 'Listing courses';
    const enrolled = await moodleZip.withSession(() => moodleHttp.enrolledCourses());
    const courses = only ? [moodleZip.findCourse(only, enrolled)] : enrolled;
    for (const [i, course] of courses.entries()) {
      const tag = `[${i + 1}/${courses.length}] ${course.fullname}`;
      try {
        const result = await syncCourseFromZip(paths, course, (step) => { browserSync.step = `${tag}: ${step}`; });
        merges.push(result.merge);
        const s = result.stats;
        console.log(`[moodle-sync] ${tag}: done — ${s.downloaded} downloaded, ${s.unchanged} unchanged, ` +
          `${s.converted} converted to PDF${s.skipped.length ? `, ${s.skipped.length} too large` : ''}${s.failed.length ? `, ${s.failed.length} failed` : ''}`);
        summary.courses++;
        summary.filesDownloaded += s.downloaded;
        summary.filesConverted += s.converted;
        summary.updates.push({
          course: result.merge[0].code, moodleId: course.id, newFiles: s.added,
          deadlines: result.merge[2].deadlines.map(h => ({ title: h.title, deadline: h.deadline, url: h.url })),
        });
      } catch (e) {
        console.error(`[moodle-sync] sync failed for course ${course.id} (${course.fullname}):`, e.message);
        summary.failed.push(course.fullname);
      }
    }

    // Read the data only now, so edits saved while the sync ran are kept.
    let data;
    try { data = JSON.parse(fs.readFileSync(paths.DATA_FILE, 'utf8')); } catch { data = { sections: [] }; }
    for (const args of merges) mergeBrowserCourse(data, ...args);
    fs.writeFileSync(paths.DATA_FILE, JSON.stringify(data, null, 2));
    console.log('[moodle-sync] sync done:', summary);
    // New syllabi may have arrived; update the grading overview in the background.
    refreshGradingOverview(paths).catch(e => console.error('[grading] refresh failed:', e.message));
  } catch (e) {
    console.error('[moodle-sync] sync aborted:', e.message);
    summary.error = e.message;
    summary.code = e.code;
  } finally {
    Object.assign(browserSync, { running: false, step: '', finishedAt: Date.now(), lastResult: summary });
  }
  return summary;
}

function browserSyncAvailable(req) {
  return Boolean(process.env.MOODLE_USERNAME && process.env.MOODLE_PASSWORD) && req.paths.owner === BROWSER_SYNC_OWNER;
}

app.get('/api/moodle/browser-sync', requireUser, (req, res) => {
  res.json({ available: browserSyncAvailable(req), ...browserSync });
});

// Starts a run and returns right away; the editor polls the GET above. A
// run takes a minute or two, longer than a proxy will hold a request open.
// Body { course: "EE341" } syncs just that course.
app.post('/api/moodle/browser-sync', requireUser, (req, res) => {
  if (!browserSyncAvailable(req)) return res.status(403).json({ error: 'Moodle sync is not set up for this account' });
  if (browserSync.running || gradeCheckRunning || zipRunning) return res.status(409).json({ error: 'A sync is already running', ...browserSync });
  browserSyncAllCourses(req.body && typeof req.body.course === 'string' ? req.body.course : null);
  res.status(202).json({ started: true });
});

// ── Course zips on demand ────────────────────────────────────────
// One course's Moodle content as a zip (moodle-zip.js), for `agent.js zip`.
// Always complete (nothing skipped as known);
// one at a time, and not while a sync or grade check runs.
let zipRunning = null; // the course asked for, while a zip is being built

// -> { file, manifest, cleanup() }
async function courseZip(ref) {
  if (zipRunning || browserSync.running || gradeCheckRunning) {
    throw Object.assign(new Error('Moodle is busy with another sync; try again in a minute'), { busy: true });
  }
  zipRunning = String(ref);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle_zip_'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const tmp = path.join(dir, 'course.zip');
    const manifest = await moodleZip.getZip(ref, tmp, { maxBytes: MOODLE_MAX_FILE_BYTES });
    const file = path.join(dir, `${courseSlug(manifest.course.shortname || manifest.course.fullname) || `course-${manifest.course.id}`}.zip`);
    fs.renameSync(tmp, file);
    return { file, manifest, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zipRunning = null;
  }
}

// GET /api/moodle/zip?course=EE341 -> the zip (takes a while: every file).
app.get('/api/moodle/zip', requireUser, async (req, res) => {
  if (!browserSyncAvailable(req)) return res.status(403).json({ error: 'Moodle sync is not set up for this account' });
  const ref = String(req.query.course || '').trim();
  if (!ref) return res.status(400).json({ error: 'course is required, e.g. ?course=EE341' });
  let z;
  try { z = await courseZip(ref); }
  catch (e) { return res.status(e.busy ? 409 : 502).json({ error: e.message }); }
  res.download(z.file, path.basename(z.file), () => z.cleanup());
});

// ── Grade watch ──────────────────────────────────────────────────
// Checks the grade report of every course that has a Moodle id, over plain
// HTTP with the saved session (one request per course), updates the grades
// shown on the dashboard and sends a Telegram message when a grade is added
// or changes. Hourly when MOODLE_GRADE_WATCH=on; the first run only records
// the current grades.
function gradeWatchPath(owner) { return path.join(__dirname, 'userdata', owner, 'moodle-grades.json'); }

function moodleUserId(owner) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'userdata', owner, 'moodle.json'), 'utf8')).userId || null; }
  catch { return null; }
}

const sendTelegram = telegram.sendMessage;

function describeGrade(g) {
  let s = g.grade;
  if (g.range) s += ` (out of ${g.range})`;
  if (g.percentage && g.percentage !== '-') s += `, ${g.percentage}`;
  return s;
}

let gradeCheckRunning = false;
let lastGradeCheck = null; // { at, result } for /status
async function checkGrades() {
  if (gradeCheckRunning || browserSync.running || zipRunning) return { skipped: 'busy' };
  const result = await runGradeCheck();
  lastGradeCheck = { at: Date.now(), result };
  return result;
}

async function runGradeCheck() {
  gradeCheckRunning = true;
  const owner = BROWSER_SYNC_OWNER;
  let state;
  try { state = JSON.parse(fs.readFileSync(gradeWatchPath(owner), 'utf8')); } catch { state = { courses: {} }; }
  try {
    const paths = getPathsForOwner(owner);
    const data = JSON.parse(fs.readFileSync(paths.DATA_FILE, 'utf8'));
    const courses = (data.sections || []).flatMap(s => s.type === 'courses' ? s.items : []).filter(c => c.moodleId);
    if (!courses.length) return { skipped: 'no courses with a Moodle id' };
    const userId = moodleUserId(owner);

    const results = {};
    let signedIn = false;
    for (const c of courses) {
      try {
        results[c.moodleId] = await moodleHttp.courseGrades(c.moodleId, userId);
      } catch (e) {
        if (!(e instanceof moodleHttp.SessionExpiredError)) {
          console.error(`[grades] ${c.code}: ${e.message}`);
          continue;
        }
        if (signedIn) throw e;
        console.log('[grades] session expired, signing in again');
        await moodleBrowser.refreshSession();
        signedIn = true;
        results[c.moodleId] = await moodleHttp.courseGrades(c.moodleId, userId);
      }
    }
    if (!Object.keys(results).length) throw new Error('could not read any grade report');

    const firstRun = !Object.keys(state.courses).length;
    const changes = [];
    for (const c of courses) {
      const now = results[c.moodleId], before = state.courses[c.moodleId];
      if (!now || !before) continue;
      const prev = new Map(before.map(g => [g.item, g]));
      for (const g of now) {
        const p = prev.get(g.item);
        if (!p) changes.push(`📊 ${c.code} — ${g.item}: ${describeGrade(g)}`);
        else if (p.grade !== g.grade) changes.push(`✏️ ${c.code} — ${g.item}: ${p.grade} → ${describeGrade(g)}`);
        else if (g.feedback && g.feedback !== p.feedback) changes.push(`💬 ${c.code} — ${g.item}: new feedback: ${g.feedback}`);
      }
    }

    for (const [id, grades] of Object.entries(results)) state.courses[id] = grades;
    const recovered = state.lastError;
    Object.assign(state, { lastError: null, checkedAt: Date.now() });
    fs.writeFileSync(gradeWatchPath(owner), JSON.stringify(state, null, 2));

    // Show them on the dashboard too; re-read so concurrent edits are kept.
    const fresh = JSON.parse(fs.readFileSync(paths.DATA_FILE, 'utf8'));
    let dataChanged = false;
    for (const c of (fresh.sections || []).flatMap(s => s.type === 'courses' ? s.items : [])) {
      const grades = results[c.moodleId];
      if (grades && JSON.stringify(grades) !== JSON.stringify(c.grades || [])) { c.grades = grades; dataChanged = true; }
    }
    if (dataChanged) fs.writeFileSync(paths.DATA_FILE, JSON.stringify(fresh, null, 2));

    const total = Object.values(results).reduce((n, g) => n + g.length, 0);
    console.log(`[grades] checked ${Object.keys(results).length} courses, ${total} grades, ${changes.length} changes`);
    if (changes.length) await sendTelegram(['New on Moodle:', ...changes].join('\n'));
    else if (firstRun) await sendTelegram(`Grade watch is on: ${total} grades in ${courses.length} courses recorded. You'll get a message here when a grade is added or changes.`);
    else if (recovered) await sendTelegram('Grade watch is working again.');
    return { courses: Object.keys(results).length, grades: total, changes };
  } catch (e) {
    console.error('[grades] check failed:', e.message);
    if (state.lastError !== e.message) {
      await sendTelegram(`⚠️ Grade watch couldn't check Moodle: ${e.message}. It will try again at the next check.`);
      state.lastError = e.message;
      try { fs.writeFileSync(gradeWatchPath(owner), JSON.stringify(state, null, 2)); } catch {}
    }
    return { error: e.message };
  } finally {
    gradeCheckRunning = false;
  }
}

// ── Grading overview section ──────────────────────────────────────
// A dashboard section (type "grading") holding, per course, the grading
// breakdown read from its syllabus (see grading.js). The rows live in the
// section itself, so it shows with that section's own visibility.
const gradingRuns = new Map(); // owner -> { running, startedAt, finishedAt, lastResult }

async function refreshGradingOverview(paths) {
  const run = gradingRuns.get(paths.owner) || {};
  if (run.running) return { skipped: 'already running' };
  gradingRuns.set(paths.owner, { ...run, running: true, startedAt: Date.now() });
  let result;
  try {
    const data = JSON.parse(fs.readFileSync(paths.DATA_FILE, 'utf8'));
    const courses = (data.sections || []).flatMap(s => s.type === 'courses' ? s.items : []).filter(c => c.code || c.name);
    const cachePath = path.join(path.dirname(paths.DOCS_DIR), 'grading-cache.json');
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
    const rows = await grading.buildOverview(courses, paths.DOCS_DIR, cache, msg => console.log(`[grading] ${msg}`));
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    // Re-read so edits saved meanwhile are kept; add the section if missing.
    const fresh = JSON.parse(fs.readFileSync(paths.DATA_FILE, 'utf8'));
    fresh.sections = fresh.sections || [];
    let section = fresh.sections.find(s => s.type === 'grading');
    if (!section) {
      const coursesIdx = fresh.sections.findIndex(s => s.type === 'courses');
      const vis = coursesIdx >= 0 ? (fresh.sections[coursesIdx].visibility || 'private') : 'private';
      section = { title: 'Grading overview', type: 'grading', collapsed: false, visibility: vis, items: [] };
      fresh.sections.splice(coursesIdx >= 0 ? coursesIdx + 1 : fresh.sections.length, 0, section);
    }
    section.rows = rows;
    section.updatedAt = Date.now();
    fs.writeFileSync(paths.DATA_FILE, JSON.stringify(fresh, null, 2));
    result = { courses: rows.length, withGrading: rows.filter(r => r.components.length).length };
    console.log('[grading] overview updated:', result);
  } catch (e) {
    result = { error: e.message };
    throw e;
  } finally {
    gradingRuns.set(paths.owner, { running: false, finishedAt: Date.now(), lastResult: result });
  }
  return result;
}

app.get('/api/grading/refresh', requireUser, (req, res) => {
  res.json(gradingRuns.get(req.paths.owner) || { running: false });
});

// Starts a refresh and returns right away (the first run reads every
// syllabus through the LLM); the editor polls the GET above.
app.post('/api/grading/refresh', requireUser, (req, res) => {
  const run = gradingRuns.get(req.paths.owner);
  if (run && run.running) return res.status(409).json({ error: 'Already refreshing', ...run });
  refreshGradingOverview(req.paths).catch(e => console.error('[grading] refresh failed:', e.message));
  res.status(202).json({ started: true });
});

app.post('/api/moodle/grades/check', requireUser, async (req, res) => {
  if (!browserSyncAvailable(req)) return res.status(403).json({ error: 'Moodle sync is not set up for this account' });
  res.json(await checkGrades());
});

// ── Grade watch schedule + Telegram commands ─────────────────────
// Runs every intervalMinutes (default 60), aligned to the clock (e.g. on the
// hour); never at startup, so restarts don't add requests. Pause and interval
// survive restarts. Telegram commands (TELEGRAM_COMMANDS=on) control it.
const GRADE_WATCH_ENABLED = process.env.MOODLE_GRADE_WATCH === 'on' && Boolean(process.env.MOODLE_USERNAME && process.env.MOODLE_PASSWORD);
const MIN_INTERVAL_MIN = 30, MAX_INTERVAL_MIN = 24 * 60;
const watchSettingsPath = () => path.join(__dirname, 'userdata', BROWSER_SYNC_OWNER, 'grade-watch-settings.json');

function loadWatchSettings() {
  try { return { paused: false, intervalMinutes: 60, ...JSON.parse(fs.readFileSync(watchSettingsPath(), 'utf8')) }; }
  catch { return { paused: false, intervalMinutes: 60 }; }
}
function saveWatchSettings(settings) { fs.writeFileSync(watchSettingsPath(), JSON.stringify(settings, null, 2)); }

let watchTimer = null, nextGradeCheckAt = null;
function scheduleGradeWatch() {
  clearTimeout(watchTimer);
  watchTimer = null; nextGradeCheckAt = null;
  const settings = loadWatchSettings();
  if (!GRADE_WATCH_ENABLED || settings.paused) return;
  const ms = settings.intervalMinutes * 60000;
  const now = Date.now();
  // Align to the local (Istanbul, UTC+3) clock so "60" means on the hour.
  const offset = 3 * 3600000;
  nextGradeCheckAt = Math.floor((now + offset) / ms) * ms + ms - offset;
  watchTimer = setTimeout(async () => {
    await checkGrades();
    scheduleGradeWatch();
  }, nextGradeCheckAt - now);
}
scheduleGradeWatch();

const fmtTime = (t) => t ? new Date(t).toLocaleString('en-GB', {
  timeZone: 'Europe/Istanbul', weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
}) : '—';
const fmtInterval = (min) => min % 60 ? `${min} min` : `${min / 60} h`;

function describeCheck(r) {
  if (!r) return '—';
  if (r.error) return `failed: ${r.error}`;
  if (r.skipped) return `skipped (${r.skipped})`;
  return `${r.courses} courses, ${r.grades} grades, ${r.changes.length} change${r.changes.length === 1 ? '' : 's'}`;
}

function describeSync(r) {
  if (!r) return '—';
  if (r.skipped) return `skipped (${r.skipped})`;
  if (r.error) return `failed: ${r.error}`;
  let s = `${r.courses} courses, ${r.filesDownloaded} files downloaded, ${r.filesConverted} converted`;
  if (r.failed && r.failed.length) s += `, not synced: ${r.failed.join(', ')}`;
  return s;
}

function syncedCourses() {
  try {
    const data = JSON.parse(fs.readFileSync(getPathsForOwner(BROWSER_SYNC_OWNER).DATA_FILE, 'utf8'));
    return (data.sections || []).flatMap(s => s.type === 'courses' ? s.items : []);
  } catch { return []; }
}

// "2h", "90m", "90", "1.5h" -> minutes
function parseInterval(arg) {
  const m = String(arg || '').trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(h|hr|hours?|m|min|mins|minutes?)?$/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return Math.round(m[2] && m[2].startsWith('h') ? n * 60 : n);
}

const telegramCommands = {
  help: {
    help: 'List the commands',
    run: () => Object.entries(telegramCommands).map(([n, c]) => `/${n} — ${c.help}`).join('\n'),
  },
  status: {
    help: 'Grade watch and sync status',
    run: () => {
      const st = loadWatchSettings();
      const watch = !GRADE_WATCH_ENABLED ? 'off (not enabled on the server)'
        : st.paused ? `paused (every ${fmtInterval(st.intervalMinutes)} when resumed)`
        : `on, every ${fmtInterval(st.intervalMinutes)}, next ${fmtTime(nextGradeCheckAt)}`;
      let state = {};
      try { state = JSON.parse(fs.readFileSync(gradeWatchPath(BROWSER_SYNC_OWNER), 'utf8')); } catch {}
      const lines = [
        `📊 Grade watch: ${watch}${gradeCheckRunning ? ' — checking now' : ''}`,
        `Last check: ${lastGradeCheck ? `${fmtTime(lastGradeCheck.at)} — ${describeCheck(lastGradeCheck.result)}` : state.checkedAt ? fmtTime(state.checkedAt) : '—'}`,
      ];
      if (state.lastError) lines.push(`⚠️ Last error: ${state.lastError}`);
      lines.push(browserSync.running
        ? `📁 File sync: running — ${browserSync.step}`
        : `📁 Last file sync: ${browserSync.finishedAt ? `${fmtTime(browserSync.finishedAt)} — ${describeSync(browserSync.lastResult)}` : '— (since the server started)'}`);
      return lines.join('\n');
    },
  },
  pause: {
    help: 'Pause the grade watch',
    run: () => {
      const st = loadWatchSettings();
      if (st.paused) return 'Already paused. /resume to start again.';
      saveWatchSettings({ ...st, paused: true });
      scheduleGradeWatch();
      return '⏸ Grade watch paused. /resume to start again.';
    },
  },
  resume: {
    help: 'Resume the grade watch',
    run: () => {
      if (!GRADE_WATCH_ENABLED) return 'The grade watch is not enabled on the server (MOODLE_GRADE_WATCH).';
      const st = loadWatchSettings();
      saveWatchSettings({ ...st, paused: false });
      scheduleGradeWatch();
      return `▶️ Grade watch on, every ${fmtInterval(st.intervalMinutes)}. Next check ${fmtTime(nextGradeCheckAt)}.`;
    },
  },
  interval: {
    help: 'How often to check grades, e.g. /interval 2h or /interval 90m',
    run: (args) => {
      const st = loadWatchSettings();
      if (!args.length) return `Checking every ${fmtInterval(st.intervalMinutes)}. Change it with e.g. /interval 2h or /interval 90m (${MIN_INTERVAL_MIN} min to 24 h).`;
      const min = parseInterval(args.join(''));
      if (!min || min < MIN_INTERVAL_MIN || min > MAX_INTERVAL_MIN) {
        return `Give a time between ${MIN_INTERVAL_MIN} min and 24 h, e.g. /interval 2h or /interval 90m.`;
      }
      saveWatchSettings({ ...st, intervalMinutes: min });
      scheduleGradeWatch();
      return `⏱ Checking every ${fmtInterval(min)}.` + (st.paused ? ' (Still paused; /resume to start.)' : ` Next check ${fmtTime(nextGradeCheckAt)}.`);
    },
  },
  check: {
    help: 'Check grades now',
    run: async () => {
      if (gradeCheckRunning) return 'A check is already running.';
      if (browserSync.running) return 'A file sync is running; try again when it is done.';
      const r = await checkGrades();
      if (r.error || r.skipped) return `Check ${describeCheck(r)}.`;
      return r.changes.length ? null : `✅ Checked: ${describeCheck(r)}.`; // changes were already sent
    },
  },
  grades: {
    help: 'Show current grades',
    run: () => {
      let state = {};
      try { state = JSON.parse(fs.readFileSync(gradeWatchPath(BROWSER_SYNC_OWNER), 'utf8')); } catch {}
      const lines = [];
      for (const c of syncedCourses().filter(c => c.moodleId)) {
        const grades = (state.courses || {})[c.moodleId] || [];
        if (!grades.length) continue;
        lines.push(`\n${c.code}`);
        for (const g of grades) lines.push(`  ${g.item}: ${describeGrade(g)}`);
      }
      return lines.length ? `📊 Grades (checked ${fmtTime(state.checkedAt)})${lines.join('\n')}` : 'No grades recorded yet.';
    },
  },
  deadlines: {
    help: 'Upcoming homework deadlines',
    run: () => {
      const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
      today.setHours(0, 0, 0, 0);
      const rows = [];
      for (const c of syncedCourses()) {
        for (const h of c.homework || []) {
          if (!h.deadline) continue;
          const days = Math.round((new Date(h.deadline + 'T00:00:00') - today) / 86400000);
          if (days >= 0) rows.push({ days, text: `${c.code} — ${h.title}` , date: h.deadline });
        }
      }
      rows.sort((a, b) => a.days - b.days);
      if (!rows.length) return 'No upcoming deadlines.';
      return '🗓 Upcoming deadlines\n' + rows.slice(0, 15).map(r =>
        `${r.days === 0 ? 'today' : r.days === 1 ? 'tomorrow' : `in ${r.days} days`} (${r.date}): ${r.text}`).join('\n');
    },
  },
  sync: {
    help: 'Sync from Moodle now (files, deadlines, grades); /sync EE341 for one course',
    run: async (args) => {
      if (browserSync.running) return `A sync is already running — ${browserSync.step}`;
      if (gradeCheckRunning) return 'A grade check is running; try again in a minute.';
      if (zipRunning) return `A zip of ${zipRunning} is being built; try again in a minute.`;
      const only = args.length ? args.join(' ') : null;
      browserSyncAllCourses(only).then(r => sendTelegram(`📁 Sync${only ? ` of ${only}` : ''} done: ${describeSync(r)}`));
      return `📁 Sync${only ? ` of ${only}` : ''} started. I will send the result when it is done (usually 1–2 minutes).`;
    },
  },
};

if (process.env.TELEGRAM_COMMANDS === 'on') telegram.startCommands(telegramCommands);

app.get('/api/conversion/formats', (req, res) => res.json(SUPPORTED_CONVERSIONS));

app.post('/api/conversion/convert', uploadConv.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { targetFormat } = req.body;
  if (!targetFormat) return res.status(400).json({ error: 'targetFormat is required' });
  const srcExt = path.extname(req.file.originalname).slice(1).toLowerCase();
  const allowed = SUPPORTED_CONVERSIONS[srcExt];
  if (!allowed || !allowed.includes(targetFormat.toLowerCase())) return res.status(400).json({ error: `Cannot convert .${srcExt} to .${targetFormat}` });
  const tmpPath = req.file.path; const outDir = os.tmpdir();
  const cleanup = out => { for (const f of [tmpPath, out]) { try { if (f) fs.unlinkSync(f); } catch {} } };
  try {
    const outputPath = await convertFile(tmpPath, targetFormat.toLowerCase(), outDir);
    const outName = path.basename(req.file.originalname, path.extname(req.file.originalname)) + '.' + targetFormat.toLowerCase();
    res.attachment(outName);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    // 'close' also fires when the client goes away mid-download.
    res.on('close', () => { stream.destroy(); cleanup(outputPath); });
  } catch (e) {
    cleanup();
    if (!(e instanceof ConversionError)) console.error('Conversion:', e);
    res.status(500).json({ error: `Conversion failed: ${e instanceof ConversionError ? e.message : 'unexpected error'}` });
  }
});

app.get('/docs/*', (req, res) => {
  // Wildcard (not :filename) so per-course subfolders work, e.g.
  // /docs/materials/CS%20321.A/index.html -- req.params[0] is everything
  // after /docs/, still URL-decoded by Express. Resolve and verify the
  // result stays inside DOCS_DIR before serving, since a relative segment
  // like "../../etc/passwd" would otherwise escape it.
  const docsRoot = path.resolve(req.paths.DOCS_DIR);
  const filePath = path.resolve(docsRoot, req.params[0]);
  if (filePath !== docsRoot && !filePath.startsWith(docsRoot + path.sep)) {
    return res.status(403).send('Forbidden');
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) res.sendFile(filePath);
  else res.status(404).send('Not found');
});

// ── Page Routes ───────────────────────────────────────────────
app.get('/edit', (req, res) => {
  if (req.session.mode === 'guest') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/account', (req, res) => {
  if (req.session.mode === 'guest') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'account.html'));
});

app.get('/conversion', (req, res) => res.sendFile(path.join(__dirname, 'conversion.html')));

// ── Security: block sensitive files from static ───────────────
app.use((req, res, next) => {
  const blocked = ['/users.json', '/data.json', '/data_guest.json', '/docs-registry.json', '/docs-registry_guest.json'];
  if (blocked.includes(req.path) || req.path.startsWith('/userdata/')) {
    return res.status(403).end();
  }
  next();
});

// Force browsers to revalidate HTML/JS/CSS on every load so deploys take effect
// immediately instead of being masked by a stale cached copy.
app.use(express.static(__dirname, {
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.listen(PORT, () => {
  console.log(`Dashboard:  http://localhost:${PORT}`);
});
