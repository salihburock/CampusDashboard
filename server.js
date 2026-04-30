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

const app       = express();
const PORT      = process.env.PORT || 3000;

// -- Session setup --
app.use(cookieParser());
app.use(session({
  secret: 'REDACTED',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -- Auth Middleware --
const publicPaths = ['/login.html', '/auth/login'];
app.use((req, res, next) => {
  if (publicPaths.includes(req.path)) return next();
  if (req.session && req.session.user) return next();
  res.redirect('/login.html');
});

// -- Path Helper --
function getPaths(req) {
  const isGuest = req.session && req.session.mode === 'guest';
  
  const docsDir = path.join(__dirname, isGuest ? 'docs_guest' : 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const dataFile = path.join(__dirname, isGuest ? 'data_guest.json' : 'data.json');
  if (!fs.existsSync(dataFile)) {
    // Initialize guest data if it doesn't exist
    const defaultData = { title: 'Guest Dashboard', sections: [] };
    fs.writeFileSync(dataFile, JSON.stringify(defaultData, null, 2));
  }

  const registryFile = path.join(__dirname, isGuest ? 'docs-registry_guest.json' : 'docs-registry.json');
  if (!fs.existsSync(registryFile)) {
    fs.writeFileSync(registryFile, JSON.stringify({}, null, 2));
  }

  return {
    DATA_FILE: dataFile,
    DOCS_DIR: docsDir,
    REGISTRY_FILE: registryFile
  };
}

// Inject paths into req
app.use((req, res, next) => {
  if (req.session && req.session.user) {
    req.paths = getPaths(req);
  }
  next();
});

// -- Registry helpers --
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
  mp4: ['mkv', 'webm', 'avi', 'mov'], mkv: ['mp4', 'webm', 'avi'], webm: ['mp4', 'mkv'], avi: ['mp4', 'mkv', 'webm'], mov: ['mp4', 'mkv', 'webm'], wmv: ['mp4', 'mkv'], flv: ['mp4', 'mkv'], ts: ['mp4', 'mkv'], m4v: ['mp4', 'mkv'],
  mp3: ['wav', 'ogg', 'm4a', 'flac'], wav: ['mp3', 'ogg', 'm4a', 'flac'], ogg: ['mp3', 'wav', 'flac'], m4a: ['mp3', 'wav', 'ogg'], flac: ['mp3', 'wav', 'ogg'], aac: ['mp3', 'wav', 'm4a'],
  doc: ['pdf'], docx: ['pdf'], pdf: ['docx'], xls: ['csv', 'xlsx'], xlsx: ['csv', 'xls'], csv: ['xlsx', 'xls'],
};
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);

function convertFile(inputPath, targetExt, outDir) {
  return new Promise((resolve, reject) => {
    const srcExt = path.extname(inputPath).slice(1).toLowerCase();
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(outDir, `${baseName}.${targetExt}`);
    if (VIDEO_EXTS.has(srcExt) || AUDIO_EXTS.has(srcExt)) {
      const needsEncode = AUDIO_EXTS.has(srcExt) || targetExt === 'webm' || srcExt === 'webm';
      const args = needsEncode ? ['-i', inputPath, '-y', outputPath] : ['-i', inputPath, '-c', 'copy', '-y', outputPath];
      execFile('ffmpeg', args, { timeout: 600000 }, (err) => err ? reject(err) : resolve(outputPath));
    } else {
      execFile('soffice', ['--headless', '--convert-to', targetExt, '--outdir', outDir, inputPath], { timeout: 120000 }, (err) => err ? reject(err) : resolve(outputPath));
    }
  });
}

// ── Auth Routes ───────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password, guest } = req.body;
  if (guest) {
    req.session.user = 'guest';
    req.session.mode = 'guest';
    return res.json({ ok: true });
  }
  if (username === 'admin' && password === 'REDACTED') {
    req.session.user = 'admin';
    req.session.mode = 'admin';
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login.html');
});

// ── API Routes ────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(req.paths.DATA_FILE, 'utf8'))); }
  catch { res.status(500).json({ error: 'Could not read data file' }); }
});

app.put('/api/data', (req, res) => {
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

app.post('/api/upload', uploadDocs.array('pdf', 20), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No valid PDF files received' });
  res.json(req.files.map(f => ({ name: f.filename, path: `docs/${f.filename}` })));
});

app.delete('/api/docs/:filename', (req, res) => {
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

app.post('/api/upload/stage', uploadSyllabus.single('file'), async (req, res) => {
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

app.post('/api/upload/confirm', async (req, res) => {
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

app.get('/edit', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/conversion', (req, res) => res.sendFile(path.join(__dirname, 'conversion.html')));

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Dashboard:  http://localhost:${PORT}`);
});
