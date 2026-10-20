// ── Utilities ────────────────────────────────────────────────

function daysUntil(dateStr) {
  const now = new Date();
  const target = new Date(dateStr + "T00:00:00");
  const diff = target - new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round(diff / 86400000);
}

function urgencyClass(days) {
  if (days < 0)  return "overdue";
  if (days <= 1) return "urgent";
  if (days <= 5) return "soon";
  return "ok";
}

function deadlineLabel(days) {
  if (days < 0)   return t('app.overdue', { n: Math.abs(days) });
  if (days === 0) return t('app.due_today');
  if (days === 1) return t('app.due_tmrw');
  return t('app.due_in', { n: days });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// ── Course card ───────────────────────────────────────────────
// A course card is a self-contained panel that holds all
// information for one course: homework, exams, slides, resources.

function pdfBtn(file, label, openPdf, btnText) {
  const btn = el("button", "pdf-btn");
  btn.textContent = btnText || "📄";
  btn.title = `Open: ${label}`;
  btn.addEventListener("click", e => { e.stopPropagation(); openPdf(file, label); });
  return btn;
}

function renderCourseCard(course, openPdf) {
  const card = el("div", "card course-card");

  // ── Header ────────────────────────────────────────────────
  const hdr = el("div", "course-hdr");
  const hdrLeft = el("div", "course-hdr-left");
  if (course.code)    hdrLeft.appendChild(el("span", "tag accent", course.code));
  hdrLeft.appendChild(el("div", "course-name", course.name || course.code || "Unnamed"));
  if (course.faculty) hdrLeft.appendChild(el("div", "course-faculty", course.faculty));
  hdr.appendChild(hdrLeft);

  const hdrRight = el("div", "course-hdr-right");
  if (course.credits) hdrRight.appendChild(el("span", "tag", course.credits + " cr"));
  if (course.syllabus) hdrRight.appendChild(pdfBtn(course.syllabus, `${course.code || course.name} — ${t('app.syllabus')}`, openPdf, `📄 ${t('app.syllabus')}`));
  hdr.appendChild(hdrRight);
  card.appendChild(hdr);

  // ── Grades ────────────────────────────────────────────────
  if (course.grades && course.grades.length) {
    const sub = el("div", "course-sub");
    sub.appendChild(el("div", "course-sub-label", t('app.grades')));
    for (const g of course.grades) {
      const row = el("div", "course-row");

      const info = el("div", "course-row-info");
      info.appendChild(el("span", "course-row-title", g.item));
      if (g.feedback) info.appendChild(el("span", "course-row-sub", g.feedback));

      const actions = el("div", "course-row-actions");
      if (g.grade) actions.appendChild(el("span", "tag accent", g.range ? `${g.grade} / ${g.range}` : g.grade));
      if (g.percentage && g.percentage !== "-") actions.appendChild(el("span", "tag", g.percentage));
      if (g.weight && g.weight !== "-") actions.appendChild(el("span", "tag", `w: ${g.weight}`));

      row.appendChild(info);
      row.appendChild(actions);
      sub.appendChild(row);
    }
    card.appendChild(sub);
  }

  // ── Homework ──────────────────────────────────────────────
  if (course.homework && course.homework.length) {
    const sub = el("div", "course-sub");
    sub.appendChild(el("div", "course-sub-label", t('app.homework')));
    for (const hw of course.homework) {
      const days = daysUntil(hw.deadline);
      const urg  = urgencyClass(days);
      const row  = el("div", `course-row hw-border-${urg}`);

      const info = el("div", "course-row-info");
      info.appendChild(el("span", "course-row-title", hw.title));
      // description: the assignment text from Moodle
      if (hw.notes || hw.description) info.appendChild(el("span", "course-row-sub", hw.notes || hw.description));

      const actions = el("div", "course-row-actions");
      actions.appendChild(el("span", `deadline-badge ${urg}`,
        (urg === "overdue" ? "⚠ " : "🗓 ") + deadlineLabel(days) + " · " + formatDate(hw.deadline)
      ));
      if (hw.file) actions.appendChild(pdfBtn(hw.file, hw.title, openPdf));
      if (hw.url) {
        // Opens the assignment on Moodle, e.g. to submit it.
        const link = el("a", "pdf-btn", "🔗");
        link.href = hw.url; link.target = "_blank"; link.rel = "noopener";
        link.title = t('app.open_moodle');
        actions.appendChild(link);
      }

      row.appendChild(info);
      row.appendChild(actions);
      sub.appendChild(row);
    }
    card.appendChild(sub);
  }

  // ── Exams ─────────────────────────────────────────────────
  if (course.exams && course.exams.length) {
    const sub = el("div", "course-sub");
    sub.appendChild(el("div", "course-sub-label", t('app.exams')));
    for (const ex of course.exams) {
      const days = ex.date ? daysUntil(ex.date) : null;
      const row  = el("div", "course-row");

      const info = el("div", "course-row-info");
      const titleRow = el("div", "course-row-title-row");
      if (ex.type) titleRow.appendChild(el("span", "exam-badge", ex.type));
      if (ex.date) {
        const cd = el("span", `course-countdown${days < 0 ? " past" : ""}`,
          days < 0 ? t('app.ago', { n: Math.abs(days) }) : days === 0 ? t('app.today') : t('app.in_days', { n: days })
        );
        titleRow.appendChild(cd);
        titleRow.appendChild(el("span", "course-row-sub", " · " + formatDate(ex.date)));
      }
      info.appendChild(titleRow);
      if (ex.notes) info.appendChild(el("span", "course-row-sub", ex.notes));

      const actions = el("div", "course-row-actions");
      if (ex.room) actions.appendChild(el("span", "tag", "📍 " + ex.room));
      if (ex.sampleFile) actions.appendChild(pdfBtn(ex.sampleFile, `${ex.type} — Sample`, openPdf, "📎 Sample"));

      row.appendChild(info);
      row.appendChild(actions);
      sub.appendChild(row);
    }
    card.appendChild(sub);
  }

  // ── Slides ────────────────────────────────────────────────
  if (course.slides && course.slides.length) {
    const sub = el("div", "course-sub");
    sub.appendChild(el("div", "course-sub-label", t('app.slides')));
    for (const sl of course.slides) {
      const row = el("div", "course-row");
      const info = el("div", "course-row-info");
      info.appendChild(el("span", "course-row-title", sl.title));
      if (sl.date) info.appendChild(el("span", "course-row-sub", formatDate(sl.date)));
      if (sl.notes) info.appendChild(el("span", "course-row-sub", sl.notes));

      const actions = el("div", "course-row-actions");
      if (sl.file) actions.appendChild(pdfBtn(sl.file, sl.title, openPdf));

      row.appendChild(info);
      row.appendChild(actions);
      sub.appendChild(row);
    }
    card.appendChild(sub);
  }

  // ── Resources ─────────────────────────────────────────────
  // A dropdown, closed by default: synced courses can have dozens of files.
  // Grouped by the Moodle section (week) each file's notes name.
  if (course.resources && course.resources.length) {
    const sub = el("details", "course-sub course-files");
    const summary = el("summary", "course-sub-label");
    summary.textContent = `${t('app.resources')} (${course.resources.length})`;
    sub.appendChild(summary);

    const groups = new Map();
    for (const rc of course.resources) {
      const key = rc.notes || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rc);
    }
    for (const [section, items] of groups) {
      if (section && groups.size > 1) {
        const h = el("div", "course-files-section");
        h.textContent = section;
        sub.appendChild(h);
      }
      for (const rc of items) {
        const row = el("div", "course-row");
        const info = el("div", "course-row-info");
        const title = el("span", "course-row-title");
        title.textContent = rc.title;
        info.appendChild(title);
        if (rc.notes && groups.size === 1) {
          const note = el("span", "course-row-sub");
          note.textContent = rc.notes;
          info.appendChild(note);
        }

        const actions = el("div", "course-row-actions");
        if (rc.file) actions.appendChild(pdfBtn(rc.file, rc.title, openPdf));

        row.appendChild(info);
        row.appendChild(actions);
        sub.appendChild(row);
      }
    }
    card.appendChild(sub);
  }

  // ── Free-form notes ───────────────────────────────────────
  if (course.notes) {
    card.appendChild(el("div", "course-footer-notes", course.notes));
  }

  return card;
}

// ── Simple card renderers ─────────────────────────────────────

function renderDayCard(item) {
  const days = daysUntil(item.date);
  const card = el("div", "card");
  card.appendChild(el("div", "card-title", item.name));
  const countEl = el("div", `days-countdown${days < 0 ? " past" : ""}`,
    days < 0 ? t('app.ago', { n: Math.abs(days) }) : days === 0 ? t('app.today') : String(days)
  );
  card.appendChild(countEl);
  const sub = days !== 0
    ? (days > 0 ? "days away · " : "") + formatDate(item.date)
    : formatDate(item.date);
  card.appendChild(el("div", "days-label", sub));
  if (item.note) card.appendChild(el("div", "card-notes", item.note));
  return card;
}

function renderDocumentCard(item, openPdf) {
  const card = el("div", "card doc-card");
  card.title = "Click to open PDF";
  card.addEventListener("click", () => openPdf(item.file, item.title));
  card.appendChild(el("div", "doc-icon", "📄"));
  card.appendChild(el("div", "card-title", item.title));
  if (item.tag) card.appendChild(el("span", "tag", item.tag));
  card.appendChild(el("div", "card-subtitle", item.file.split("/").pop()));
  return card;
}

function renderLinkCard(item) {
  const card = el("div", "card link-card");
  const a = document.createElement("a");
  a.href = item.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.appendChild(el("div", "card-title", item.title));
  if (item.description) a.appendChild(el("div", "card-subtitle", item.description));
  card.appendChild(a);
  if (item.tag) card.appendChild(el("span", "tag", item.tag));
  return card;
}

function renderNoteCard(item) {
  const card = el("div", "card");
  card.appendChild(el("div", "card-title", item.title));
  card.appendChild(el("div", "notes-body", item.body));
  return card;
}

// ── Section renderer ──────────────────────────────────────────

function renderSection(section, openPdf) {
  const panel = el("div", `section-panel${section.collapsed ? " collapsed" : ""}`);

  const hdr = el("div", "section-header");
  const titleEl = el("div", "section-title");
  const icons = { courses: "🎓", days: "📅", documents: "📁", links: "🔗", notes: "📝" };
  titleEl.innerHTML = `${icons[section.type] || "▪"} ${section.title}`;
  titleEl.appendChild(el("span", "section-count", String(section.items.length)));
  if (section.type === "courses") {
    const totalCredits = section.items.reduce((sum, c) => {
      const n = parseFloat(c.credits);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
    if (totalCredits > 0) {
      titleEl.appendChild(el("span", "section-credits", t("app.total_credits", { n: totalCredits })));
    }
  }
  hdr.appendChild(titleEl);
  hdr.appendChild(el("span", "section-chevron", "▾"));
  hdr.addEventListener("click", () => panel.classList.toggle("collapsed"));

  const body = el("div", "section-body");
  const isCourses = section.type === "courses";
  const grid = el("div", isCourses ? "course-grid" : "card-grid");

  for (const item of section.items) {
    let card;
    switch (section.type) {
      case "courses":   card = renderCourseCard(item, openPdf); break;
      case "days":      card = renderDayCard(item); break;
      case "documents": card = renderDocumentCard(item, openPdf); break;
      case "links":     card = renderLinkCard(item); break;
      case "notes":     card = renderNoteCard(item); break;
      default:          card = renderNoteCard(item);
    }
    grid.appendChild(card);
  }

  body.appendChild(grid);
  panel.appendChild(hdr);
  panel.appendChild(body);
  return panel;
}

// ── PDF Modal ─────────────────────────────────────────────────

function setupModal() {
  const modal    = document.getElementById("pdf-modal");
  const frame    = document.getElementById("pdf-frame");
  const titleEl  = document.getElementById("pdf-title");
  const closeBtn = document.getElementById("pdf-close");
  const extBtn   = document.getElementById("pdf-external");
  const backdrop = modal.querySelector(".modal-backdrop");

  function close() {
    modal.classList.remove("open");
    frame.src = "";
  }

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });

  return function openPdf(file, title) {
    titleEl.textContent = title || file;
    frame.src = file;
    if (extBtn) extBtn.href = file;
    modal.classList.add("open");
  };
}

// ── Clock ─────────────────────────────────────────────────────

function startClock() {
  const clockEl = document.getElementById("clock");
  function tick() {
    const now  = new Date();
    const date = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    clockEl.textContent = `${date}  ${time}`;
  }
  tick();
  setInterval(tick, 1000);
}

// ── Theme ─────────────────────────────────────────────────────

function setupTheme() {
  const btn = document.getElementById("theme-toggle");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const saved = localStorage.getItem("theme");
  const isDark = saved ? saved === "dark" : prefersDark;

  function apply(dark) {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    btn.textContent = dark ? "☀" : "☾";
    localStorage.setItem("theme", dark ? "dark" : "light");
  }

  apply(isDark);
  btn.addEventListener("click", () => {
    apply(document.documentElement.getAttribute("data-theme") !== "dark");
  });
}

// ── Dashboard loading ─────────────────────────────────────────

let _openPdf = null;

async function loadDashboard(sem) {
  const app = document.getElementById("app");
  try {
    const res = await fetch("/api/data" + (sem ? "?sem=" + encodeURIComponent(sem) : ""));
    const data = await res.json();

    document.title = data.title || "Dashboard";
    document.getElementById("site-title").textContent = data.title || "Dashboard";

    app.innerHTML = "";
    const sections = data.sections || [];
    if (!sections.length) {
      app.innerHTML = `<p style="padding:2rem;color:var(--muted)">${t("app.empty")}</p>`;
      return;
    }
    for (const section of sections) {
      app.appendChild(renderSection(section, _openPdf));
    }
  } catch (e) {
    app.innerHTML =
      '<p style="padding:2rem;color:var(--danger)">Failed to load — is the server running? (<code>npm start</code>)</p>';
  }
}

// Owner-only: lets you view (read-only) past/archived semesters from the dashboard
async function setupSemesterViewer() {
  const sel = document.getElementById("semester-view");
  if (!sel) return;
  try {
    const sems = await (await fetch("/api/semesters")).json();
    if (!sems.semesters || sems.semesters.length <= 1) return; // only show when there's a choice
    sel.innerHTML = "";
    for (const s of sems.semesters) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name + (s.id === sems.active ? "  ●" : "") + (s.archived ? "  🗄" : "");
      if (s.id === sems.active) o.selected = true;
      sel.appendChild(o);
    }
    sel.style.display = "";
    sel.addEventListener("change", () => loadDashboard(sel.value));
  } catch {}
}

// ── Init ──────────────────────────────────────────────────────

(async function init() {
  setupTheme();
  startClock();
  _openPdf = setupModal();

  let isGuest = false;
  try {
    const me = await (await fetch("/auth/me")).json();
    isGuest = me.mode === "guest";
  } catch {}

  if (!isGuest) await setupSemesterViewer();
  await loadDashboard(null);
})();
