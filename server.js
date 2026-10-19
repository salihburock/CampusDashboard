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
//     stats: { downloaded, unchanged, converted, skipped: [names], failed: [names] } }
// for the frontend to merge into the course item. homework holds the files
// of assignments, so they can go onto the matching homework row.
async function syncMoodleFiles(paths, code, moodleFiles, downloadFile = (owner, url, dest) => moodle.downloadFile(owner, url, dest)) {
  const stats = { downloaded: 0, unchanged: 0, converted: 0, skipped: [], failed: [] };
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
    const stamp = `${f.timemodified}:${f.filesize}`;
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

// ── Browser-based Moodle sync ────────────────────────────────────
// The webservice REST API (moodle.js) is blocked server-side (institution
// restricts webservice/rest/server.php to campus IPs), so this drives a
// real headless Chrome to log in and scrape course pages instead (see
// moodle-browser.js). It has no HTTP request/session to piggyback paths
// off of, so it builds them straight from the semester store, and merges
// results into the stored course data itself (admin.js does this
// client-side for the webservice path; there's no browser open here).
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

// Finds or creates the course entry for a scraped Moodle course, fills in
// catalog fields it's missing, and attaches synced files — same matching
// and precedence rules as admin.js's mergeMoodleCourses/mergeMoodleFiles,
// minus the homework-deadline sync (the browser path has no calendar data,
// only files; see below).
function mergeBrowserCourse(data, { moodleId, code, name, catalog }, { syllabus, resources, homework }) {
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

  if (syllabus) course.syllabus = syllabus;
  const extra = [];
  const filled = new Set();
  for (const h of homework || []) {
    // The browser sees an assignment's page id, not the instance id the
    // webservice sync keyed rows by, so fall back to the assignment's name.
    const row = (course.homework || []).find(r => r.moodleId === `assign:${h.assignId}`)
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

async function browserSyncAllCourses() {
  if (browserSync.running) return { skipped: 'already running' };
  if (!process.env.MOODLE_USERNAME || !process.env.MOODLE_PASSWORD) return { skipped: 'no credentials' };
  Object.assign(browserSync, { running: true, step: 'Starting', startedAt: Date.now(), finishedAt: null });
  const summary = { courses: 0, filesDownloaded: 0, filesConverted: 0, failed: [] };
  try {
    const paths = getPathsForOwner(BROWSER_SYNC_OWNER);
    const merges = [];
    await moodleBrowser.syncAllCourses(async (course, files, downloadFile) => {
      try {
        const catalog = catalogLookup(course.name);
        const code = catalog ? catalog.code : course.name;
        const result = await syncMoodleFiles(paths, code, files, downloadFile);
        merges.push([{ moodleId: course.id, code, name: course.name, catalog }, result]);
        const s = result.stats;
        console.log(`[moodle-browser] ${course.name}: done — ${s.downloaded} downloaded, ${s.unchanged} unchanged, ` +
          `${s.converted} converted to PDF${s.skipped.length ? `, ${s.skipped.length} too large` : ''}${s.failed.length ? `, ${s.failed.length} failed` : ''}`);
        summary.courses++;
        summary.filesDownloaded += s.downloaded;
        summary.filesConverted += s.converted;
      } catch (e) {
        console.error(`[moodle-browser] sync failed for course ${course.id} (${course.name}):`, e.message);
        summary.failed.push(course.name);
      }
    }, (step) => { browserSync.step = step; });

    // Read the data only now, so edits saved while the sync ran are kept.
    let data;
    try { data = JSON.parse(fs.readFileSync(paths.DATA_FILE, 'utf8')); } catch { data = { sections: [] }; }
    for (const [course, result] of merges) mergeBrowserCourse(data, course, result);
    fs.writeFileSync(paths.DATA_FILE, JSON.stringify(data, null, 2));
    console.log('[moodle-browser] sync done:', summary);
  } catch (e) {
    console.error('[moodle-browser] sync aborted:', e.message);
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
app.post('/api/moodle/browser-sync', requireUser, (req, res) => {
  if (!browserSyncAvailable(req)) return res.status(403).json({ error: 'Moodle sync is not set up for this account' });
  if (browserSync.running || gradeCheckRunning) return res.status(409).json({ error: 'A sync is already running', ...browserSync });
  browserSyncAllCourses();
  res.status(202).json({ started: true });
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

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error('[grades] Telegram send failed:', res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.error('[grades] Telegram send failed:', e.message);
    return false;
  }
}

function describeGrade(g) {
  let s = g.grade;
  if (g.range) s += ` (out of ${g.range})`;
  if (g.percentage && g.percentage !== '-') s += `, ${g.percentage}`;
  return s;
}

let gradeCheckRunning = false;
async function checkGrades() {
  if (gradeCheckRunning || browserSync.running) return { skipped: 'busy' };
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
      await sendTelegram(`⚠️ Grade watch couldn't check Moodle: ${e.message}. It will try again next hour.`);
      state.lastError = e.message;
      try { fs.writeFileSync(gradeWatchPath(owner), JSON.stringify(state, null, 2)); } catch {}
    }
    return { error: e.message };
  } finally {
    gradeCheckRunning = false;
  }
}

app.post('/api/moodle/grades/check', requireUser, async (req, res) => {
  if (!browserSyncAvailable(req)) return res.status(403).json({ error: 'Moodle sync is not set up for this account' });
  res.json(await checkGrades());
});

// Hourly, on the hour; never at startup, so restarts don't add requests.
if (process.env.MOODLE_GRADE_WATCH === 'on' && process.env.MOODLE_USERNAME && process.env.MOODLE_PASSWORD) {
  const msToNextHour = 3600000 - (Date.now() % 3600000);
  setTimeout(() => { checkGrades(); setInterval(checkGrades, 3600000); }, msToNextHour);
}

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
