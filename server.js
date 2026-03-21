const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');
const { execFile } = require('child_process');

const app       = express();
const PORT      = process.env.PORT || 3000;
const DATA_FILE     = path.join(__dirname, 'data.json');
const DOCS_DIR      = path.join(__dirname, 'docs');
const REGISTRY_FILE = path.join(__dirname, 'docs-registry.json');

if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR);

// Cross-device safe move (rename fails across filesystems like /tmp → /home)
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

// ── Docs registry (friendly name → file path) ─────────────────
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); }
  catch { return {}; }
}
function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

// ── Ollama auto-naming ────────────────────────────────────────
const OLLAMA_HOST  = process.env.OLLAMA_HOST  || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

// Keep GEMINI_KEY so the env var still works as a fallback if set
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
    // -f 1 -l 3: first 3 pages only; - : output to stdout
    execFile('pdftotext', ['-f', '1', '-l', '3', filePath, '-'], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(stdout.slice(0, 100).trim() || null);
    });
  });
}

async function ollamaNamePdf(filePath) {
  try {
    const text = await extractPdfText(filePath);
    if (!text || text.length < 10) {
      console.log('Ollama: no text extracted from PDF, skipping');
      return null;
    }
    console.log(`Ollama: sending ${text.length} chars to ${OLLAMA_MODEL}`);

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

    if (!res.ok) {
      console.warn('Ollama error:', res.status, await res.text());
      return { error: 'api' };
    }
    const json = await res.json();
    const raw = json.response?.trim() || '';
    console.log('Ollama raw suggestion:', raw);
    const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return clean.length >= 3 ? clean : null;
  } catch (e) {
    console.warn('Ollama naming failed:', e.message);
    return { error: 'network' };
  }
}

async function autoNamePdf(filePath) {
  // Prefer local Ollama; fall back to Gemini if key is set
  try {
    const ping = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (ping.ok) return ollamaNamePdf(filePath);
  } catch {}
  if (GEMINI_KEY) return geminiNamePdf(filePath);
  return null;
}

async function geminiNamePdf(filePath) {
  if (!GEMINI_KEY) return null;

  try {
    const text = await extractPdfText(filePath);
    if (!text || text.length < 10) {
      console.log('Gemini: no text extracted from PDF, skipping');
      return null;
    }
    console.log(`Gemini: sending ${text.length} chars of extracted text`);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: NAMING_PROMPT + '\n\nDocument text:\n' + text }] }],
          generationConfig: { maxOutputTokens: 30, temperature: 0.1 }
        })
      }
    );
    const json = await res.json();
    if (!res.ok) {
      const code = json?.error?.code;
      console.warn('Gemini API error:', JSON.stringify(json).slice(0, 200));
      if (code === 429) return { error: 'quota' };
      if (code === 401 || code === 403) return { error: 'auth' };
      return { error: 'api' };
    }
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    console.log('Gemini raw suggestion:', raw);
    const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return clean.length >= 3 ? clean : null;
  } catch (e) {
    console.warn('Gemini naming failed:', e.message);
    return { error: 'network' };
  }
}

// ── Upload staging (temp store before naming) ─────────────────
const _staged = {};   // id -> { tempPath, originalName, suggested? }

// Auto-expire staged entries after 15 minutes
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, s] of Object.entries(_staged)) {
    if (s.stagedAt < cutoff) {
      try { fs.unlinkSync(s.tempPath); } catch {}
      delete _staged[id];
    }
  }
}, 60 * 1000);

// ── Course catalog ────────────────────────────────────────────
let COURSE_CATALOG = {}; // code -> { code, title, credits, faculty, ... }

function unescapeXml(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function loadCourseCatalog() {
  try {
    const xml = fs.readFileSync(path.join(__dirname, 'coursecatalog.xml'), 'utf8');
    const rows = {};
    const cellRe = /<gnm:Cell Row="(\d+)" Col="(\d+)"[^>]*>([^]*?)<\/gnm:Cell>/g;
    let m;
    while ((m = cellRe.exec(xml)) !== null) {
      const r = parseInt(m[1]), c = parseInt(m[2]);
      if (!rows[r]) rows[r] = {};
      rows[r][c] = unescapeXml(m[3]);
    }
    // Row 0: COURSECODE, TITLE, CREDITS, FACULTY, COREQUISITE, PREREQUISITE, DESCRIPTION
    for (const [ri, row] of Object.entries(rows)) {
      if (parseInt(ri) === 0 || !row[0]) continue;
      COURSE_CATALOG[row[0]] = {
        code:         row[0] || '',
        title:        row[1] || '',
        credits:      row[2] ? row[2].replace(/\.00$/, '') : '',
        faculty:      row[3] || '',
        corequisite:  row[4] || '',
        prerequisite: row[5] || '',
        description:  row[6] || '',
      };
    }
    console.log(`Loaded ${Object.keys(COURSE_CATALOG).length} courses from catalog`);
  } catch (e) {
    console.warn('Could not load course catalog:', e.message);
  }
}
loadCourseCatalog();

// ── Multer: docs (PDF only) ───────────────────────────────────
const docsStorage = multer.diskStorage({
  destination: DOCS_DIR,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, safe);
  }
});
const uploadDocs = multer({
  storage: docsStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.pdf'].includes(ext));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Multer: syllabus (PDF + doc/docx) ────────────────────────
const tmpStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `syl_${Date.now()}_${safe}`);
  }
});
const uploadSyllabus = multer({
  storage: tmpStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.pdf', '.doc', '.docx'].includes(ext));
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Multer: conversion (any file) ────────────────────────────
const convStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `conv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safe}`);
  }
});
const uploadConv = multer({
  storage: convStorage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB for video
});

// ── Conversion helpers ────────────────────────────────────────
const SUPPORTED_CONVERSIONS = {
  mkv:  ['mp4'],
  mp4:  ['mkv'],
  avi:  ['mp4', 'mkv'],
  mov:  ['mp4'],
  doc:  ['pdf'],
  docx: ['pdf'],
  pdf:  ['docx'],
  xls:  ['csv', 'xlsx'],
  xlsx: ['csv', 'xls'],
  csv:  ['xlsx', 'xls'],
};

const VIDEO_EXTS = new Set(['mkv', 'mp4', 'avi', 'mov']);

function convertFile(inputPath, targetExt, outDir) {
  return new Promise((resolve, reject) => {
    const srcExt = path.extname(inputPath).slice(1).toLowerCase();
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(outDir, `${baseName}.${targetExt}`);

    if (VIDEO_EXTS.has(srcExt)) {
      // ffmpeg: remux (copy streams, no re-encode for speed)
      execFile('ffmpeg', ['-i', inputPath, '-c', 'copy', '-y', outputPath],
        { timeout: 600000 },
        (err) => err ? reject(err) : resolve(outputPath));
    } else {
      // LibreOffice: handles doc/docx/pdf/xls/xlsx/csv
      execFile('soffice', ['--headless', '--convert-to', targetExt, '--outdir', outDir, inputPath],
        { timeout: 120000 },
        (err) => {
          if (err) return reject(err);
          // soffice always outputs to outDir with the target extension
          resolve(outputPath);
        });
    }
  });
}

app.use(express.json());

// ── API: dashboard data ───────────────────────────────────────
app.get('/api/data', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    res.status(500).json({ error: 'Could not read data file' });
  }
});

app.put('/api/data', (req, res) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not write data file' });
  }
});

// ── API: course catalog ───────────────────────────────────────
app.get('/api/courses', (req, res) => {
  const q     = (req.query.q || '').toLowerCase().trim();
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  if (!q) return res.json([]);

  const qNorm = q.replace(/\s+/g, '');
  const results = Object.values(COURSE_CATALOG).filter(c => {
    const codeLow  = c.code.toLowerCase();
    const codeNorm = codeLow.replace(/\s+/g, '');
    return codeLow.includes(q) || c.title.toLowerCase().includes(q) ||
           (qNorm.length >= 2 && codeNorm.includes(qNorm));
  }).slice(0, limit);

  res.json(results);
});

app.get('/api/courses/:code', (req, res) => {
  const course = COURSE_CATALOG[req.params.code.toUpperCase()];
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json(course);
});

// ── API: PDF document management ─────────────────────────────
app.get('/api/docs', (req, res) => {
  const files = fs.readdirSync(DOCS_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => ({ name: f, path: `docs/${f}` }));
  res.json(files);
});

app.post('/api/upload', uploadDocs.array('pdf', 20), (req, res) => {
  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No valid PDF files received' });
  res.json(req.files.map(f => ({ name: f.filename, path: `docs/${f.filename}` })));
});

app.delete('/api/docs/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const file = path.join(DOCS_DIR, filename);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  // Remove from registry too
  const reg = loadRegistry();
  const key = Object.keys(reg).find(k => reg[k].file === `docs/${filename}`);
  if (key) { delete reg[key]; saveRegistry(reg); }
  res.json({ ok: true });
});

// ── API: docs registry ────────────────────────────────────────
app.get('/api/docs/registry', (req, res) => res.json(loadRegistry()));

// ── API: staged upload (phase 1 — upload & Gemini analyze) ───
app.get('/api/upload/stage-info', async (req, res) => {
  let ollama = false;
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
    ollama = r.ok;
  } catch {}
  res.json({ ollama, gemini: !!GEMINI_KEY });
});

app.post('/api/upload/stage', uploadSyllabus.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const id = crypto.randomBytes(8).toString('hex');
  _staged[id] = { tempPath: req.file.path, originalName: req.file.originalname, stagedAt: Date.now() };
  res.json({ id, originalName: req.file.originalname });
  // Kick off auto-naming in background (Ollama → Gemini fallback)
  autoNamePdf(req.file.path).then(result => {
    if (!_staged[id]) return;
    if (result && typeof result === 'object') {
      _staged[id].suggested = '';
      _staged[id].geminiError = result.error;
    } else {
      _staged[id].suggested = result ?? '';
    }
  });
});

app.get('/api/upload/stage/:id', (req, res) => {
  const s = _staged[req.params.id];
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ originalName: s.originalName, suggested: s.suggested ?? null, geminiError: s.geminiError ?? null, ready: 'suggested' in s });
});

// ── API: staged upload (phase 2 — confirm name & save) ────────
app.post('/api/upload/confirm', async (req, res) => {
  const { id, name } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  const s = _staged[id];
  if (!s) return res.status(404).json({ error: 'Staging entry not found or expired' });

  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!safeName) return res.status(400).json({ error: 'Invalid name' });

  const ext = path.extname(s.originalName).toLowerCase();
  try {
    let finalPath;
    if (ext === '.pdf') {
      finalPath = path.join(DOCS_DIR, `${safeName}.pdf`);
      moveFile(s.tempPath, finalPath);
    } else {
      const converted = await convertFile(s.tempPath, 'pdf', DOCS_DIR);
      finalPath = path.join(DOCS_DIR, `${safeName}.pdf`);
      moveFile(converted, finalPath);
      try { fs.unlinkSync(s.tempPath); } catch {}
    }
    const reg = loadRegistry();
    reg[safeName] = { name: safeName, file: `docs/${safeName}.pdf`, originalName: s.originalName, uploaded: new Date().toISOString().split('T')[0] };
    saveRegistry(reg);
    delete _staged[id];
    res.json({ name: safeName, file: `docs/${safeName}.pdf` });
  } catch (e) {
    try { fs.unlinkSync(s.tempPath); } catch {}
    delete _staged[id];
    res.status(500).json({ error: e.message });
  }
});

// ── API: syllabus upload (auto-converts doc/docx → PDF) ──────
app.post('/api/upload/syllabus', uploadSyllabus.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const tmpPath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();

  try {
    let finalPath;
    if (ext === '.pdf') {
      // Already PDF — just move to docs/
      const destName = path.basename(tmpPath).replace(/^syl_\d+_/, '');
      const dest = path.join(DOCS_DIR, destName);
      moveFile(tmpPath, dest);
      finalPath = dest;
    } else {
      // doc/docx → convert to PDF via LibreOffice
      const pdfPath = await convertFile(tmpPath, 'pdf', DOCS_DIR);
      fs.unlinkSync(tmpPath);
      finalPath = pdfPath;
    }
    const name = path.basename(finalPath);
    res.json({ name, path: `docs/${name}` });
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    res.status(500).json({ error: `Conversion failed: ${e.message}` });
  }
});

// ── API: file conversion ──────────────────────────────────────
app.get('/api/conversion/formats', (req, res) => {
  res.json(SUPPORTED_CONVERSIONS);
});

app.post('/api/conversion/convert', uploadConv.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { targetFormat } = req.body;
  if (!targetFormat) return res.status(400).json({ error: 'targetFormat is required' });

  const srcExt = path.extname(req.file.originalname).slice(1).toLowerCase();
  const allowed = SUPPORTED_CONVERSIONS[srcExt];
  if (!allowed || !allowed.includes(targetFormat.toLowerCase())) {
    return res.status(400).json({ error: `Cannot convert .${srcExt} to .${targetFormat}` });
  }

  const tmpPath  = req.file.path;
  const outDir   = os.tmpdir();

  try {
    const outputPath = await convertFile(tmpPath, targetFormat.toLowerCase(), outDir);
    const outName = path.basename(outputPath);

    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      try { fs.unlinkSync(tmpPath);    } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    });
    stream.on('error', () => {
      try { fs.unlinkSync(tmpPath);    } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    });
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    res.status(500).json({ error: `Conversion failed: ${e.message}` });
  }
});

// ── Pages ─────────────────────────────────────────────────────
app.get('/edit',       (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/conversion', (req, res) => res.sendFile(path.join(__dirname, 'conversion.html')));

// ── Static files ─────────────────────────────────────────────
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Dashboard:  http://localhost:${PORT}`);
  console.log(`Admin:      http://localhost:${PORT}/edit`);
  console.log(`Conversion: http://localhost:${PORT}/conversion`);
});
