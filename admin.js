// ── State ─────────────────────────────────────────────────────
let state = { title: '', sections: [] };
let uploadedPdfs = [];

// Temp map for course autocomplete (avoids JSON-in-onclick escaping)
const _acResults = {};

// ── Utils ─────────────────────────────────────────────────────
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (isError ? 'error' : 'success');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Semesters ─────────────────────────────────────────────────
let semesters = { active: null, semesters: [], suggestedName: '' };
let editingSem = null; // which semester the editor is currently editing

function semQS() { return editingSem ? '?sem=' + encodeURIComponent(editingSem) : ''; }

async function loadSemesters() {
  try {
    semesters = await (await fetch('/api/semesters')).json();
  } catch { return; }
  if (!editingSem || !semesters.semesters.some(s => s.id === editingSem)) {
    editingSem = semesters.active;
  }
  renderSemesterBar();
}

function renderSemesterBar() {
  const sel = document.getElementById('semester-select');
  if (!sel) return;
  sel.innerHTML = semesters.semesters.map(s => {
    const marks = [];
    if (s.id === semesters.active) marks.push('●');
    if (s.archived) marks.push('🗄');
    const suffix = marks.length ? '   ' + marks.join(' ') : '';
    return `<option value="${esc(s.id)}" ${s.id === editingSem ? 'selected' : ''}>${esc(s.name)}${suffix}</option>`;
  }).join('');

  const cur = semesters.semesters.find(s => s.id === editingSem);
  const isActive = !!cur && cur.id === semesters.active;

  const statusEl = document.getElementById('semester-status');
  if (statusEl) {
    statusEl.textContent = isActive ? t('sem.active_badge') : (cur && cur.archived ? t('sem.archived') : '');
    statusEl.className = 'semester-status ' + (isActive ? 'is-active' : (cur && cur.archived ? 'is-archived' : ''));
  }
  const actBtn = document.getElementById('sem-activate');
  if (actBtn) actBtn.style.display = isActive ? 'none' : '';
  const arcBtn = document.getElementById('sem-archive');
  if (arcBtn) {
    arcBtn.textContent = (cur && cur.archived) ? t('sem.unarchive') : t('sem.archive');
    arcBtn.style.display = isActive ? 'none' : ''; // archive the active one via "New Semester" flow
  }
  const delBtn = document.getElementById('sem-delete');
  if (delBtn) delBtn.style.display = semesters.semesters.length <= 1 ? 'none' : '';
}

function switchSemester(id) { editingSem = id; renderSemesterBar(); loadData(); }

async function activateSemester() {
  await fetch(`/api/semesters/${editingSem}/activate`, { method: 'POST' });
  await loadSemesters();
  showToast(t('sem.activated'));
}

async function toggleArchiveSemester() {
  const cur = semesters.semesters.find(s => s.id === editingSem);
  if (!cur) return;
  await fetch(`/api/semesters/${editingSem}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: !cur.archived })
  });
  const wasArchived = cur.archived;
  await loadSemesters();
  showToast(t(wasArchived ? 'sem.unarchived_ok' : 'sem.archived_ok'));
}

async function renameSemester() {
  const cur = semesters.semesters.find(s => s.id === editingSem);
  const name = prompt(t('sem.rename_prompt'), cur ? cur.name : '');
  if (name == null || !name.trim()) return;
  await fetch(`/api/semesters/${editingSem}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() })
  });
  await loadSemesters();
  showToast(t('sem.renamed'));
}

async function deleteSemester() {
  const cur = semesters.semesters.find(s => s.id === editingSem);
  if (!confirm(t('sem.delete_confirm', { name: cur ? cur.name : '' }))) return;
  const res = await fetch(`/api/semesters/${editingSem}`, { method: 'DELETE' });
  if (!res.ok) { const e = await res.json().catch(() => ({})); showToast(e.error || t('sem.err'), true); return; }
  editingSem = null;
  await loadSemesters();
  await loadData();
  showToast(t('sem.deleted'));
}

function openNewSemester() {
  document.getElementById('sem-name-input').value = semesters.suggestedName || '';
  document.getElementById('sem-archive-current').checked = true;
  document.getElementById('semester-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('sem-name-input').focus(), 50);
}
function closeSemesterModal() {
  document.getElementById('semester-modal').classList.add('hidden');
}
async function confirmNewSemester() {
  const name = document.getElementById('sem-name-input').value.trim();
  const archiveCurrent = document.getElementById('sem-archive-current').checked;
  try {
    const res = await fetch('/api/semesters', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, archiveCurrent })
    });
    const data = await res.json();
    closeSemesterModal();
    editingSem = data.id;
    await loadSemesters();
    await loadData();
    showToast(t('sem.created'));
  } catch { showToast(t('sem.err'), true); }
}

window.addEventListener('langchange', renderSemesterBar);

// ── Load & Save ───────────────────────────────────────────────
async function loadData() {
  try {
    const [dataRes, pdfsRes] = await Promise.all([fetch('/api/data' + semQS()), fetch('/api/docs')]);
    state = await dataRes.json();
    uploadedPdfs = await pdfsRes.json();
    document.getElementById('dashboard-title').value = state.title || '';
    renderSections();
    renderPdfList();
  } catch {
    showToast(t('adm.load_fail'), true);
  }
}

async function saveData() {
  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = t('adm.saving');
  try {
    state.title = document.getElementById('dashboard-title').value;
    const res = await fetch('/api/data' + semQS(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!res.ok) throw new Error();
    showToast(t('adm.save_ok'));
    return true;
  } catch { showToast(t('adm.save_fail'), true); return false; }
  finally { btn.disabled = false; btn.textContent = t('adm.save'); }
}

// ── PDF Management ────────────────────────────────────────────
async function loadPdfs() {
  const [docsRes, regRes] = await Promise.all([fetch('/api/docs'), fetch('/api/docs/registry')]);
  const rawDocs = await docsRes.json();
  const registry = await regRes.json();
  // Merge: registry entries get priority (have friendly names), then any unregistered files
  const regFiles = Object.values(registry).map(r => ({ name: r.name, path: r.file, registered: true, originalName: r.originalName }));
  const regPaths = new Set(regFiles.map(f => f.path));
  const unregistered = rawDocs.filter(f => !regPaths.has(f.path)).map(f => ({ name: f.name, path: f.path, registered: false }));
  uploadedPdfs = [...regFiles, ...unregistered];
  renderPdfList();
  renderSections();
}

async function uploadPdfs() {
  showToast('Drag & drop files anywhere to upload', false);
}

async function deletePdf(filename) {
  if (!confirm(`Delete ${filename}?`)) return;
  await fetch(`/api/docs/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  await loadPdfs();
}

function renderPdfList() {
  const el = document.getElementById('pdf-list');
  if (!uploadedPdfs.length) {
    el.innerHTML = '<p class="empty-msg">No documents yet. Drag &amp; drop files anywhere to upload.</p>';
    return;
  }
  el.innerHTML = uploadedPdfs.map(f => `
    <div class="pdf-item">
      <div style="display:flex;flex-direction:column;gap:.1rem;min-width:0">
        <span class="pdf-name">${esc(f.name)}${f.registered ? '' : ' <span style="font-size:.7rem;color:var(--warning)">(unnamed)</span>'}</span>
        ${f.originalName ? `<span class="pdf-path muted" style="font-size:.7rem">orig: ${esc(f.originalName)}</span>` : ''}
        <span class="pdf-path muted">${esc(f.path)}</span>
      </div>
      <button onclick="deletePdf('${esc(f.name)}')" class="btn-danger btn-sm">Delete</button>
    </div>`).join('');
}

// Refresh library when upload-overlay saves a new document
document.addEventListener('documentuploaded', () => loadPdfs());

// ── Course Autocomplete ───────────────────────────────────────
let _acTimeout = null;

function autoFillCourse(item, course) {
  item.code    = course.code;
  item.name    = course.title;
  item.credits = course.credits;
  item.faculty = course.faculty;
  // Fill notes with catalog info only if notes is currently empty
  if (!item.notes) {
    const parts = [];
    if (course.description)  parts.push(course.description);
    if (course.prerequisite) parts.push('Prerequisite: ' + course.prerequisite);
    if (course.corequisite)  parts.push('Corequisite: '  + course.corequisite);
    if (parts.length) item.notes = parts.join('\n');
  }
}

function isExactMatch(courseCode, query) {
  const norm = s => s.toLowerCase().replace(/\s+/g, '');
  return norm(courseCode) === norm(query);
}

async function handleCourseCodeInput(input, si, ii) {
  state.sections[si].items[ii].code = input.value;
  const dropId = `ac-${si}-${ii}`;
  const drop = document.getElementById(dropId);
  if (!drop) return;

  clearTimeout(_acTimeout);
  const q = input.value.trim();
  if (q.length < 2) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

  _acTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`/api/courses?q=${encodeURIComponent(q)}&limit=8`);
      const courses = await res.json();
      if (!courses.length) { drop.innerHTML = ''; drop.style.display = 'none'; return; }

      // Exact code match → auto-fill immediately, no dropdown needed
      const exact = courses.find(c => isExactMatch(c.code, q));
      if (exact) {
        autoFillCourse(state.sections[si].items[ii], exact);
        drop.innerHTML = ''; drop.style.display = 'none';
        renderSections();
        return;
      }

      // Partial match → show dropdown
      courses.forEach((c, idx) => { _acResults[`${si}_${ii}_${idx}`] = c; });
      drop.innerHTML = courses.map((c, idx) => `
        <div class="ac-item" onmousedown="selectCourse(${si}, ${ii}, '${si}_${ii}_${idx}')">
          <span class="ac-code">${esc(c.code)}</span>
          <span class="ac-name">${esc(c.title)}</span>
        </div>`).join('');
      drop.style.display = 'block';
    } catch {}
  }, 200);
}

function selectCourse(si, ii, key) {
  const course = _acResults[key];
  if (!course) return;
  autoFillCourse(state.sections[si].items[ii], course);
  renderSections();
}

function hideCourseDropdown(si, ii) {
  const drop = document.getElementById(`ac-${si}-${ii}`);
  if (drop) { drop.innerHTML = ''; drop.style.display = 'none'; }
}

// ── File upload helpers ───────────────────────────────────────

// Generic sub-item file upload: section='slides', idx=0, field='file'
// or section=null for top-level fields like 'syllabus'
async function uploadSubFile(input, si, ii, section, idx, field) {
  const file = input.files[0];
  if (!file) return;
  showToast('Uploading…');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload/syllabus', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error);
    const data = await res.json();
    if (section !== null && idx >= 0) {
      state.sections[si].items[ii][section][idx][field] = data.path;
    } else {
      state.sections[si].items[ii][field] = data.path;
    }
    uploadedPdfs = await (await fetch('/api/docs')).json();
    renderPdfList();
    renderSections();
    showToast(`Uploaded: ${data.name}`);
  } catch (e) {
    showToast(`Upload failed: ${e.message}`, true);
  }
  input.value = '';
}

// Renders a combined PDF select + upload-button picker
function filePickerHtml(currentValue, onchangeExpr, uploadCall) {
  const opts = uploadedPdfs.map(f =>
    `<option value="${esc(f.path)}" ${f.path === currentValue ? 'selected' : ''}>${esc(f.name)}</option>`
  ).join('');
  const sel = uploadedPdfs.length
    ? `<select class="field-select fp-select" onchange="${onchangeExpr}">
         <option value="">— none —</option>${opts}
       </select>`
    : `<span class="empty-msg small" style="white-space:nowrap">no PDFs yet</span>`;
  return `<div class="file-picker">
    ${sel}
    <label class="fp-upload btn-secondary btn-sm" title="Upload file (PDF/DOC/DOCX)">
      📎 Upload
      <input type="file" accept=".pdf,.doc,.docx" style="display:none" onchange="${uploadCall}">
    </label>
  </div>`;
}

// ── Section Operations ────────────────────────────────────────
function addSection() {
  state.sections.push({ title: 'New Section', type: 'notes', collapsed: false, visibility: 'private', items: [] });
  renderSections();
}

function cycleSectionVisibility(i) {
  const s = state.sections[i];
  const cur = s.visibility || (s.public ? 'public' : 'private');
  const next = { private: 'public', public: 'unlisted', unlisted: 'private' };
  s.visibility = next[cur] || 'private';
  delete s.public;
  renderSections();
}

function deleteSection(i) {
  if (!confirm(`Delete section "${state.sections[i].title}"?`)) return;
  state.sections.splice(i, 1);
  renderSections();
}

function moveSection(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.sections.length) return;
  [state.sections[i], state.sections[j]] = [state.sections[j], state.sections[i]];
  renderSections();
}

function changeSectionType(i, newType) {
  if (state.sections[i].items.length > 0) {
    if (!confirm('Changing the type will clear all items. Continue?')) {
      renderSections(); return;
    }
  }
  state.sections[i].type  = newType;
  state.sections[i].items = [];
  renderSections();
}

// ── Item Operations ───────────────────────────────────────────
const DEFAULT_ITEM = {
  homework:  { title: '', course: '', deadline: '', notes: '' },
  days:      { name: '', date: '', note: '' },
  documents: { title: '', file: '', tag: '' },
  links:     { title: '', url: '', description: '', tag: '' },
  notes:     { title: '', body: '' },
  courses: {
    code: '', name: '', credits: '', faculty: '', syllabus: '',
    slides:    [],  // { title, file, date, notes }
    homework:  [],  // { title, deadline, file, notes }
    exams:     [],  // { type, date, room, sampleFile, notes }
    resources: [],  // { title, file, notes }
    notes: ''
  },
};

function addItem(si) {
  const type = state.sections[si].type;
  state.sections[si].items.push(JSON.parse(JSON.stringify(DEFAULT_ITEM[type])));
  renderSections();
}

function deleteItem(si, ii) {
  if (!confirm('Delete this item?')) return;
  state.sections[si].items.splice(ii, 1);
  renderSections();
}

// Course sub-item operations
function addCourseSlide(si, ii) {
  state.sections[si].items[ii].slides.push({ title: '', file: '', date: '', notes: '' });
  renderSections();
}
function deleteCourseSlide(si, ii, ki) {
  state.sections[si].items[ii].slides.splice(ki, 1);
  renderSections();
}
function addCourseHomework(si, ii) {
  state.sections[si].items[ii].homework.push({ title: '', deadline: '', file: '', notes: '' });
  renderSections();
}
function deleteCourseHomework(si, ii, hi) {
  state.sections[si].items[ii].homework.splice(hi, 1);
  renderSections();
}
function addCourseExam(si, ii) {
  state.sections[si].items[ii].exams.push({ type: 'Midterm', date: '', room: '', sampleFile: '', notes: '' });
  renderSections();
}
function deleteCourseExam(si, ii, ei) {
  state.sections[si].items[ii].exams.splice(ei, 1);
  renderSections();
}
function addCourseResource(si, ii) {
  state.sections[si].items[ii].resources.push({ title: '', file: '', notes: '' });
  renderSections();
}
function deleteCourseResource(si, ii, ri) {
  state.sections[si].items[ii].resources.splice(ri, 1);
  renderSections();
}

// ── Render ────────────────────────────────────────────────────
function renderSections() {
  document.getElementById('sections-container').innerHTML = state.sections.length
    ? state.sections.map((s, i) => sectionHtml(s, i)).join('')
    : `<p class="empty-msg">${t('adm.no_sections')}</p>`;
}

window.addEventListener('langchange', renderSections);

function sectionHtml(section, i) {
  const vis = section.visibility || (section.public ? 'public' : 'private');
  const visConfig = {
    public:   { label: t('vis.public'),   tip: t('vis.public.tip') },
    unlisted: { label: t('vis.unlisted'), tip: t('vis.unlisted.tip') },
    private:  { label: t('vis.private'),  tip: t('vis.private.tip') },
  };

  const types = ['homework', 'days', 'documents', 'links', 'notes', 'courses', 'grading'];
  const typeOptions = types.map(tp =>
    `<option value="${tp}" ${tp === section.type ? 'selected' : ''}>${tp}</option>`
  ).join('');

  const isGrading = section.type === 'grading';
  const itemsHtml = isGrading
    ? `<p class="empty-msg small">${esc(t('grading.editor_hint', { n: (section.rows || []).length }))}</p>
       <p class="empty-msg small" id="grading-status-${i}"></p>`
    : section.items.length
      ? section.items.map((item, j) => itemHtml(section.type, item, i, j)).join('')
      : '<p class="empty-msg small">No items yet.</p>';

  return `
    <div class="admin-section">
      <div class="admin-section-header">
        <input type="text" class="field-input section-title-input"
               value="${esc(section.title)}"
               oninput="state.sections[${i}].title = this.value"
               placeholder="Section title">
        <select class="field-select" onchange="changeSectionType(${i}, this.value)">
          ${typeOptions}
        </select>
        <label class="toggle-label">
          <input type="checkbox" ${section.collapsed ? 'checked' : ''}
                 onchange="state.sections[${i}].collapsed = this.checked">
          Collapsed by default
        </label>
        <button onclick="cycleSectionVisibility(${i})"
                class="btn-sm btn-visibility is-${vis}"
                title="${visConfig[vis].tip}">
          ${visConfig[vis].label}
        </button>
        <div class="section-move-btns">
          <button onclick="moveSection(${i}, -1)" class="icon-btn"
                  title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button onclick="moveSection(${i}, 1)" class="icon-btn"
                  title="Move down" ${i === state.sections.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
        <button onclick="deleteSection(${i})" class="btn-danger btn-sm">Delete section</button>
      </div>
      <div class="admin-items">${itemsHtml}</div>
      <div class="section-footer">
        ${isGrading
          ? `<button onclick="refreshGrading(${i})" class="btn-secondary btn-sm">${esc(t('grading.refresh'))}</button>`
          : `<button onclick="addItem(${i})" class="btn-secondary btn-sm">+ Add Item</button>`}
      </div>
    </div>`;
}

// The grading overview is built on the server from the course syllabi. Save
// first so the server reads the current courses; reload afterwards so the
// editor doesn't overwrite the new rows on its next save.
async function refreshGrading(i) {
  const status = () => document.getElementById(`grading-status-${i}`);
  if (status()) status().textContent = t('grading.saving');
  if (!(await saveData())) return;
  try {
    const res = await fetch('/api/grading/refresh', { method: 'POST' });
    if (!res.ok && res.status !== 409) throw new Error();
  } catch { if (status()) status().textContent = t('grading.failed'); return; }
  const started = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    let st;
    try { st = await (await fetch('/api/grading/refresh')).json(); } catch { continue; }
    if (status()) status().textContent = t('grading.reading', { s: Math.round((Date.now() - started) / 1000) });
    if (st.running) continue;
    const r = st.lastResult || {};
    await loadData();
    showToast(r.error ? t('grading.failed') + ': ' + r.error : t('grading.done', { n: r.withGrading || 0, total: r.courses || 0 }), Boolean(r.error));
    return;
  }
}

function itemHtml(type, item, si, ii) {
  if (type === 'courses') return courseItemHtml(item, si, ii);
  return `
    <div class="admin-item">
      <div class="item-fields">${itemFieldsHtml(type, item, si, ii)}</div>
      <button onclick="deleteItem(${si}, ${ii})" class="btn-danger btn-icon" title="Delete">✕</button>
    </div>`;
}

function itemFieldsHtml(type, item, si, ii) {
  const inp = (f) => `oninput="state.sections[${si}].items[${ii}]['${f}'] = this.value"`;
  const chg = (f) => `onchange="state.sections[${si}].items[${ii}]['${f}'] = this.value"`;

  switch (type) {
    case 'homework':
      return `
        <input class="field-input" placeholder="Title *" value="${esc(item.title)}" ${inp('title')}>
        <input class="field-input" placeholder="Course" value="${esc(item.course)}" ${inp('course')}>
        <div class="field-group">
          <label class="field-label-sm">Deadline</label>
          <input type="date" class="field-input" value="${esc(item.deadline)}" ${chg('deadline')}>
        </div>
        <input class="field-input" placeholder="Notes" value="${esc(item.notes)}" ${inp('notes')}>`;

    case 'days':
      return `
        <input class="field-input" placeholder="Name *" value="${esc(item.name)}" ${inp('name')}>
        <div class="field-group">
          <label class="field-label-sm">Date</label>
          <input type="date" class="field-input" value="${esc(item.date)}" ${chg('date')}>
        </div>
        <input class="field-input field-full" placeholder="Note" value="${esc(item.note)}" ${inp('note')}>`;

    case 'documents': {
      const pdfOptions = uploadedPdfs.map(f =>
        `<option value="${esc(f.path)}" ${f.path === item.file ? 'selected' : ''}>${esc(f.name)}</option>`
      ).join('');
      const fileField = uploadedPdfs.length
        ? `<select class="field-select" ${chg('file')}>
             <option value="">-- Select PDF --</option>${pdfOptions}
           </select>`
        : `<p class="empty-msg small">Upload PDFs in the section below first.</p>`;
      return `
        <input class="field-input" placeholder="Title *" value="${esc(item.title)}" ${inp('title')}>
        <input class="field-input" placeholder="Tag" value="${esc(item.tag)}" ${inp('tag')}>
        <div class="field-group field-full">
          <label class="field-label-sm">PDF File</label>${fileField}
        </div>`;
    }

    case 'links':
      return `
        <input class="field-input" placeholder="Title *" value="${esc(item.title)}" ${inp('title')}>
        <input class="field-input" placeholder="URL *" value="${esc(item.url)}" ${inp('url')}>
        <input class="field-input" placeholder="Description" value="${esc(item.description)}" ${inp('description')}>
        <input class="field-input" placeholder="Tag" value="${esc(item.tag)}" ${inp('tag')}>`;

    case 'notes':
      return `
        <input class="field-input field-full" placeholder="Title *" value="${esc(item.title)}" ${inp('title')}>
        <textarea class="field-textarea field-full" placeholder="Body" rows="3"
                  ${inp('body')}>${esc(item.body)}</textarea>`;

    default: return '';
  }
}

// ── Course item HTML ──────────────────────────────────────────
function courseItemHtml(item, si, ii) {
  const inp  = (f) => `oninput="state.sections[${si}].items[${ii}]['${f}'] = this.value"`;
  const chg  = (f) => `onchange="state.sections[${si}].items[${ii}]['${f}'] = this.value"`;
  const sinp = (sub, idx, f) =>
    `oninput="state.sections[${si}].items[${ii}]['${sub}'][${idx}]['${f}'] = this.value"`;
  const schg = (sub, idx, f) =>
    `onchange="state.sections[${si}].items[${ii}]['${sub}'][${idx}]['${f}'] = this.value"`;

  // ── Syllabus ───────────────────────────────────────────
  const syllabusPicker = filePickerHtml(
    item.syllabus,
    `state.sections[${si}].items[${ii}].syllabus = this.value`,
    `uploadSubFile(this, ${si}, ${ii}, null, -1, 'syllabus')`
  );

  // ── Slides ─────────────────────────────────────────────
  const slideRows = (item.slides || []).map((sl, ki) => `
    <div class="sub-item sub-item-4">
      <input class="field-input" placeholder="Title" value="${esc(sl.title)}" ${sinp('slides', ki, 'title')}>
      <div class="field-group">
        <label class="field-label-sm">Date</label>
        <input type="date" class="field-input" value="${esc(sl.date)}" ${schg('slides', ki, 'date')}>
      </div>
      <div class="field-group field-full-sub">
        <label class="field-label-sm">File</label>
        ${filePickerHtml(sl.file, `state.sections[${si}].items[${ii}].slides[${ki}].file = this.value`, `uploadSubFile(this, ${si}, ${ii}, 'slides', ${ki}, 'file')`)}
      </div>
      <input class="field-input" placeholder="Notes" value="${esc(sl.notes)}" ${sinp('slides', ki, 'notes')}>
      <button onclick="deleteCourseSlide(${si}, ${ii}, ${ki})" class="btn-danger btn-icon" title="Delete">✕</button>
    </div>`).join('') || '<p class="empty-msg small">No slides yet.</p>';

  // ── Homework ──────────────────────────────────────────
  const hwRows = (item.homework || []).map((hw, hi) => `
    <div class="sub-item sub-item-4">
      <input class="field-input" placeholder="Title *" value="${esc(hw.title)}" ${sinp('homework', hi, 'title')}>
      <div class="field-group">
        <label class="field-label-sm">Deadline</label>
        <input type="date" class="field-input" value="${esc(hw.deadline)}" ${schg('homework', hi, 'deadline')}>
      </div>
      <div class="field-group field-full-sub">
        <label class="field-label-sm">File (optional)</label>
        ${filePickerHtml(hw.file, `state.sections[${si}].items[${ii}].homework[${hi}].file = this.value`, `uploadSubFile(this, ${si}, ${ii}, 'homework', ${hi}, 'file')`)}
      </div>
      <input class="field-input" placeholder="Notes" value="${esc(hw.notes)}" ${sinp('homework', hi, 'notes')}>
      <button onclick="deleteCourseHomework(${si}, ${ii}, ${hi})" class="btn-danger btn-icon" title="Delete">✕</button>
    </div>`).join('') || '<p class="empty-msg small">No homework yet.</p>';

  // ── Exams ─────────────────────────────────────────────
  const examTypes = ['Midterm', 'Final', 'Quiz', 'Lab', 'Project', 'Presentation', 'Other'];
  const examRows = (item.exams || []).map((ex, ei) => `
    <div class="sub-item sub-item-exam">
      <div class="field-group">
        <label class="field-label-sm">Type</label>
        <select class="field-select" ${schg('exams', ei, 'type')}>
          ${examTypes.map(t => `<option ${t === ex.type ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="field-group">
        <label class="field-label-sm">Date</label>
        <input type="date" class="field-input" value="${esc(ex.date)}" ${schg('exams', ei, 'date')}>
      </div>
      <input class="field-input" placeholder="Room / Location" value="${esc(ex.room)}" ${sinp('exams', ei, 'room')}>
      <div class="field-group field-full-sub">
        <label class="field-label-sm">Sample exam file</label>
        ${filePickerHtml(ex.sampleFile, `state.sections[${si}].items[${ii}].exams[${ei}].sampleFile = this.value`, `uploadSubFile(this, ${si}, ${ii}, 'exams', ${ei}, 'sampleFile')`)}
      </div>
      <input class="field-input" placeholder="Notes" value="${esc(ex.notes)}" ${sinp('exams', ei, 'notes')}>
      <button onclick="deleteCourseExam(${si}, ${ii}, ${ei})" class="btn-danger btn-icon" title="Delete">✕</button>
    </div>`).join('') || '<p class="empty-msg small">No exams yet.</p>';

  // ── Resources ─────────────────────────────────────────
  const resourceRows = (item.resources || []).map((rc, ri) => `
    <div class="sub-item sub-item-resource">
      <input class="field-input" placeholder="Title *" value="${esc(rc.title)}" ${sinp('resources', ri, 'title')}>
      <div class="field-group field-full-sub">
        <label class="field-label-sm">File</label>
        ${filePickerHtml(rc.file, `state.sections[${si}].items[${ii}].resources[${ri}].file = this.value`, `uploadSubFile(this, ${si}, ${ii}, 'resources', ${ri}, 'file')`)}
      </div>
      <input class="field-input" placeholder="Notes" value="${esc(rc.notes)}" ${sinp('resources', ri, 'notes')}>
      <button onclick="deleteCourseResource(${si}, ${ii}, ${ri})" class="btn-danger btn-icon" title="Delete">✕</button>
    </div>`).join('') || '<p class="empty-msg small">No resources yet.</p>';

  return `
    <div class="admin-item course-admin-item">

      <!-- Header: code autocomplete + meta fields -->
      <div class="course-admin-header">
        <div class="autocomplete-wrapper">
          <input class="field-input" placeholder="Course code (e.g. ACCT 201)"
                 value="${esc(item.code)}"
                 oninput="handleCourseCodeInput(this, ${si}, ${ii})"
                 onblur="setTimeout(() => hideCourseDropdown(${si}, ${ii}), 150)"
                 autocomplete="off">
          <div class="autocomplete-list" id="ac-${si}-${ii}" style="display:none"></div>
        </div>
        <input class="field-input" placeholder="Course name" value="${esc(item.name)}" ${inp('name')}>
        <input class="field-input credits-input" placeholder="Credits" value="${esc(item.credits)}" ${inp('credits')}>
        <input class="field-input" placeholder="Faculty" value="${esc(item.faculty)}" ${inp('faculty')}>
      </div>

      <!-- Syllabus -->
      <div class="course-field-row">
        <label class="field-label-sm">Syllabus</label>
        ${syllabusPicker}
      </div>

      <!-- Slides -->
      <div class="course-sub-section">
        <div class="sub-section-header">
          <span class="sub-section-title">🎞 Lecture Slides</span>
          <button onclick="addCourseSlide(${si}, ${ii})" class="btn-secondary btn-sm">+ Add</button>
        </div>
        <div class="sub-items">${slideRows}</div>
      </div>

      <!-- Homework -->
      <div class="course-sub-section">
        <div class="sub-section-header">
          <span class="sub-section-title">📚 Homework</span>
          <button onclick="addCourseHomework(${si}, ${ii})" class="btn-secondary btn-sm">+ Add</button>
        </div>
        <div class="sub-items">${hwRows}</div>
      </div>

      <!-- Exams -->
      <div class="course-sub-section">
        <div class="sub-section-header">
          <span class="sub-section-title">📝 Exams</span>
          <button onclick="addCourseExam(${si}, ${ii})" class="btn-secondary btn-sm">+ Add</button>
        </div>
        <div class="sub-items">${examRows}</div>
      </div>

      <!-- Resources -->
      <div class="course-sub-section">
        <div class="sub-section-header">
          <span class="sub-section-title">📎 Resources</span>
          <button onclick="addCourseResource(${si}, ${ii})" class="btn-secondary btn-sm">+ Add</button>
        </div>
        <div class="sub-items">${resourceRows}</div>
      </div>

      <!-- Notes -->
      <div class="field-group">
        <label class="field-label-sm">Notes</label>
        <textarea class="field-textarea" rows="2" ${inp('notes')}>${esc(item.notes)}</textarea>
      </div>

      <button onclick="deleteItem(${si}, ${ii})" class="btn-danger btn-sm">Delete Course</button>
    </div>`;
}

// ── Moodle ZIP Import ─────────────────────────────────────────
let _moodleResult = null; // { zipName, weeks, totalFiles, _flat[] }

const MOODLE_TYPES = ['slides', 'syllabus', 'homework', 'exam', 'resources', 'skip'];
const MOODLE_TYPE_LABELS = {
  slides:    'Slides',
  syllabus:  'Syllabus',
  homework:  'Homework',
  exam:      'Exam',
  resources: 'Resources',
  skip:      'Skip',
};

function detectMoodleType(fileName, weekName) {
  const hay = (fileName + ' ' + weekName).toLowerCase();
  if (/syllabus|ders.?izlencesi|müfredat/.test(hay))              return 'syllabus';
  if (/\b(hw|homework|assignment|ödev|problem.?set|\bps\d)\b/.test(hay)) return 'homework';
  if (/\b(exam|quiz|midterm|final|vize|test|sınav)\b/.test(hay)) return 'exam';
  if (/\b(lab|laboratory|deney)\b/.test(hay))                     return 'resources';
  return 'slides';
}

function closeMoodleModal() {
  document.getElementById('moodle-modal').classList.add('hidden');
  document.getElementById('moodle-zip-input').value = '';
  _moodleResult = null;
}

async function handleMoodleZipSelected(input) {
  const file = input.files[0];
  if (!file) return;

  const modal = document.getElementById('moodle-modal');
  const body  = document.getElementById('moodle-modal-body');
  const titleEl = document.getElementById('moodle-modal-title');

  titleEl.textContent = 'Importing…';
  body.innerHTML = '<p class="moodle-hint">Uploading and extracting ZIP…</p>';
  modal.classList.remove('hidden');

  const fd = new FormData();
  fd.append('zip', file);

  try {
    const res  = await fetch('/api/upload/moodle-zip', { method: 'POST', body: fd });
    const data = await readUploadResponse(res);

    // Build flat index
    let idx = 0;
    data._flat = [];
    data.weeks.forEach(week => {
      week.files.forEach(f => data._flat.push({ ...f, weekName: week.name, idx: idx++ }));
    });

    _moodleResult = data;
    await loadPdfs();
    renderMoodleReview(data);
  } catch (e) {
    body.innerHTML = `<p style="color:var(--danger,#e63946)">Error: ${esc(e.message)}</p>`;
    titleEl.textContent = 'Import Failed';
  }
}

function renderMoodleReview(data) {
  const titleEl = document.getElementById('moodle-modal-title');
  const body    = document.getElementById('moodle-modal-body');

  titleEl.textContent = `${data.zipName} — ${data.totalFiles} PDF${data.totalFiles !== 1 ? 's' : ''} extracted`;

  if (!data.weeks.length) {
    body.innerHTML = '<p class="moodle-hint">No PDFs found in the ZIP. Make sure the ZIP was created by the Moodle extension.</p>';
    return;
  }

  // Course options
  const courseItems = [];
  state.sections.forEach((sec, si) => {
    if (sec.type !== 'courses') return;
    sec.items.forEach((item, ii) =>
      courseItems.push({ label: `${item.code || '?'} – ${item.name || 'Unnamed'}`, si, ii })
    );
  });
  const courseOptions = courseItems.length
    ? courseItems.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join('')
    : '<option value="">— add a course to the dashboard first —</option>';

  // Type select options HTML (reused per row)
  const typeOpts = MOODLE_TYPES.map(t =>
    `<option value="${t}">${MOODLE_TYPE_LABELS[t]}</option>`
  ).join('');

  // Week blocks
  let flatIdx = 0;
  const weeksHtml = data.weeks.map((week, wi) => {
    const startIdx = flatIdx;
    const filesHtml = week.files.map(f => {
      const idx      = flatIdx++;
      const autoType = detectMoodleType(f.originalName, week.name);
      const title    = f.originalName.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim();
      const selOpts  = MOODLE_TYPES.map(t =>
        `<option value="${t}" ${t === autoType ? 'selected' : ''}>${MOODLE_TYPE_LABELS[t]}</option>`
      ).join('');
      return `
        <div class="moodle-file-row" id="mfrow-${idx}">
          <input type="checkbox" id="mf-cb-${idx}" data-wi="${wi}" data-idx="${idx}" checked
                 onchange="onMoodleFileCbChange(${idx}, this.checked)">
          <input type="text" class="field-input moodle-title-inp" id="mf-title-${idx}"
                 value="${esc(title)}">
          <select class="field-select moodle-type-sel" id="mf-type-${idx}"
                  onchange="onMoodleTypeChange(${idx}, this.value)">
            ${selOpts}
          </select>
          <span class="moodle-type-badge moodle-badge-${autoType}" id="mf-badge-${idx}">${MOODLE_TYPE_LABELS[autoType]}</span>
        </div>`;
    }).join('');
    const endIdx = flatIdx - 1;

    return `
      <div class="moodle-week">
        <div class="moodle-week-header">
          <input type="checkbox" id="mw-cb-${wi}" checked
                 onchange="toggleMoodleWeek(${wi}, this.checked)">
          <label for="mw-cb-${wi}" style="cursor:pointer;flex:1">${esc(week.name)}</label>
          <span class="moodle-week-count">${week.files.length} file${week.files.length !== 1 ? 's' : ''}</span>
          <select class="field-select moodle-week-type-sel" style="width:auto;font-size:.75rem"
                  onchange="setMoodleWeekType(${wi}, ${startIdx}, ${endIdx}, this.value)">
            <option value="">Set all…</option>
            ${typeOpts}
          </select>
        </div>
        <div class="moodle-file-list">${filesHtml}</div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <p class="moodle-hint">
      Files are auto-categorized by filename. Adjust types and titles before importing.
      Each category maps to the matching field in the course (Slides, Homework, Exams, Resources, or Syllabus).
    </p>
    ${weeksHtml}
    <div class="moodle-import-bar">
      <label class="moodle-bar-label">Import into:</label>
      <select id="moodle-course-sel" class="field-select">${courseOptions}</select>
      <button class="btn-primary btn-sm" onclick="confirmMoodleImport()"
              ${!courseItems.length ? 'disabled title="Add a course to the dashboard first"' : ''}>
        Import →
      </button>
      <button class="btn-secondary btn-sm" onclick="closeMoodleModal()">Cancel</button>
    </div>`;
}

function onMoodleFileCbChange(idx, checked) {
  const row = document.getElementById(`mfrow-${idx}`);
  if (row) row.classList.toggle('moodle-row-dim', !checked);
  // If unchecked, flip type to skip; if re-checked, restore previous non-skip value
  const sel = document.getElementById(`mf-type-${idx}`);
  if (sel) {
    if (!checked) {
      sel.dataset.prev = sel.value;
      sel.value = 'skip';
    } else {
      sel.value = sel.dataset.prev || 'slides';
    }
    updateMoodleBadge(idx, sel.value);
  }
}

function onMoodleTypeChange(idx, value) {
  updateMoodleBadge(idx, value);
  // Sync checkbox
  const cb = document.getElementById(`mf-cb-${idx}`);
  if (cb) {
    cb.checked = value !== 'skip';
    document.getElementById(`mfrow-${idx}`)?.classList.toggle('moodle-row-dim', value === 'skip');
  }
}

function updateMoodleBadge(idx, type) {
  const badge = document.getElementById(`mf-badge-${idx}`);
  if (!badge) return;
  badge.textContent  = MOODLE_TYPE_LABELS[type] || type;
  badge.className    = `moodle-type-badge moodle-badge-${type}`;
}

function toggleMoodleWeek(wi, checked) {
  document.querySelectorAll(`[data-wi="${wi}"][data-idx]`).forEach(cb => {
    cb.checked = checked;
    onMoodleFileCbChange(parseInt(cb.dataset.idx), checked);
  });
}

function setMoodleWeekType(wi, startIdx, endIdx, type) {
  if (!type) return;
  for (let idx = startIdx; idx <= endIdx; idx++) {
    const sel = document.getElementById(`mf-type-${idx}`);
    const cb  = document.getElementById(`mf-cb-${idx}`);
    if (!sel) continue;
    sel.value = type;
    onMoodleTypeChange(idx, type);
    if (cb) cb.checked = type !== 'skip';
  }
  // Reset the "Set all…" select back to placeholder
  const weekSel = document.querySelector(`#moodle-modal [onchange*="setMoodleWeekType(${wi},"]`);
  if (weekSel) weekSel.value = '';
}

async function confirmMoodleImport() {
  if (!_moodleResult) return;

  const courseItems = [];
  state.sections.forEach((sec, si) => {
    if (sec.type !== 'courses') return;
    sec.items.forEach((item, ii) => courseItems.push({ si, ii }));
  });

  const selIdx      = parseInt(document.getElementById('moodle-course-sel').value);
  const { si, ii }  = courseItems[selIdx];
  const target      = state.sections[si].items[ii];

  // Ensure arrays exist
  ['slides', 'homework', 'exams', 'resources'].forEach(k => { if (!target[k]) target[k] = []; });

  let count = 0;
  _moodleResult._flat.forEach(f => {
    const idx  = f.idx;
    const cb   = document.getElementById(`mf-cb-${idx}`);
    if (!cb || !cb.checked) return;

    const type  = document.getElementById(`mf-type-${idx}`)?.value || 'skip';
    if (type === 'skip') return;

    const title = document.getElementById(`mf-title-${idx}`)?.value.trim()
                  || f.originalName.replace(/\.pdf$/i, '');

    switch (type) {
      case 'syllabus':
        target.syllabus = f.path;
        break;
      case 'slides':
        target.slides.push({ title, file: f.path, date: '', notes: f.weekName });
        break;
      case 'homework':
        target.homework.push({ title, deadline: '', file: f.path, notes: f.weekName });
        break;
      case 'exam':
        target.exams.push({ type: 'Midterm', date: '', room: '', sampleFile: f.path, notes: title });
        break;
      case 'resources':
        target.resources.push({ title, file: f.path, notes: f.weekName });
        break;
    }
    count++;
  });

  if (!count) { showToast('No files selected', true); return; }

  await saveData();
  showToast(`Imported ${count} file${count !== 1 ? 's' : ''}`);
  closeMoodleModal();
  renderSections();
}

// ── Moodle Sync ───────────────────────────────────────────────
// Pulls courses, upcoming deadlines and (optionally) grades from the user's
// connected Moodle (see /account) and merges them into this semester.
// Synced rows carry a moodleId, so a re-sync updates them in place and
// leaves anything added by hand alone.

// Two ways to sync: the webservice token (moodle.js), or, where that's
// blocked, the server's headless-browser sync (moodle-browser.js), which runs
// on the server and writes the course data itself.
let browserSyncMode = false;

async function initMoodleSync() {
  try {
    const bres = await fetch('/api/moodle/browser-sync');
    const bs = bres.ok ? await bres.json() : {};
    if (bs.available) {
      browserSyncMode = true;
      document.getElementById('moodle-sync-btn').style.display = '';
      if (bs.running) { showBrowserSyncModal(); pollBrowserSync(); }
      return;
    }
    const res = await fetch('/api/moodle/status');
    if (!res.ok) return;
    const st = await res.json();
    if (st.configured) document.getElementById('moodle-sync-btn').style.display = '';
  } catch {}
}

function showBrowserSyncModal() {
  document.getElementById('moodle-sync-body').innerHTML =
    `<p class="moodle-hint">${esc(t('bsync.intro'))}</p><p id="bsync-step" style="margin-top:.75rem"></p>`;
  document.getElementById('moodle-sync-modal').classList.remove('hidden');
}

async function runBrowserSync() {
  showBrowserSyncModal();
  const step = document.getElementById('bsync-step');
  // The sync writes the course data on the server and the editor reloads it
  // afterwards, so save what's here first or it would be lost.
  step.textContent = t('bsync.saving');
  if (!(await saveData())) { step.textContent = t('adm.save_fail'); return; }
  try {
    const res = await fetch('/api/moodle/browser-sync', { method: 'POST' });
    if (!res.ok && res.status !== 409) {
      const err = await res.json().catch(() => ({}));
      step.textContent = err.error || t('msync.fail');
      return;
    }
  } catch { step.textContent = t('msync.fail'); return; }
  pollBrowserSync();
}

async function pollBrowserSync() {
  const step = document.getElementById('bsync-step');
  for (;;) {
    let st;
    try { st = await (await fetch('/api/moodle/browser-sync')).json(); } catch { st = null; }
    if (st && !st.running) return finishBrowserSync(st.lastResult || {});
    if (st && step) {
      const secs = Math.round((Date.now() - st.startedAt) / 1000);
      step.textContent = `${st.step || t('bsync.starting')} · ${secs}s`;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function finishBrowserSync(r) {
  const body = document.getElementById('moodle-sync-body');
  if (r.error) {
    body.innerHTML = `<p style="color:var(--danger,#e63946)">${esc(t('bsync.failed', { error: r.error }))}</p>`;
    return;
  }
  let msg = t('bsync.done', { courses: r.courses || 0, files: r.filesDownloaded || 0, converted: r.filesConverted || 0 });
  if (r.failed && r.failed.length) msg += ' · ' + t('bsync.some_failed', { names: r.failed.join(', ') });
  body.innerHTML = `<p>${esc(msg)}</p>`;
  await loadData();
  showToast(msg, Boolean(r.failed && r.failed.length));
}

function closeMoodleSync() {
  document.getElementById('moodle-sync-modal').classList.add('hidden');
}

function moodleSyncError(data) {
  const body = document.getElementById('moodle-sync-body');
  body.innerHTML = `<p style="color:var(--danger,#e63946)">${esc(data.error || t('msync.fail'))}</p>` +
    (data.reconnect ? `<p class="moodle-hint" style="margin-top:.5rem"><a href="/account">${esc(t('msync.connect'))}</a></p>` : '');
}

async function openMoodleSync() {
  if (browserSyncMode) return runBrowserSync();
  const body = document.getElementById('moodle-sync-body');
  body.innerHTML = `<p class="moodle-hint">${esc(t('msync.loading'))}</p>`;
  document.getElementById('moodle-sync-modal').classList.remove('hidden');

  let courses;
  try {
    const res = await fetch('/api/moodle/courses');
    courses = await res.json();
    if (!res.ok) return moodleSyncError(courses);
  } catch { return moodleSyncError({}); }

  if (!courses.length) {
    body.innerHTML = `<p class="moodle-hint">${esc(t('msync.none'))}</p>`;
    return;
  }

  // Current courses first, pre-checked; also pre-check ones already synced.
  const synced = new Set();
  state.sections.forEach(s => s.type === 'courses' && s.items.forEach(i => i.moodleId && synced.add(i.moodleId)));
  courses.sort((a, b) => (b.current - a.current) || a.code.localeCompare(b.code));

  body.innerHTML = `
    <p class="moodle-hint" style="margin-bottom:.75rem">${esc(t('msync.hint'))}</p>
    ${courses.map(c => `
      <label class="toggle-label" style="display:flex;gap:.5rem;padding:.2rem 0;${c.current ? '' : 'opacity:.6'}">
        <input type="checkbox" class="msync-course" value="${c.id}" ${c.current || synced.has(c.id) ? 'checked' : ''}>
        <span><strong>${esc(c.code)}</strong> — ${esc(c.name)}</span>
      </label>`).join('')}
    <label class="toggle-label" style="margin-top:.75rem;display:flex;gap:.5rem">
      <input type="checkbox" id="msync-grades">
      <span>${esc(t('msync.grades'))}</span>
    </label>
    <p class="moodle-hint">${esc(t('msync.grades_hint'))}</p>
    <label class="toggle-label" style="margin-top:.5rem;display:flex;gap:.5rem">
      <input type="checkbox" id="msync-files">
      <span>${esc(t('msync.files'))}</span>
    </label>
    <p class="moodle-hint">${esc(t('msync.files_hint'))}</p>
    <div class="moodle-import-bar" style="margin:0 -1.25rem -1.25rem">
      <button class="btn-primary btn-sm" id="msync-go" onclick="runMoodleSync()">${esc(t('msync.go'))}</button>
      <button class="btn-secondary btn-sm" onclick="closeMoodleSync()">${esc(t('sem.cancel'))}</button>
    </div>`;
}

async function runMoodleSync() {
  const courseIds = [...document.querySelectorAll('.msync-course:checked')].map(cb => Number(cb.value));
  if (!courseIds.length) { showToast(t('msync.pick'), true); return; }
  const grades = document.getElementById('msync-grades').checked;
  const files = document.getElementById('msync-files').checked;
  const btn = document.getElementById('msync-go');
  btn.disabled = true; btn.textContent = t('msync.loading');

  let fetched;
  try {
    const res = await fetch('/api/moodle/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseIds, grades })
    });
    fetched = await res.json();
    if (!res.ok) return moodleSyncError(fetched);
  } catch { return moodleSyncError({}); }

  const counts = mergeMoodleCourses(fetched, grades);

  let fileStats = null;
  if (files) {
    let filesSynced = 0;
    fileStats = { downloaded: 0, unchanged: 0, converted: 0, skipped: 0 };
    for (const mc of fetched) {
      btn.textContent = t('msync.loading_files', { code: mc.code });
      try {
        const res = await fetch('/api/moodle/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ courseId: mc.moodleId, code: mc.code })
        });
        const data = await res.json();
        if (res.ok) {
          mergeMoodleFiles(mc.moodleId, data);
          filesSynced++;
          for (const k of ['downloaded', 'unchanged', 'converted']) fileStats[k] += data.stats[k];
          fileStats.skipped += data.stats.skipped.length;
        }
      } catch {}
    }
    counts.files = filesSynced;
  }

  await saveData();
  closeMoodleSync();
  renderSections();
  let msg = t('msync.done', counts);
  if (fileStats) {
    msg += ' · ' + t('msync.files_done', fileStats);
    if (fileStats.skipped) msg += ' · ' + t('msync.files_skipped', { n: fileStats.skipped });
  }
  showToast(msg);
}

// Attaches a /api/moodle/files result ({syllabus, resources}) to the course
// that was just synced. Resources carry a moodleFileId so a re-sync updates
// them in place instead of duplicating; hand-added resources are untouched.
//
// Assignment files (homework) go onto the matching homework row's file,
// unless the user attached a file of their own there. Rows hold one file,
// so any further files, and files of assignments without a row (past ones),
// are added as resources.
function mergeMoodleFiles(moodleId, { syllabus, resources, homework }) {
  const course = state.sections.flatMap(s => s.type === 'courses' ? s.items : [])
    .find(i => i.moodleId === moodleId);
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

function mergeMoodleCourses(fetched, withGrades) {
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  let section = state.sections.find(s => s.type === 'courses');
  if (!section) {
    // Private by default: synced data can include grades.
    section = { title: 'Courses', type: 'courses', collapsed: false, visibility: 'private', items: [] };
    state.sections.push(section);
  }

  let added = 0, deadlines = 0;
  for (const mc of fetched) {
    // Match a course synced before, else a hand-made one whose code is a
    // prefix of the Moodle short name ("CS321" ↔ "CS 321.A Fall 2026").
    let course = state.sections.flatMap(s => s.type === 'courses' ? s.items : [])
      .find(i => i.moodleId === mc.moodleId);
    const cat = mc.catalog;
    if (!course) {
      course = section.items.find(i => !i.moodleId && norm(i.code) &&
        (norm(mc.code).startsWith(norm(i.code)) || (cat && norm(cat.code) === norm(i.code))));
    }
    if (!course) {
      course = JSON.parse(JSON.stringify(DEFAULT_ITEM.courses));
      course.code = cat ? cat.code : mc.code;
      course.name = mc.name;
      section.items.push(course);
      added++;
    }
    course.moodleId = mc.moodleId;
    if (!course.name) course.name = mc.name;

    // Course catalog (credits, faculty, prerequisites, description): fills
    // what is still empty, like picking the course from the code search.
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

    // Homework: keep hand-added rows; replace synced rows (title, deadline,
    // description, link), keeping any file or notes the user added to them.
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

// ── Theme ─────────────────────────────────────────────────────
(function setupTheme() {
  const btn = document.getElementById('theme-toggle');
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  function apply(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    btn.textContent = dark ? '☀' : '☾';
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }
  apply(saved ? saved === 'dark' : prefersDark);
  btn.addEventListener('click', () =>
    apply(document.documentElement.getAttribute('data-theme') !== 'dark'));
})();

(async function initAdmin() {
  await loadSemesters();
  await loadData();
  initMoodleSync();
})();

// ── Manual PDF Upload ──────────────────────────────────────────
async function handleManualUpload(input) {
  const file = input.files[0];
  if (!file) return;

  showToast('Uploading...');
  const fd = new FormData();
  fd.append('pdf', file); // API expects 'pdf' field name for /api/upload

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    await readUploadResponse(res);

    showToast('Uploaded successfully!');
    await loadPdfs(); // Refresh the list
  } catch (e) {
    showToast('Upload failed: ' + e.message, true);
  } finally {
    input.value = ''; // Reset input
  }
}
