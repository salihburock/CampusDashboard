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

// ── Load & Save ───────────────────────────────────────────────
async function loadData() {
  try {
    const [dataRes, pdfsRes] = await Promise.all([fetch('/api/data'), fetch('/api/docs')]);
    state = await dataRes.json();
    uploadedPdfs = await pdfsRes.json();
    document.getElementById('dashboard-title').value = state.title || '';
    renderSections();
    renderPdfList();
  } catch {
    showToast('Failed to load data', true);
  }
}

async function saveData() {
  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    state.title = document.getElementById('dashboard-title').value;
    const res = await fetch('/api/data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!res.ok) throw new Error();
    showToast('Saved!');
  } catch { showToast('Save failed', true); }
  finally { btn.disabled = false; btn.textContent = 'Save'; }
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
  state.sections.push({ title: 'New Section', type: 'notes', collapsed: false, items: [] });
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
    : '<p class="empty-msg">No sections yet. Add one below.</p>';
}

function sectionHtml(section, i) {
  const types = ['homework', 'days', 'documents', 'links', 'notes', 'courses'];
  const typeOptions = types.map(t =>
    `<option value="${t}" ${t === section.type ? 'selected' : ''}>${t}</option>`
  ).join('');

  const itemsHtml = section.items.length
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
        <button onclick="addItem(${i})" class="btn-secondary btn-sm">+ Add Item</button>
      </div>
    </div>`;
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

loadData();
