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
  saveUsers([{
    username: 'admin',
    passwordHash: bcrypt.hashSync('REDACTED', 10),
    createdAt: new Date().toISOString()
  }]);
  console.log('Created default user: admin');
}

// ── Per-user data directories ─────────────────────────────────
function ensureUserDirs(username) {
  const userDir = path.join(__dirname, 'userdata', username);
  const docsDir = path.join(userDir, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const dataFile = path.join(userDir, 'data.json');
  if (!fs.existsSync(dataFile)) {
    const legacy = path.join(__dirname, 'data.json');
    if (username === 'admin' && fs.existsSync(legacy)) {
      fs.copyFileSync(legacy, dataFile);
    } else {
      fs.writeFileSync(dataFile, JSON.stringify({ title: `${username}'s Dashboard`, sections: [] }, null, 2));
    }
  }

  const regFile = path.join(userDir, 'docs-registry.json');
  if (!fs.existsSync(regFile)) {
    const legacy = path.join(__dirname, 'docs-registry.json');
    if (username === 'admin' && fs.existsSync(legacy)) {
      fs.copyFileSync(legacy, regFile);
    } else {
      fs.writeFileSync(regFile, JSON.stringify({}, null, 2));
    }
  }

  // Migrate legacy docs/ for admin
  const legacyDocs = path.join(__dirname, 'docs');
  if (username === 'admin' && fs.existsSync(legacyDocs)) {
    for (const f of fs.readdirSync(legacyDocs)) {
      const dest = path.join(docsDir, f);
      if (!fs.existsSync(dest)) {
        try { fs.copyFileSync(path.join(legacyDocs, f), dest); } catch {}
      }
    }
  }
}

// Ensure dirs for all existing users on startup
for (const u of loadUsers()) ensureUserDirs(u.username);

// ── Session setup ─────────────────────────────────────────────
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'REDACTED',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Auth Middleware ───────────────────────────────────────────
const publicPaths = ['/login.html', '/auth/login', '/auth/register', '/api/users'];
app.use((req, res, next) => {
  if (publicPaths.includes(req.path)) return next();
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
  return {
    DATA_FILE:     path.join(userDir, 'data.json'),
    DOCS_DIR:      path.join(userDir, 'docs'),
    REGISTRY_FILE: path.join(userDir, 'docs-registry.json'),
    owner
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

// ── Conversion helpers ────────────────────────────────────────
const SUPPORTED_CONVERSIONS = {
  // ── Video (ffmpeg) ─────────────────────────────────────────
  mp4:  ['mkv', 'webm', 'avi', 'mov', 'gif', 'mp3'],
  mkv:  ['mp4', 'webm', 'avi', 'mov', 'mp3'],
  webm: ['mp4', 'mkv', 'gif', 'mp3'],
  avi:  ['mp4', 'mkv', 'webm', 'mov', 'mp3'],
  mov:  ['mp4', 'mkv', 'webm', 'gif', 'mp3'],
  wmv:  ['mp4', 'mkv', 'webm', 'mp3'],
  flv:  ['mp4', 'mkv', 'webm', 'mp3'],
  ts:   ['mp4', 'mkv', 'mp3'],
  m4v:  ['mp4', 'mkv', 'mp3'],
  mpg:  ['mp4', 'mkv', 'mp3'],
  mpeg: ['mp4', 'mkv', 'mp3'],
  '3gp': ['mp4', 'mkv', 'mp3'],
  ogv:  ['mp4', 'mkv', 'webm', 'mp3'],
  vob:  ['mp4', 'mkv', 'mp3'],

  // ── Audio (ffmpeg) ─────────────────────────────────────────
  mp3:  ['wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'],
  wav:  ['mp3', 'ogg', 'm4a', 'flac', 'aac'],
  ogg:  ['mp3', 'wav', 'flac', 'opus'],
  m4a:  ['mp3', 'wav', 'ogg', 'flac'],
  flac: ['mp3', 'wav', 'ogg', 'm4a'],
  aac:  ['mp3', 'wav', 'm4a'],
  wma:  ['mp3', 'wav', 'm4a'],
  opus: ['mp3', 'wav', 'ogg'],
  aiff: ['mp3', 'wav', 'flac'],
  amr:  ['mp3', 'wav'],

  // ── Image (imagemagick) ────────────────────────────────────
  jpg:  ['png', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'pdf'],
  jpeg: ['png', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'pdf'],
  png:  ['jpg', 'webp', 'gif', 'bmp', 'tiff', 'ico', 'pdf'],
  gif:  ['png', 'jpg', 'webp', 'mp4'],
  bmp:  ['jpg', 'png', 'webp', 'gif'],
  webp: ['jpg', 'png', 'gif', 'bmp'],
  tiff: ['jpg', 'png', 'webp', 'pdf'],
  tif:  ['jpg', 'png', 'webp', 'pdf'],
  ico:  ['png', 'jpg'],
  svg:  ['png', 'jpg', 'webp', 'pdf'],

  // ── Document / spreadsheet / presentation (soffice) ───────
  doc:  ['pdf', 'docx', 'odt', 'rtf', 'txt', 'html', 'epub'],
  docx: ['pdf', 'doc', 'odt', 'rtf', 'txt', 'html', 'epub'],
  odt:  ['pdf', 'docx', 'doc', 'rtf', 'txt', 'html'],
  rtf:  ['pdf', 'docx', 'odt', 'txt'],
  txt:  ['pdf', 'docx', 'odt', 'html'],
  pdf:  ['docx', 'txt', 'html'],
  html: ['pdf', 'docx', 'odt', 'txt'],
  epub: ['pdf', 'html', 'txt'],
  ppt:  ['pdf', 'pptx', 'odp'],
  pptx: ['pdf', 'ppt', 'odp'],
  odp:  ['pdf', 'pptx', 'ppt'],
  xls:  ['pdf', 'csv', 'xlsx', 'ods'],
  xlsx: ['pdf', 'csv', 'xls', 'ods', 'tsv'],
  ods:  ['pdf', 'xlsx', 'xls', 'csv'],
  csv:  ['xlsx', 'xls', 'ods', 'tsv'],
  tsv:  ['csv', 'xlsx', 'xls'],
};

const VIDEO_EXTS = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm4v', 'mpg', 'mpeg', '3gp', 'ogv', 'vob']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus', 'aiff', 'amr']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'ico', 'svg']);

function ffmpegArgs(inputPath, srcExt, targetExt, outputPath) {
  if (srcExt === 'gif' && targetExt === 'mp4') {
    return ['-i', inputPath, '-movflags', 'faststart', '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-y', outputPath];
  }
  if (VIDEO_EXTS.has(srcExt) && targetExt === 'gif') {
    return ['-i', inputPath, '-vf', 'fps=12,scale=480:-1:flags=lanczos', '-y', outputPath];
  }
  if (VIDEO_EXTS.has(srcExt) && targetExt === 'mp3') {
    return ['-i', inputPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', '-y', outputPath];
  }
  if (AUDIO_EXTS.has(srcExt)) {
    return ['-i', inputPath, '-y', outputPath];
  }
  const needsEncode = targetExt === 'webm' || srcExt === 'webm';
  return needsEncode ? ['-i', inputPath, '-y', outputPath]
                     : ['-i', inputPath, '-c', 'copy', '-y', outputPath];
}

function convertFile(inputPath, targetExt, outDir) {
  return new Promise((resolve, reject) => {
    const srcExt = path.extname(inputPath).slice(1).toLowerCase();
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(outDir, `${baseName}.${targetExt}`);

    if (VIDEO_EXTS.has(srcExt) || AUDIO_EXTS.has(srcExt) || (srcExt === 'gif' && targetExt === 'mp4')) {
      const args = ffmpegArgs(inputPath, srcExt, targetExt, outputPath);
      execFile('ffmpeg', args, { timeout: 600000 }, err => err ? reject(err) : resolve(outputPath));
    } else if (IMAGE_EXTS.has(srcExt)) {
      const flat = ['jpg', 'jpeg', 'bmp'].includes(targetExt)
        ? ['-background', 'white', '-flatten']
        : [];
      execFile('convert', [inputPath, ...flat, outputPath], { timeout: 120000 },
        err => err ? reject(err) : resolve(outputPath));
    } else {
      execFile('soffice', ['--headless', '--convert-to', targetExt, '--outdir', outDir, inputPath],
        { timeout: 180000 }, err => err ? reject(err) : resolve(outputPath));
    }
  });
}

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

  users.push({ username, passwordHash: bcrypt.hashSync(password, 10), createdAt: new Date().toISOString() });
  saveUsers(users);
  ensureUserDirs(username);

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
  res.json({
    username:      req.session.user,
    mode:          req.session.mode,
    guestViewUser: req.session.guestViewUser || null
  });
});

// ── Public user list (for guest picker) ───────────────────────
app.get('/api/users', (req, res) => {
  res.json(loadUsers().map(u => u.username));
});

// ── API Routes ────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(req.paths.DATA_FILE, 'utf8'));
    if (req.session.mode === 'guest') {
      data.sections = (data.sections || []).filter(s => s.public === true);
    }
    res.json(data);
  } catch { res.status(500).json({ error: 'Could not read data file' }); }
});

app.put('/api/data', requireUser, (req, res) => {
  try { fs.writeFileSync(req.paths.DATA_FILE, JSON.stringify(req.body, null, 2)); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Could not write data file' }); }
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

app.get('/api/conversion/formats', (req, res) => res.json(SUPPORTED_CONVERSIONS));

app.post('/api/conversion/convert', uploadConv.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { targetFormat } = req.body;
  if (!targetFormat) return res.status(400).json({ error: 'targetFormat is required' });
  const srcExt = path.extname(req.file.originalname).slice(1).toLowerCase();
  const allowed = SUPPORTED_CONVERSIONS[srcExt];
  if (!allowed || !allowed.includes(targetFormat.toLowerCase())) return res.status(400).json({ error: `Cannot convert .${srcExt} to .${targetFormat}` });
  const tmpPath = req.file.path; const outDir = os.tmpdir();
  try {
    const outputPath = await convertFile(tmpPath, targetFormat.toLowerCase(), outDir);
    const outName = path.basename(outputPath);
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(tmpPath); fs.unlinkSync(outputPath); } catch {} });
    stream.on('error', () => { try { fs.unlinkSync(tmpPath); fs.unlinkSync(outputPath); } catch {} });
  } catch (e) { try { fs.unlinkSync(tmpPath); } catch {} res.status(500).json({ error: `Conversion failed: ${e.message}` }); }
});

app.get('/docs/:filename', (req, res) => {
  const filePath = path.join(req.paths.DOCS_DIR, req.params.filename);
  if (fs.existsSync(filePath)) res.sendFile(filePath);
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

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Dashboard:  http://localhost:${PORT}`);
});
