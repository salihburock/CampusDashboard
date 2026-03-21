// ── Global drag-and-drop document library overlay ─────────────
// Include on any page. Dispatches 'documentuploaded' on document when done.

(function () {
  // ── Styles ──────────────────────────────────────────────────
  const css = document.createElement('style');
  css.textContent = `
    #uo-overlay {
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(67,97,238,.18);
      backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transition: opacity .18s;
    }
    #uo-overlay.active { opacity: 1; pointer-events: all; }
    #uo-drop-box {
      background: var(--surface, #fff);
      border: 3px dashed var(--accent, #4361ee);
      border-radius: 18px;
      padding: 3rem 5rem;
      text-align: center;
      color: var(--accent, #4361ee);
      font-size: 1.1rem; font-weight: 700;
      pointer-events: none;
      user-select: none;
    }
    #uo-drop-box span { font-size: 2.5rem; display: block; margin-bottom: .5rem; }

    /* Naming modal */
    #uo-modal {
      position: fixed; inset: 0; z-index: 9500;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.5); backdrop-filter: blur(3px);
    }
    #uo-modal.hidden { display: none; }
    #uo-modal-box {
      background: var(--surface, #fff);
      border: 1px solid var(--border, #e2e6ed);
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,.22);
      padding: 1.5rem 1.75rem;
      width: min(94vw, 460px);
      font-family: var(--font, system-ui, sans-serif);
      color: var(--text, #1a1d27);
    }
    #uo-modal-box h3 { margin: 0 0 .3rem; font-size: 1rem; }
    #uo-queue-note { font-size:.73rem; color:var(--muted,#6b7280); margin-bottom:.9rem; min-height:1rem; }
    #uo-orig { font-size:.75rem; color:var(--muted,#6b7280); margin-bottom:1rem; word-break:break-all; }
    #uo-modal-box label { display:block; font-size:.7rem; font-weight:700;
      text-transform:uppercase; letter-spacing:.04em; color:var(--muted,#6b7280); margin-bottom:.3rem; }
    #uo-name-wrap { position:relative; }
    #uo-name {
      width:100%; box-sizing:border-box;
      font-size:.9rem; font-family:monospace;
      padding:.5rem 2.5rem .5rem .75rem;
      border:1px solid var(--border,#e2e6ed); border-radius:7px;
      background:var(--bg,#f2f4f8); color:var(--text,#1a1d27); outline:none;
      transition: border-color .15s;
    }
    #uo-name:focus { border-color:var(--accent,#4361ee); }
    #uo-ext {
      position:absolute; right:.75rem; top:50%; transform:translateY(-50%);
      color:var(--muted,#6b7280); font-size:.85rem; font-family:monospace;
      pointer-events:none;
    }
    #uo-hint {
      font-size:.75rem; margin:.4rem 0 0; min-height:1.1rem;
      color:var(--muted,#6b7280);
    }
    #uo-hint.analyzing { font-style:italic; }
    #uo-hint.ready { color:var(--ok,#2d9a45); }
    #uo-hint.no-key { color:var(--muted,#6b7280); font-style:italic; }
    #uo-hint.err { color:var(--danger,#e63946); }
    #uo-actions { display:flex; justify-content:flex-end; gap:.5rem; margin-top:1.1rem; }
    #uo-skip {
      background:none; border:1px solid var(--border,#e2e6ed); border-radius:6px;
      padding:.4rem .9rem; cursor:pointer; color:var(--muted,#6b7280); font-size:.85rem;
    }
    #uo-skip:hover { border-color:var(--muted,#6b7280); }
    #uo-confirm {
      background:var(--accent,#4361ee); color:#fff; border:none;
      border-radius:6px; padding:.4rem 1rem; cursor:pointer;
      font-size:.85rem; font-weight:600; transition: filter .15s;
    }
    #uo-confirm:hover:not(:disabled) { filter:brightness(1.1); }
    #uo-confirm:disabled { opacity:.5; cursor:not-allowed; }

    /* Toast */
    #uo-toast {
      position:fixed; bottom:1.5rem; left:50%; transform:translateX(-50%) translateY(10px);
      background:#1a1d27; color:#fff; border-radius:8px; padding:.5rem 1.1rem;
      font-size:.85rem; font-weight:600; white-space:nowrap;
      box-shadow:0 4px 16px rgba(0,0,0,.25); z-index:9999;
      opacity:0; transition:opacity .2s, transform .2s; pointer-events:none;
    }
    #uo-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  `;
  document.head.appendChild(css);

  // ── Elements ─────────────────────────────────────────────────
  const overlay = Object.assign(document.createElement('div'), { id: 'uo-overlay' });
  overlay.innerHTML = `<div id="uo-drop-box"><span>📄</span>Drop files to upload</div>`;
  document.body.appendChild(overlay);

  const modal = Object.assign(document.createElement('div'), { id: 'uo-modal', className: 'hidden' });
  modal.innerHTML = `
    <div id="uo-modal-box">
      <h3>Name this document</h3>
      <div id="uo-queue-note"></div>
      <div id="uo-orig"></div>
      <label>Document name</label>
      <div id="uo-name-wrap">
        <input id="uo-name" type="text" autocomplete="off" spellcheck="false"
               placeholder="e.g. syllabus-ee321">
        <span id="uo-ext">.pdf</span>
      </div>
      <div id="uo-hint"></div>
      <div id="uo-actions">
        <button id="uo-skip">Skip</button>
        <button id="uo-confirm" disabled>Confirm →</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const toast = Object.assign(document.createElement('div'), { id: 'uo-toast' });
  document.body.appendChild(toast);

  // ── Refs ──────────────────────────────────────────────────────
  const nameInp   = document.getElementById('uo-name');
  const hint      = document.getElementById('uo-hint');
  const confirmBtn= document.getElementById('uo-confirm');
  const skipBtn   = document.getElementById('uo-skip');
  const queueNote = document.getElementById('uo-queue-note');
  const origEl    = document.getElementById('uo-orig');

  // ── State ─────────────────────────────────────────────────────
  let dragDepth = 0;
  const queue = [];
  let stagingId = null;
  let pollTimer = null;

  // ── Drag-and-drop ─────────────────────────────────────────────
  document.addEventListener('dragenter', e => {
    e.preventDefault(); dragDepth++;
    overlay.classList.add('active');
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove('active'); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0;
    overlay.classList.remove('active');
    const accepted = [...e.dataTransfer.files].filter(f =>
      /\.(pdf|doc|docx)$/i.test(f.name)
    );
    if (!accepted.length) { showToast('Only PDF / DOC / DOCX files are accepted', true); return; }
    accepted.forEach(f => queue.push(f));
    processQueue();
  });

  // ── Queue ─────────────────────────────────────────────────────
  function processQueue() {
    if (!modal.classList.contains('hidden')) return; // already open
    if (!queue.length) return;
    openNamingModal(queue.shift());
  }

  async function openNamingModal(file) {
    // Reset UI
    nameInp.value = '';
    confirmBtn.disabled = true;
    hint.className = 'analyzing';
    if (AI_LABEL === 'ollama') { hint.textContent = '✨ Analyzing with Ollama…'; }
    else if (AI_LABEL === 'gemini') { hint.textContent = '✨ Analyzing with Gemini…'; }
    else { hint.className = 'no-key'; hint.textContent = 'Start Ollama for auto-naming'; }
    origEl.textContent = `Original: ${file.name}`;
    queueNote.textContent = queue.length ? `${queue.length + 1} file(s) remaining` : '';
    modal.classList.remove('hidden');
    nameInp.focus();

    // Stage upload
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/upload/stage', { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      stagingId = data.id;
      confirmBtn.disabled = false;
      pollSuggestion(stagingId);
    } catch (e) {
      hint.className = 'err'; hint.textContent = 'Upload failed: ' + e.message;
      stagingId = null;
    }
  }

  let AI_LABEL = null; // 'ollama' | 'gemini' | null
  fetch('/api/upload/stage-info').then(r => r.ok && r.json()).then(d => {
    if (d?.ollama) AI_LABEL = 'ollama';
    else if (d?.gemini) AI_LABEL = 'gemini';
  }).catch(() => {});

  function pollSuggestion(id) {
    clearInterval(pollTimer);
    let tries = 0;
    pollTimer = setInterval(async () => {
      if (++tries > 40) { clearInterval(pollTimer); return; }
      try {
        const r = await fetch(`/api/upload/stage/${id}`);
        const d = await r.json();
        if (!d.ready) return;
        clearInterval(pollTimer);
        if (d.suggested) {
          hint.className = 'ready';
          const label = AI_LABEL === 'ollama' ? 'Ollama' : 'Gemini';
          hint.textContent = `✨ ${label} suggests: ${d.suggested}`;
          if (!nameInp.value) nameInp.value = d.suggested;
        } else if (d.geminiError) {
          const msgs = {
            quota:   '⚠ Quota exceeded',
            auth:    '⚠ API key invalid',
            api:     '⚠ AI error — name manually',
            network: '⚠ Could not reach AI — is Ollama running?',
          };
          hint.className = 'err';
          hint.textContent = msgs[d.geminiError] || '⚠ AI error — name manually';
        } else {
          hint.className = 'no-key';
          hint.textContent = AI_LABEL ? 'Could not detect name — enter manually' : 'Start Ollama for auto-naming';
        }
      } catch {}
    }, 800);
  }

  // ── Live sanitize input ────────────────────────────────────────
  nameInp.addEventListener('input', () => {
    // Only allow a-z 0-9 -  (typing friendly)
    const pos = nameInp.selectionStart;
    const clean = nameInp.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (nameInp.value !== clean) {
      nameInp.value = clean;
      nameInp.setSelectionRange(pos - 1, pos - 1);
    }
    confirmBtn.disabled = !clean || !stagingId;
  });
  nameInp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
    if (e.key === 'Escape') skipBtn.click();
  });

  // ── Confirm ───────────────────────────────────────────────────
  confirmBtn.addEventListener('click', async () => {
    const name = nameInp.value.trim();
    if (!name || !stagingId) return;
    confirmBtn.disabled = true; confirmBtn.textContent = 'Saving…';
    clearInterval(pollTimer);
    try {
      const res = await fetch('/api/upload/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: stagingId, name })
      });
      const d = await res.json();
      if (res.ok) {
        showToast(`✓ Saved as  ${d.name}.pdf`);
        document.dispatchEvent(new CustomEvent('documentuploaded', { detail: d }));
      } else {
        showToast(d.error || 'Save failed', true);
      }
    } catch { showToast('Save failed', true); }
    closeModal();
  });

  skipBtn.addEventListener('click', () => { clearInterval(pollTimer); closeModal(); });

  function closeModal() {
    stagingId = null;
    confirmBtn.textContent = 'Confirm →';
    modal.classList.add('hidden');
    processQueue();
  }

  // ── Toast ──────────────────────────────────────────────────────
  let toastT;
  function showToast(msg, err) {
    clearTimeout(toastT);
    toast.textContent = msg;
    toast.style.background = err ? '#e63946' : '#1a1d27';
    toast.classList.add('show');
    toastT = setTimeout(() => toast.classList.remove('show'), 3000);
  }
})();
