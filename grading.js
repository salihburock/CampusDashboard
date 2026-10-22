// ── Grading overview ──────────────────────────────────────────────
// Builds, for every course on the dashboard, its grading breakdown
// (midterm/final/quiz/homework/project/lab/... and their weights) from the
// course syllabus PDF.
//
// The syllabus is found by content, not by filename: synced and SIS PDFs
// have arbitrary names (sis-ee-301.a.pdf, 84900000312017280.pdf, …), so the
// first page of every top-level PDF in docs/ is matched against the course
// code and term. The weights are pulled out by the OpenAI-compatible LLM
// configured for syllabus picking (LLM_API_URL/KEY/MODEL), cached by file
// hash so each PDF is sent once.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const LLM_API_URL = (process.env.LLM_API_URL || '').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_API_MODEL = process.env.LLM_API_MODEL || '';

const CATEGORIES = ['Midterm', 'Final', 'Quiz', 'Homework', 'Project', 'Lab', 'Attendance', 'Participation', 'Presentation', 'Report', 'Other'];

const PROMPT = `You are reading a university course syllabus (or lab instructions). Extract how the final grade is made up.
Reply with ONLY a JSON object, no markdown fences:
{"components": [{"category": "Midterm", "label": "Midterm Exams (2 exams)", "percent": 50, "bonus": false}], "note": ""}
Rules:
- category: exactly one of ${CATEGORIES.join(', ')}.
- label: the syllabus's own short wording, mentioning counts if given (e.g. "4 quizzes").
- percent: the weight toward the final course grade as a number. For "up to 5%" use 5.
- bonus: true only if the syllabus says it is extra credit on top of 100%.
- If several items share one weight line (e.g. "Midterm Exams 50" for two exams), keep ONE component.
- Only include components that have a weight. Ignore attendance rules without a weight.
- If the text has no grading breakdown at all (e.g. a handbook), return components [] and say why in note.`;

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

const pdfText = (file, firstPageOnly) =>
  run('pdftotext', [...(firstPageOnly ? ['-l', '1'] : []), '-layout', '-enc', 'UTF-8', file, '-']);

// "EE 341L.C : Fundamentals …" -> { base: "EE341", lab: true }
const CODE_RE = /([A-Za-zÇĞİÖŞÜçğıöşü]{2,6})\s*-?\s*(\d{3,4})([Ll])?(?![0-9])/;
function parseCode(text) {
  const m = String(text || '').match(CODE_RE);
  if (!m) return null;
  return { base: (m[1] + m[2]).toLocaleUpperCase('tr-TR').replace(/İ/g, 'I'), lab: Boolean(m[3]) };
}

// "(Fall 2026/27)" or "FALL 2026-27" -> "fall2026"
function parseTerm(text) {
  const m = String(text || '').match(/\b(fall|spring|summer|güz|guz|bahar|yaz)\b[^0-9]{0,3}(20\d\d)/i);
  if (!m) return null;
  const season = { güz: 'fall', guz: 'fall', bahar: 'spring', yaz: 'summer' }[m[1].toLowerCase()] || m[1].toLowerCase();
  return season + m[2];
}

// Codes mentioned near the top of a PDF (its title area).
function headerCodes(head) {
  const top = head.split('\n').filter(l => l.trim()).slice(0, 6).join(' ');
  const out = [];
  const re = new RegExp(CODE_RE.source, 'g');
  for (const m of top.matchAll(re)) out.push((m[1] + m[2]).toLocaleUpperCase('tr-TR').replace(/İ/g, 'I'));
  return { top, codes: out };
}

// Cache key: file contents plus EXTRACT_VERSION, so a fix to the extraction
// re-reads PDFs that were already cached.
const EXTRACT_VERSION = '2';
const sha1 = (file) => crypto.createHash('sha1').update(EXTRACT_VERSION).update(fs.readFileSync(file)).digest('hex');

async function askLlm(text) {
  if (!LLM_API_URL || !LLM_API_KEY || !LLM_API_MODEL) throw new Error('No LLM configured (LLM_API_URL/KEY/MODEL)');
  // Send the part around the assessment table, not the whole syllabus.
  // Layout-mode text pads table columns with long runs of spaces, which would
  // push the last rows of a table past the cut; squeeze them first.
  text = text.replace(/[ \t]{3,}/g, '  ');
  const i = text.search(/assessment|grading|evaluation|weights|değerlendirme|notlandırma/i);
  const excerpt = i >= 0 ? text.slice(Math.max(0, i - 1500), i + 8000) : text.slice(0, 10000);
  const res = await fetch(`${LLM_API_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model: LLM_API_MODEL,
      messages: [{ role: 'user', content: `${PROMPT}\n\nTEXT:\n${excerpt}` }],
      max_tokens: 2000,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`LLM returned HTTP ${res.status}`);
  const raw = (await res.json()).choices?.[0]?.message?.content || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM reply had no JSON');
  const parsed = JSON.parse(m[0]);
  const components = (Array.isArray(parsed.components) ? parsed.components : [])
    .map(c => ({
      category: CATEGORIES.includes(c.category) ? c.category : 'Other',
      label: String(c.label || c.category || '').slice(0, 80),
      percent: Number(c.percent) || 0,
      bonus: c.bonus === true,
    }))
    .filter(c => c.percent > 0);
  return { components, note: String(parsed.note || '').slice(0, 300) };
}

// Picks the PDFs that are this course's syllabus (best first): the title area
// must name the course code; matching term, "Course Syllabus" and, for labs,
// "lab" in the title rank higher. Lecture courses never take lab documents.
function rankCandidates(course, pdfs) {
  const code = parseCode(course.code) || parseCode(course.name);
  if (!code) return [];
  const term = parseTerm(course.code) || parseTerm(course.name);
  const scored = [];
  for (const p of pdfs) {
    if (!p.codes.includes(code.base)) continue;
    const top = p.top.toLowerCase();
    const isLabDoc = /\blab(oratory)?\b/.test(top) && !/course syllabus/.test(top);
    if (isLabDoc !== code.lab) continue;
    let score = 0;
    if (term && p.term === term) score += 4;
    else if (term && p.term && p.term !== term) score -= 6;   // another semester's syllabus
    if (/course syllabus|instructions|syllabus/.test(top)) score += 2;
    if (/handbook|companion|guide/.test(top)) score -= 3;
    if (course.syllabus && p.rel === course.syllabus) score += 1;
    scored.push({ ...p, score });
  }
  return scored.sort((a, b) => b.score - a.score).filter(p => p.score > -3);
}

const displayCode = (c) => String(c.code || '').replace(/\s*\((fall|spring|summer)[^)]*\)\s*$/i, '').trim();

// Returns the rows for the overview section. cache (by file hash) is updated
// in place; only new or changed PDFs go to the LLM.
async function buildOverview(courses, docsDir, cache, log = () => {}) {
  const pdfs = [];
  for (const name of fs.readdirSync(docsDir)) {
    if (!/\.pdf$/i.test(name)) continue;
    const file = path.join(docsDir, name);
    const head = await pdfText(file, true);
    if (!head.trim()) continue;
    const { top, codes } = headerCodes(head);
    pdfs.push({ file, rel: `docs/${name}`, name, top, codes, term: parseTerm(head) });
  }

  const rows = [];
  for (const course of courses) {
    const row = { code: displayCode(course), name: course.name || '', source: null, components: [], note: '' };
    const candidates = rankCandidates(course, pdfs).slice(0, 3);
    for (const cand of candidates) {
      const hash = sha1(cand.file);
      let result = cache[hash];
      if (!result) {
        try {
          log(`grading: reading ${cand.name} for ${row.code}`);
          result = await askLlm(await pdfText(cand.file, false));
          cache[hash] = { ...result, file: cand.name, at: Date.now() };
        } catch (e) {
          row.note = `Could not read ${cand.name}: ${e.message}`;
          continue;
        }
      }
      row.source = cand.rel;
      row.components = result.components;
      row.note = result.note;
      if (result.components.length) break;
    }
    if (!candidates.length) row.note = 'No syllabus found in the documents.';
    rows.push(row);
  }

  // A lab with no grading of its own is usually a share of the lecture's grade.
  for (const row of rows) {
    const code = parseCode(row.code);
    if (!code || !code.lab || row.components.length) continue;
    const parent = rows.find(r => { const c = parseCode(r.code); return c && !c.lab && c.base === code.base; });
    const lab = parent && parent.components.find(c => c.category === 'Lab');
    if (lab) row.note = `Graded as part of ${parent.code} (Lab ${lab.percent}%).`;
  }
  return rows;
}

module.exports = { buildOverview, CATEGORIES, parseCode, parseTerm, rankCandidates };
