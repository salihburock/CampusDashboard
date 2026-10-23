// ── Course zip ────────────────────────────────────────────────────
// getZip("EE341", "ee341.zip"): everything a student sees in one course,
// fetched over plain HTTP with the saved session (moodle-http.js) the way the
// OzU LMS Downloader extension's "Download Materials" button does it in the
// browser, written to one zip that the dashboard then reads locally:
//
//   manifest.json                 the course, its sections and every activity
//                                 (type, name, link, dates, description,
//                                 submission state), files, grades
//   NN Section/<file>             resources
//   NN Section/<folder>/<file>    folder contents
//   NN Section/<assignment>/<file>  assignment attachments
//   NN Section/<page>.html        page activities
//
// Requests: the course page, the grade report, one per resource and URL (the
// redirect only), folder, assignment and page, plus the file downloads.
// Files the caller already has (opts.known) are listed but not downloaded.
// Nothing here runs on a schedule; callers decide when.

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { parse } = require('node-html-parser');
const moodleHttp = require('./moodle-http');
const moodleBrowser = require('./moodle-browser');
const { parseCode } = require('./grading');

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6, temmuz: 7, ağustos: 8,
  eylül: 9, ekim: 10, kasım: 11, aralık: 12,
};

// "Monday, 19 October 2026, 5:00 PM" -> { date: "2026-10-19", time: "17:00" }
// (Moodle prints dates in the user's own timezone, so no conversion.)
function parseMoodleDate(text) {
  const m = String(text).match(/(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?)?/);
  const month = m && MONTHS[m[2].toLocaleLowerCase('tr-TR')];
  if (!month) return null;
  const pad = (n) => String(n).padStart(2, '0');
  let time = null;
  if (m[4]) {
    let h = Number(m[4]) % (m[6] ? 12 : 24);
    if (m[6] && /p/i.test(m[6])) h += 12;
    time = `${pad(h)}:${m[5]}`;
  }
  return { date: `${m[3]}-${pad(month)}-${pad(m[1])}`, time };
}

// Visible text: screen-reader-only hints ("File", "Assignment") removed.
function textOf(el) {
  if (!el) return '';
  for (const n of el.querySelectorAll('.accesshide, .visually-hidden, .sr-only')) n.remove();
  return el.structuredText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// [{ label: "Due", text: "Monday, 19 October 2026, 5:00 PM", date, time }]
function activityDates(el) {
  return (el ? el.querySelectorAll('[data-region="activity-dates"] > div') : []).map(d => {
    const t = textOf(d).replace(/\s+/g, ' ');
    const i = t.indexOf(':');
    const label = i > 0 ? t.slice(0, i).trim() : '';
    const text = i > 0 ? t.slice(i + 1).trim() : t;
    return { label, text, ...parseMoodleDate(text) };
  });
}

function parseCoursePage(html) {
  const root = parse(html);
  const sections = [];
  for (const sec of root.querySelectorAll('li.section')) {
    const activities = [];
    for (const li of sec.querySelectorAll('li.activity')) {
      // Moodle 5 subsections nest a section inside an activity; their
      // activities belong to the inner section only.
      if (li.closest('li.section') !== sec) continue;
      const type = (li.classNames.match(/modtype_(\w+)/) || [])[1] || 'unknown';
      if (type === 'subsection') continue;
      const link = li.querySelector('a.aalink') || li.querySelector('a[href*="/mod/"]');
      const card = li.querySelector('[data-activityname]');
      activities.push({
        type,
        cmid: Number(li.getAttribute('data-id')) || null,
        name: (card && card.getAttribute('data-activityname')) || textOf(li.querySelector('.instancename')) || type,
        url: link ? link.getAttribute('href') : '',
        dates: activityDates(li),
        description: textOf(li.querySelector('.activity-description, .activity-altcontent')),
        restriction: textOf(li.querySelector('.availabilityinfo')),
      });
    }
    sections.push({
      name: sec.getAttribute('data-sectionname') || textOf(sec.querySelector('.sectionname')) || 'General',
      summary: textOf(sec.querySelector('.summarytext')),
      activities,
    });
  }
  return { title: textOf(root.querySelector('.page-header-headings h1, h1')), sections };
}

const safeName = (s) => String(s || 'untitled').replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'untitled';

function uniqueIn(used, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let out = name;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${base} (${n})${ext}`;
  used.add(out.toLowerCase());
  return out;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

// Builds the zip for one course ({ id, shortname?, fullname? }) at destPath
// and returns its manifest.
//   opts.known(url)  true for files the caller already has (by URL without
//                    query); those are listed with skipped: "known".
//   opts.maxBytes    larger files are listed with skipped: "too large".
//   opts.onProgress(text)
async function buildZip(course, destPath, { known = () => false, maxBytes = Infinity, onProgress = () => {} } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle_zip_'));
  try {
    const page = parseCoursePage(await moodleHttp.getPage(`/course/view.php?id=${Number(course.id)}`));
    const manifest = {
      course: { id: Number(course.id), shortname: course.shortname || '', fullname: course.fullname || page.title },
      fetchedAt: new Date().toISOString(),
      sections: page.sections,
      grades: null,
      errors: [],
    };

    // Each file goes to dir (relative to the zip root) unless it's known.
    const fetchFile = async (act, dir, url, name) => {
      const entry = { name: name || '', url: url.replace(/&amp;/g, '&') };
      act.files.push(entry);
      // pluginfile URLs carry a revision number that changes with the file;
      // assignment attachments don't, so those are always fetched.
      const bare = entry.url.split('?')[0];
      if (!entry.name) {
        entry.name = bare.split('/').pop();
        try { entry.name = decodeURIComponent(entry.name); } catch {}
      }
      if (/\/content\/\d+\//.test(bare) && known(bare)) { entry.skipped = 'known'; return; }
      const tmp = path.join(work, `.dl-${act.cmid}-${act.files.length}`);
      const r = await moodleHttp.download(entry.url, tmp, { maxBytes });
      if (r.tooLarge) { Object.assign(entry, { size: r.size, skipped: 'too large' }); return; }
      entry.name = r.filename || entry.name || 'file';
      fs.mkdirSync(path.join(work, dir), { recursive: true });
      const used = new Set(fs.readdirSync(path.join(work, dir)).map(n => n.toLowerCase()));
      const rel = path.posix.join(dir, uniqueIn(used, safeName(entry.name)));
      fs.renameSync(tmp, path.join(work, rel));
      Object.assign(entry, { path: rel, size: r.size, modified: r.modified, type: r.type });
    };

    const jobs = [];
    page.sections.forEach((sec, i) => {
      const dir = `${String(i).padStart(2, '0')} ${safeName(sec.name)}`;
      for (const act of sec.activities) {
        act.files = [];
        if (act.cmid && ['resource', 'folder', 'assign', 'page', 'url'].includes(act.type)) jobs.push({ act, dir });
      }
    });

    let done = 0;
    await mapLimit(jobs, 3, async ({ act, dir }) => {
      try {
        if (act.type === 'resource') {
          // redirect=1 makes Moodle answer with the file's own URL even for
          // resources set to display inside a page.
          let target = await moodleHttp.redirectTarget(`/mod/resource/view.php?id=${act.cmid}&redirect=1`);
          if (!target) {
            const html = await moodleHttp.getPage(`/mod/resource/view.php?id=${act.cmid}`);
            target = (html.match(/https?:\/\/[^"'\s<>]+\/pluginfile\.php\/[^"'\s<>]*\/mod_resource\/content\/[^"'\s<>]+/) || [])[0];
          }
          if (target) await fetchFile(act, dir, target);
        } else if (act.type === 'folder') {
          const root = parse(await moodleHttp.getPage(`/mod/folder/view.php?id=${act.cmid}`));
          for (const a of root.querySelectorAll('.fp-filename-icon a')) {
            await fetchFile(act, `${dir}/${safeName(act.name)}`, a.getAttribute('href'), textOf(a.querySelector('.fp-filename')));
          }
        } else if (act.type === 'assign') {
          const root = parse(await moodleHttp.getPage(`/mod/assign/view.php?id=${act.cmid}`));
          const dates = activityDates(root);
          if (dates.length) act.dates = dates;
          const intro = root.querySelector('.activity-description, #intro');
          const links = intro ? intro.querySelectorAll('a[href*="pluginfile.php"]').map(a => [a.getAttribute('href'), textOf(a)]) : [];
          // The text only, not the attachment list under it.
          act.description = textOf(intro && (intro.querySelector('.no-overflow') || intro)) || act.description;
          act.submitted = Boolean(root.querySelector('.submissionstatussubmitted'));
          for (const [href, name] of links) await fetchFile(act, `${dir}/${safeName(act.name)}`, href, name);
        } else if (act.type === 'page') {
          const root = parse(await moodleHttp.getPage(`/mod/page/view.php?id=${act.cmid}`));
          const content = root.querySelector('#region-main .box.generalbox') || root.querySelector('#region-main') || root.querySelector('[role="main"]');
          if (content) {
            act.text = textOf(parse(content.outerHTML));
            const rel = `${dir}/${safeName(act.name)}.html`;
            fs.mkdirSync(path.join(work, dir), { recursive: true });
            fs.writeFileSync(path.join(work, rel),
              `<!doctype html><meta charset="utf-8"><title>${safeName(act.name)}</title>\n${content.outerHTML}`);
            act.files.push({ name: path.posix.basename(rel), path: rel, url: act.url });
          }
        } else if (act.type === 'url') {
          act.link = await moodleHttp.redirectTarget(`/mod/url/view.php?id=${act.cmid}&redirect=1`);
        }
      } catch (e) {
        if (e instanceof moodleHttp.SessionExpiredError) throw e;
        manifest.errors.push(`${act.name}: ${e.message}`);
      }
      onProgress(`${++done}/${jobs.length} activities`);
    });

    try { manifest.grades = await moodleHttp.courseGrades(course.id); }
    catch (e) {
      if (e instanceof moodleHttp.SessionExpiredError) throw e;
      manifest.errors.push(`grades: ${e.message}`);
    }

    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    for (const f of fs.readdirSync(work)) if (f.startsWith('.dl-')) fs.rmSync(path.join(work, f), { force: true });
    const zip = new AdmZip();
    zip.addLocalFolder(work);
    zip.writeZip(destPath);
    return manifest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Runs fn with a valid session: when Moodle says the saved one has expired,
// signs in again through the headless browser (moodle-browser.js) and runs
// fn once more.
async function withSession(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof moodleHttp.SessionExpiredError)) throw e;
    console.log('[moodle-zip] session expired, signing in again');
    await moodleBrowser.refreshSession();
    return fn();
  }
}

// "EE341", "ee 341l", "EE 341.A" or a Moodle course id -> one of courses.
// Labs are told apart: "EE341" is the lecture, "EE341L" the lab.
function findCourse(ref, courses) {
  if (/^\d+$/.test(String(ref).trim())) {
    const id = Number(ref);
    return courses.find(c => c.id === id) || { id };
  }
  const want = parseCode(ref);
  if (!want) throw new Error(`"${ref}" is not a course code`);
  const hits = courses.filter(c => {
    const code = parseCode(c.shortname) || parseCode(c.fullname);
    return code && code.base === want.base && code.lab === want.lab;
  });
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No current Moodle course matches "${ref}"`);
  const section = String(ref).match(/\.([A-Za-z])\b/);
  const bySection = section && hits.filter(c => new RegExp(`\\.${section[1]}\\b`, 'i').test(c.shortname));
  if (bySection && bySection.length === 1) return bySection[0];
  throw new Error(`"${ref}" matches ${hits.map(c => c.shortname).join(', ')}`);
}

// getZip("EE341", "/tmp/ee341.zip") -> manifest. Signs in again if needed.
async function getZip(ref, destPath, opts = {}) {
  return withSession(async () => {
    const course = findCourse(ref, await moodleHttp.enrolledCourses());
    return buildZip(course, destPath, opts);
  });
}

// Opens a zip made by buildZip: { manifest, read(entryPath) -> Buffer }.
function readZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new Error('Not a course zip (no manifest.json)');
  return {
    manifest: JSON.parse(zip.readAsText(entry, 'utf8')),
    read: (p) => { const e = zip.getEntry(p); if (!e) throw new Error(`${p} is not in the zip`); return e.getData(); },
  };
}

module.exports = { getZip, buildZip, readZip, withSession, findCourse, parseCoursePage, parseMoodleDate };
