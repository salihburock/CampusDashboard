# LMS/SIS automation — session notes (2026-09-17)

## Update: 2026-09-22/23 — login fix, materials + announcements built (not yet live)

**Context:** picked this back up after a 5-day gap. Found `lms-grade-monitor` had
been silently paused (`/pause`, presumably by you after hitting the error below) since
2026-09-22 14:41 — Microsoft started showing a new screen ("Your organizational
policy requires you to sign in again after a certain time period...") that
`do_login()` in `fetch_courses_gui.py` didn't recognize, crashing the login. Root
cause: this is a periodic re-verification prompt Microsoft shows independent of
the Moodle session cookie's own expiry, functionally identical to the other
"click through to password" branches already handled -- `do_login()` now
recognizes it (`contains_any("sign in again after a certain time period")`) and
handles it the same way, including a real layout difference (the extra policy
text shifts the password field ~36px down) which was the same bug in miniature.
**Fixed and deployed to ns, but not yet re-verified against a real login** --
see "Currently blocked" below.

**New this session** (in `integrations/lms/gui/`, synced to ns but only
`fetch_course_materials.py`/`fetch_announcements.py` as standalone modules --
`monitor_service.py`'s new version wiring them in is staged locally, **not yet
deployed/restarted on ns**):

- `fetch_course_materials.py` -- downloads course files via the same
  cookie+`requests`+BeautifulSoup approach as `fetch_courses_http.py` (not a
  browser), into `materials/<course_code>/<section name>/`, matching your ask
  for "a separate folder for each course". Selectors are Moodle's standard Boost
  classes (`.activity.resource a`, `.activity.folder a`, etc. -- same ones
  `ozu-lms-extension`'s `OZU_SELECTORS` already uses for its own download
  button, so these are proven-correct patterns, not guesses). Handles folders by
  following into the folder-view page and pulling its `pluginfile.php` links.
  **Not yet run against a live session** -- structurally sound but unverified.
- `fetch_announcements.py` -- finds each course's auto-created "Announcements"
  forum (link text matching "announce"/"duyuru") and parses its discussion list.
  **Written blind, without a live session to confirm the actual HTML** (mid
  MFA-cooldown when this was built) -- has a diagnostic fallback that dumps a
  snippet of unexpected HTML instead of silently returning zero results, to make
  first-run debugging fast. Treat the discussion-list parsing specifically as
  unverified until a real run confirms it.
- `monitor_service.py` (staged, not deployed) -- adds an announcements check at
  the same 30-min cadence as grades (cheap, no downloads) and a materials check
  on a much slower 4-hour cadence (`MATERIALS_INTERVAL_MINUTES`, since it's
  actual file downloads -- no point re-fetching unchanged files every 30 min). A
  materials-check failure doesn't fail the whole cycle (grades/announcements
  still get reported); a Telegram message distinguishes it from a real failure.
- `server.js` -- the old `/docs/:filename` route couldn't serve nested paths
  (Express's `:param` doesn't match `/`), which would have blocked per-course
  material subfolders from ever being reachable by the dashboard UI. Replaced
  with a wildcard `/docs/*` route that resolves and validates the path stays
  inside `DOCS_DIR` (path-traversal guard) before serving. **Deployed to the
  Legion and the server restarted** (via `ns`'s frp tunnel -- this machine's own
  LAN access to the Legion was down at the time, unrelated network hiccup, not
  a Legion problem). Verified the dashboard still responds (`HTTP 302` on
  the public URL) after the restart.

**Currently blocked / next steps:**
- The account hit Microsoft's risk-based sign-in throttle again while I was
  testing the reverify-screen fix live (multiple login attempts in quick
  succession -- same pattern documented in the historical §"Verify your
  identity" notes below). `lms-grade-monitor` is still paused. **Before
  resuming**: wait a while (last time this needed roughly 15-30+ min of
  quiet), then either send `/resume` via Telegram or run
  `python3 -c "from fetch_courses_gui import ensure_logged_in; ensure_logged_in()"`
  by hand on ns to confirm a clean login works before trusting the automated loop
  with it again.
- Once login is confirmed clean: run `fetch_course_materials.py` and
  `fetch_announcements.py` standalone (each has a `__main__` block) to verify
  their selectors against real data before deploying the new
  `monitor_service.py` over the live one on ns and restarting the service --
  don't skip this, both are unverified as noted above.
- `fetch_sis_syllabi.py` (the old clipboard-text description scraper) is now
  dead code, fully superseded by `fetch_sis_pdfs.cjs`'s real PDF attachments.
  Left in place for reference rather than deleted; safe to remove once you've
  confirmed you don't want it.

## Update: 2026-09-18 — HTTP course sync and SIS PDFs deployed

The implementation below supersedes the older GUI-only fetching and legacy
`data.json` sync described in the historical notes.

- `fetch_courses_http.py` discovers the current Fall courses from Moodle's live
  grade overview and parses grade tables using requests + BeautifulSoup. All ten
  courses were fetched successfully. Firefox is only needed when the exported
  cookie expires; renewal uses the existing login and cookie-export extension.
- The dashboard had migrated to semester files. Writing legacy `data.json` did
  not affect the live Fall dashboard. `sync_dashboard.py` now resolves the named,
  non-archived `2026-2027 Fall` semester from `semesters.json`; it does not follow
  an arbitrary active semester into another term.
- Existing cards are matched by exact section code or an unsectioned course code.
  Grades and syllabus links update while names, notes, homework and resources
  remain intact. Matched cards are consolidated into the managed Courses section,
  and their emptied former course sections are removed. Unrelated cards stay in
  their existing sections; private source sections make the destination private.
  Missing cards are restored in the managed Courses section.
  Writes compare against the original snapshot, create a timestamped backup,
  and replace the semester file atomically.
- `fetch_sis_pdfs.cjs` uses a separate headed Playwright Chromium browser on
  DISPLAY=:99. This worked on ns despite the earlier headless Forbidden result.
  It searches the public catalog by named input fields, verifies the term and
  exact section, and resolves detached SmartClient PDF controls against the
  matching row's current bounds. No fixed screen coordinates are used.
- SIS PDF popup URLs are fetched inside that browser session and checked for
  the PDF signature. Eight real syllabus PDFs were verified by extracted title
  and Fall 2026-27 term, then uploaded to Legion's user docs directory. Moodle's
  combined `ME 412-512.A` uses SIS's undergraduate `ME 412.A` syllabus.
- SIS publishes no separate PDF action for `EE 301L.A` or `EE 341L.C`; these
  courses are present without an attachment. The user confirmed labs should not
  have PDFs, so both are explicitly excluded from PDF fetching and retries.
  Successful PDFs are cached in `syllabi/manifest.json`; remove a cache
  entry to request another download. Cached PDFs are uploaded again if the
  corresponding dashboard file is missing. Different existing files are never
  silently overwritten.
- The live `lms-grade-monitor` now calls this complete sync every 30 minutes.
  Its first run succeeded with ten courses and eight PDFs. Four regression tests
  cover field preservation, repeat merges, deleted-section restoration and grade
  parsing/failure handling (`python3 -m unittest discover -s integrations/lms/gui
  -p test_sync.py`). Python dependencies are in `requirements.txt`; Playwright
  remains installed in `sis-node/node_modules` on ns.

Semester rollover still requires updating the term constants in the HTTP fetcher,
SIS fetcher and sync script together. Existing historical sections below are kept
as background, not as a description of the current deployed pipeline.

Everything below runs on **ns** (`salihaydogdu.com.tr` / `45.133.36.124`), the same VPS
as the MFA relay. All code lives in `~/gits/CampusDashboard-lms-gui/` on that box; the
copies in this repo directory (`integrations/lms/gui/`) are the source of truth I edit
and `scp` over.

## The big picture

You wanted: your LMS grades visible on the dashboard, auto-updating, with Telegram
notifications and control. That's built and running. Along the way we also fixed a
dashboard reliability gap you asked about (auto-restoring manually-deleted course
cards), got about 90% of the way to SIS syllabus fetching (works manually, scripted
version needs one more pass — see §6), and validated a cookie-extraction approach
that could make the whole thing faster/more reliable (proven working tonight, not
yet wired into the live pipeline — see §7).

## 1. How login works (no more MFA relay pain, most of the time)

**The problem:** Playwright-driven Chromium got silently blocked by Microsoft's
sign-in risk detection (pushes never arrived, or arrived and got dropped). Real,
normally-launched Firefox does **not** get blocked — because it isn't using
Chrome DevTools Protocol at all, so there's no automation fingerprint. So the whole
LMS/SIS setup drives a real Firefox window via `xdotool` (synthetic X11 keyboard/mouse
events) inside a virtual display (`Xvfb`), not via Playwright/Selenium.

**Session reuse is the important part:** Firefox's cookies persist in a real profile
directory (`~/gits/CampusDashboard-lms-gui/profile/`), so once logged in, most runs
skip the login dance entirely — they just navigate straight to the target URL and it
works because the cookie's still valid. Full login (email → password → MFA
number-match, approved via the relay) only happens when the session has actually
expired. We also click "Yes" on "Stay signed in?" to make Microsoft's own login
cookie last as long as possible, so even a Firefox *restart* (which loses Moodle's
own session-only cookie) often only needs a one-click "pick this account" step
instead of a full re-login.

**Important account quirk:** this account defaults to *passwordless* Authenticator
sign-in, but **the MFA relay doesn't support that flow** — you confirmed this
directly. The login code always forces the "Use my password" path instead, so the
relay only ever sees the standard number-match approval it knows how to handle.

Main file: `fetch_courses_gui.py`. Key functions: `session_is_valid()`,
`do_login()`, `ensure_logged_in()`.

## 2. Grade fetching — uses your friend's extension, not scraping

Early on I built a fragile clipboard-text parser (select-all the page, regex the
grade table out of plain text). It technically worked but was brittle. Then you
pointed me at `~/gits/Contributions/ozu-lms-extension` — a browser extension you
had that already does a clean **authenticated `fetch()`** against Moodle's real
grade-report HTML and parses proper DOM tables. Far more reliable, so I switched to
that entirely.

What I did to it (our own copy, at
`~/gits/CampusDashboard-lms-gui/ozu-extension/`, **not** touching your original):
- Found and fixed a real bug: its CSV header didn't match the columns it actually
  captured (missing a "Weight" column, so every value after Grade was shifted over
  by one — "Feedback" was actually holding the Percentage value).
- Added a `?autoexport=1` URL flag so the export triggers automatically on page
  load — no button-click-position-finding needed (the button's position shifts
  depending on how long the course title is and whether it wraps).

The extension is loaded as a Firefox "temporary add-on" (`ensure_extension_loaded()`
in `fetch_courses_gui.py`) — this only lasts for the life of the Firefox *process*,
so it's re-loaded automatically whenever Firefox restarts. No manual step needed.

Grade fetching now: navigate to `course/view.php?id=X&autoexport=1` for each of your
10 known course IDs (hardcoded in `COURSE_IDS` — Moodle IDs are stable for a course
instance, re-collect if a new semester's IDs are needed), wait for the CSV to land in
`~/Downloads/`, parse it, delete it.

## 3. The monitor service — runs every 30 min, Telegram-controlled

`monitor_service.py`, running as systemd service `lms-grade-monitor.service`. One
process does two things in a loop:
- **Grade checks** every `interval_minutes` (currently 30, your ask — "nothing to
  grade for a month at a time" doesn't need faster than that, and it's gentler on
  the relay/emulator).
- **Telegram command polling** (long-poll `getUpdates`), so it can respond to you
  in near-real-time even between grade-check cycles.

Telegram bot commands: `/status`, `/pause`, `/resume`, `/interval <minutes>`,
`/check` (force one right now), `/help`. Only responds to your chat ID — everyone
else is ignored.

On any actual grade change, it sends you a Telegram message *and* pushes the update
to the dashboard. It also tells you if a full re-login (MFA) was needed, and alerts
on errors instead of failing silently.

State (enabled flag, interval, last-known grades per course, last check/success/error
timestamps) lives in `~/gits/CampusDashboard-lms-gui/state.json` — plain JSON, safe
to read or hand-edit if something looks off.

## 4. Dashboard sync — self-healing, backed up every write

`sync_dashboard.py` builds a `"Courses (Fall 2026/27)"` section (code, name, and a
`grades` list per course) and writes it into
`userdata/salih/data.json` **on the Legion** (your laptop server — reached from ns
via `ssh -p 6220 salih@127.0.0.1`, which loops through ns's own frp tunnel back to
your home network). Every write is preceded by a timestamped backup
(`data.json.bak-<timestamp>`, left in place, never auto-deleted) and only ever
touches that one section — your other 7 sections (old Spring courses, Exams,
Syllabus, Quick Links, Notes, your "courses to consider" planning notes, PDFs) are
never touched.

**You asked:** "if I remove each course saved, how would I make it automatically add
them back?" — Fixed. Originally the dashboard only got updated when a grade
*changed*, so a manual deletion would just sit there until the next real grade
change. Now every cycle compares the section as it actually exists on the Legion
against what LMS currently says, and restores it if they differ for *any* reason —
manual edit, manual deletion, or a real grade change all get caught and fixed within
one 30-minute cycle. You'll get a distinct Telegram message depending on which case
it was ("section missing, restored" vs. "didn't match, restored" vs. the normal
grade-change notification).

I also added a "Grades" section to the actual dashboard UI
(`app.js`/`i18n.js`, deployed to the Legion) so this data has somewhere to render —
below the course header, above Homework.

**Tested and confirmed working**: manually deleted the whole section from the
Legion's `data.json`, restarted the monitor, watched it come back with all 10
courses automatically.

## 5. Infrastructure — what's running where, systemd units

All on `ns`:
- `lms-gui-browser.service` — `Xvfb` (virtual display `:99`) + `fluxbox` (minimal
  window manager) + Firefox, wrapped in `start_browser.sh`. Survives reboots.
  ⚠️ `MOZ_DISABLE_CONTENT_SANDBOX=1` is set — Firefox's content-process sandbox
  wasn't initializing correctly on this box (unrelated to anything project-specific,
  just this VPS/kernel combo) and crashed every real page load without it. Acceptable
  here since this Firefox only ever visits LMS/SIS, nothing untrusted.
- `lms-grade-monitor.service` — the Python monitor loop described above. Depends on
  the browser service and the MFA relay.
- (already existed) `mfa-relay.service` / `mfa-relay-avd.service` — the Android
  emulator + relay server this all leans on for MFA approval.

One infra thing worth knowing about: **the Android emulator backing the MFA relay
was flaky for a chunk of this session** (ADB timeouts, a `screencap` failure) —
turned out to be a resource-pressure side effect of me piling up multiple stray
Firefox processes while debugging (fixed, cleaned up), not a fundamental problem.
Worth keeping an eye on if MFA approvals start silently failing again — check
`sudo journalctl -u mfa-relay -n 50` for `ADB timeout` spam as the tell.

Credentials/config: `~/gits/CampusDashboard-lms-gui/.env` (bash-sourced, for manual
runs) and `.env.systemd` (plain `KEY=value`, for the systemd units — systemd doesn't
understand `export` or quotes). Both gitignored, never committed.

## 6. SIS syllabus fetching — proven manually, scripted version not reliable yet

You confirmed: `sis.ozyegin.edu.tr`'s course catalog (`CourseCatalogOfferUI`) is
**public — no login needed** for course search/descriptions (verified against an
existing scraper of yours, `~/python/scrape/sis/monitor.js`, which already runs
fully unauthenticated). Login *will* be needed for exam schedules later, which is a
separate, not-yet-started piece of work.

I manually drove the real flow end-to-end (screenshots at every step) and it
works cleanly:
1. `Ders Arama` → `Detaylı Arama` (detailed search)
2. Fill `Ders Seviyesi` = Lisans, `Dönem Kodu` = 2026-2027 Güz, `Konu` = subject code
   (e.g. "CS" — one search returns **every** course in that subject, so we only need
   ~4 searches total for your 10 courses' subjects, not 10)
3. Click `Arama` (search), then `Açıklamaları Göster` (show descriptions)
4. The full course description (syllabus text), instructor, prerequisites, and
   schedule are all right there in the page, cleanly extractable

I wrote `fetch_sis_syllabi.py` to script this — but the scripted version is
**currently flaky**: it uses fixed-coordinate clicks + fixed `sleep()` delays for
each of the ~5 UI steps (search, three autocomplete dropdowns, description toggle),
with no verification that each step actually completed before moving to the next.
Same code gave 30 correctly-parsed courses on one run and 0 on the next. The LMS
login script had this exact problem originally and I fixed it there by waiting for
and checking specific page text after each step before proceeding (see
`wait_for_state()` in `fetch_courses_gui.py`) — `fetch_sis_syllabi.py` needs the same
treatment before it's trustworthy enough to run unattended. **Not wired into the
monitor loop yet** — syllabus text doesn't change often, so this doesn't need to run
every 30 minutes anyway; once reliable it should be a much slower/manual cadence.

## Where things are, if you want to poke around yourself

- `ssh ns` → `~/gits/CampusDashboard-lms-gui/` — all the scripts, `.env*`,
  Firefox profile, the extension copy, `state.json`
- `journalctl -u lms-grade-monitor -f` / `journalctl -u lms-gui-browser -f` — live
  logs
- Telegram: message the bot directly, `/status` is the fastest sanity check
- Legion: `userdata/salih/data.json` — the live dashboard data; `.bak-*` siblings are
  every backup this session made
- This repo (`integrations/lms/gui/`): the source-of-truth copies of every script
  above, plus `debug/` (gitignored) full of screenshots from today's debugging —
  safe to delete, kept in case any of the click-coordinate logic needs re-deriving

## 7. Cookie extraction — validated, not yet wired in (your idea, tonight)

You asked: could we click through login via GUI once, then grab the cookies and drop
the GUI entirely for everything after — since LMS is "just URL fetching with
cookies" once authenticated? Tested this end to end tonight and **it works**:

- First tried reading `MoodleSession` straight out of Firefox's `cookies.sqlite`
  (even copying the `-wal` file alongside it, in case of a checkpoint delay). Never
  found it, and now I know why: `MoodleSession` is a true session cookie (no
  `Expires`/`Max-Age`). Those live only in Firefox's memory and are never written to
  the on-disk database at all — no amount of WAL-copying trickery gets around that,
  it's just not there to read.
- The fix: our own already-loaded extension can reach it. `browser.cookies.getAll()`
  is privileged and sees HttpOnly session cookies fine (unlike `document.cookie`,
  which can't see HttpOnly cookies at all) — but it only works from the extension's
  **background** context, not the content script, which took one failed round to
  discover (`browser.cookies is undefined` in the content script console). Added
  `background.js`, content script now messages it via `browser.runtime.sendMessage`.
  Triggered via a `?exportcookies=1` URL flag, same pattern as the grade CSV export.
- Extracted `MoodleSession`, then — separately, no browser involved at all — ran a
  plain Python `requests.get()` against the grade overview URL with just that one
  cookie. **200 OK, real authenticated HTML**, with direct links to every course's
  grade report (`course/user.php?mode=grade&id=X&user=20278` — the exact URL pattern
  I'd tried and abandoned earlier tonight before switching to the extension's CSV
  approach).

**What this means, if we wire it in:** login (email → password → MFA) still needs
the real GUI — that part's unavoidable, it's what gets past Microsoft's bot
detection. But once logged in, extracting the cookie once and switching to plain
`requests` + real HTML parsing (BeautifulSoup, not clipboard-text scraping) for
every subsequent fetch would be faster (a network request vs. several seconds of
page-load waits) and more reliable (no coordinate clicks, no clipboard timing races)
than driving Firefox via `xdotool` for the read side of things. Grade fetching in
particular could probably ditch the extension-CSV approach entirely and just parse
the real `<table>` from the HTML `requests` already gets us.

**Deliberately not doing this refactor tonight** — it's a real architecture change
(need to handle the cookie/session expiring, decide the re-extraction cadence, retest
the whole grade → dashboard pipeline against it) and the currently-running pipeline
works. Extension changes (`background.js`, the `exportcookies` hook,
`manifest.json`'s new `cookies` permission) are already pushed to
`~/gits/CampusDashboard-lms-gui/ozu-extension/` on ns and proven working — next
session can pick this straight up without re-deriving anything.

SIS is a separate question — its search UI is GWT/SmartClient (not plain forms),
so even with a cookie, "just URL fetching" won't work the same way; that app expects
its own RPC calls, not simple GETs. The syllabus catalog search doesn't need a
cookie at all though (it's public), so that part of SIS was never blocked by this.

I also looked at `~/gits/CourseSched/src/main/java/org/example/CourseDownloader.java`,
which you pointed me at — it downloads SIS's course-list Excel export via Selenium +
real Chrome (confirms Selenium/real-Chrome isn't blocked by SIS's WAF either, same as
real Firefox). Two things worth reusing from it when `fetch_sis_syllabi.py` gets its
hardening pass: it selects UI elements by structural attributes (`By.name(...)`,
relative XPath) rather than pixel coordinates, which is exactly the fix that script
needs; and its download trick (page-side `fetch(url, {credentials:'include'})` →
base64 → hand back to the driver, rather than trusting the browser's own download
manager) is a solid pattern if we ever need the syllabus PDF a course's
`pdf_with_attachments.png` icon links to, rather than just the catalog's description
text (which is what's implemented now, and may already be enough — worth checking in
the morning whether the description text is sufficient or you actually want the PDF
file itself).

## Honest gaps / things to watch

- Click coordinates throughout (`fetch_courses_gui.py`, `fetch_sis_syllabi.py`) were
  measured against this exact window/profile/OS-chrome setup. If Firefox's UI
  changes (update, different window size, different WM), some of these will need
  re-measuring. There's a comment at the top of `fetch_courses_gui.py` flagging this.
- `fetch_sis_syllabi.py` needs the wait-and-verify hardening pass described above
  before it's reliable enough to trust unattended.
- Exam-date fetching from SIS: not started, will need login (the syllabus/catalog
  path is public, exams presumably aren't).
- If the whole browser/monitor stack ever needs a clean restart: stop
  `lms-grade-monitor` **before** restarting `lms-gui-browser` (I hit one race
  earlier where restarting while a check was mid-flight left two processes briefly
  driving the same Firefox window — harmless, self-recovered next cycle, but avoid
  restarting both at once if you can help it).
