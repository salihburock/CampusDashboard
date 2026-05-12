let selectedFile   = null;
let selectedFormat = null;
let supportedFormats = {};

const FORMAT_LABELS = {
  // Documents
  pdf: 'PDF', docx: 'DOCX', doc: 'DOC', odt: 'ODT', rtf: 'RTF',
  txt: 'TXT', html: 'HTML', epub: 'EPUB',
  // Spreadsheets
  xlsx: 'XLSX', xls: 'XLS', ods: 'ODS', csv: 'CSV', tsv: 'TSV',
  // Presentations
  ppt: 'PPT', pptx: 'PPTX', odp: 'ODP',
  // Video
  mp4: 'MP4', mkv: 'MKV', webm: 'WebM', avi: 'AVI', mov: 'MOV',
  wmv: 'WMV', flv: 'FLV', ts: 'TS', m4v: 'M4V',
  mpg: 'MPG', mpeg: 'MPEG', '3gp': '3GP', ogv: 'OGV', vob: 'VOB',
  // Audio
  mp3: 'MP3', wav: 'WAV', ogg: 'OGG', m4a: 'M4A', flac: 'FLAC',
  aac: 'AAC', wma: 'WMA', opus: 'Opus', aiff: 'AIFF', amr: 'AMR',
  // Image
  jpg: 'JPG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', bmp: 'BMP',
  webp: 'WebP', tiff: 'TIFF', tif: 'TIF', ico: 'ICO', svg: 'SVG',
};

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const res = await fetch('/api/conversion/formats');
  supportedFormats = await res.json();
  renderFormatsReference();
  setupDropZone();
  setupTheme();
}

// ── Drop zone ─────────────────────────────────────────────────
function setupDropZone() {
  const zone  = document.getElementById('drop-zone');
  const input = document.getElementById('file-input');

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); });
}

function handleFile(file) {
  selectedFile   = file;
  selectedFormat = null;

  const ext = file.name.split('.').pop().toLowerCase();
  const targets = supportedFormats[ext];

  document.getElementById('file-name').textContent = `📄 ${file.name}`;
  document.getElementById('file-name').style.display = 'block';
  document.getElementById('convert-btn').style.display = 'none';
  document.getElementById('progress').style.display = 'none';

  if (!targets || !targets.length) {
    document.getElementById('format-row').style.display = 'none';
    document.getElementById('unsupported').style.display = 'block';
    return;
  }

  document.getElementById('unsupported').style.display = 'none';
  document.getElementById('format-row').style.display = 'flex';

  const btns = document.getElementById('format-btns');
  btns.innerHTML = targets.map(fmt => `
    <button class="format-btn" data-fmt="${fmt}" onclick="selectFormat('${fmt}')">
      ${FORMAT_LABELS[fmt] || fmt.toUpperCase()}
    </button>`).join('');

  // Auto-select if only one option
  if (targets.length === 1) selectFormat(targets[0]);
}

function selectFormat(fmt) {
  selectedFormat = fmt;
  document.querySelectorAll('.format-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.fmt === fmt);
  });
  document.getElementById('convert-btn').style.display = 'block';
}

// ── Conversion ────────────────────────────────────────────────
async function startConversion() {
  if (!selectedFile || !selectedFormat) return;

  document.getElementById('convert-btn').style.display = 'none';
  document.getElementById('progress').style.display = 'flex';
  document.getElementById('progress-text').textContent = 'Converting…';

  const fd = new FormData();
  fd.append('file', selectedFile);
  fd.append('targetFormat', selectedFormat);

  try {
    const res = await fetch('/api/conversion/convert', { method: 'POST', body: fd });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Conversion failed' }));
      throw new Error(err.error);
    }

    // Trigger download
    const blob = await res.blob();
    const baseName = selectedFile.name.replace(/\.[^.]+$/, '');
    const outName  = `${baseName}.${selectedFormat}`;
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = outName; a.click();
    URL.revokeObjectURL(url);

    document.getElementById('progress-text').textContent = `Done! Downloaded as ${outName}`;
    showToast(`Converted to ${outName}`);
  } catch (e) {
    showToast(e.message, true);
    document.getElementById('convert-btn').style.display = 'block';
    document.getElementById('progress').style.display = 'none';
  }
}

// ── Formats reference ─────────────────────────────────────────
function renderFormatsReference() {
  const ICONS = {
    // Documents
    pdf: '📄', docx: '📝', doc: '📝', odt: '📝', rtf: '📝',
    txt: '📄', html: '🌐', epub: '📚',
    // Spreadsheets
    xlsx: '📊', xls: '📊', ods: '📊', csv: '📋', tsv: '📋',
    // Presentations
    ppt: '📽️', pptx: '📽️', odp: '📽️',
    // Video
    mp4: '🎬', mkv: '🎬', webm: '🎬', avi: '🎬', mov: '🎬',
    wmv: '🎬', flv: '🎬', ts: '🎬', m4v: '🎬',
    mpg: '🎬', mpeg: '🎬', '3gp': '🎬', ogv: '🎬', vob: '🎬',
    // Audio
    mp3: '🎵', wav: '🎵', ogg: '🎵', m4a: '🎵', flac: '🎵',
    aac: '🎵', wma: '🎵', opus: '🎵', aiff: '🎵', amr: '🎵',
    // Image
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️',
    webp: '🖼️', tiff: '🖼️', tif: '🖼️', ico: '🖼️', svg: '🖼️',
  };

  document.getElementById('formats-grid').innerHTML = Object.entries(supportedFormats)
    .map(([src, targets]) => `
      <div class="fmt-row">
        <span class="fmt-src">${ICONS[src] || '📁'} .${src}</span>
        <span class="fmt-arrow">→</span>
        <span class="fmt-targets">${targets.map(t => `<span class="tag">.${t}</span>`).join('')}</span>
      </div>`).join('');
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (isError ? 'error' : 'success');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Theme ─────────────────────────────────────────────────────
function setupTheme() {
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
}

init();
