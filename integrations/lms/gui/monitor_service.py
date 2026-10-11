#!/usr/bin/env python3
"""
Long-running grade/announcements monitor + materials sync + Telegram control
bot. One process, several responsibilities (simplest correct thing for a
single low-traffic personal bot -- no need for separate services):

1. Periodic grade check: every `interval_minutes` (Telegram-adjustable), if
   enabled, fetches grades via fetch_courses_http and syncs the dashboard.
   Diffs against the last known snapshot (state.json) and sends one
   Telegram message per changed course.

2. Announcements check: same cadence as grades (cheap -- one forum-page
   fetch per course, no file downloads). Notifies on any new discussion.

3. Materials check: much slower cadence (MATERIALS_INTERVAL_MINUTES) since
   it downloads actual files: pointless to re-fetch unchanged course
   material every 30 minutes.

4. Telegram command polling (long-poll getUpdates): /status, /pause,
   /resume, /interval <n>, /check, /help. Only responds to TELEGRAM_CHAT_ID
   -- messages from any other chat are ignored.

All state lives in state.json next to this file, so it survives restarts
and is inspectable/editable by hand if ever needed.
"""
import json
import os
import sys
import time
import traceback
import urllib.request
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fetch_courses_gui import COURSE_IDS  # noqa: E402
from fetch_courses_http import fetch_all_course_grades  # noqa: E402
from fetch_announcements import fetch_all_announcements  # noqa: E402
from fetch_course_materials import fetch_all_course_materials  # noqa: E402
from sync_dashboard import sync_courses  # noqa: E402

STATE_FILE = Path(__file__).parent / "state.json"
TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID = str(os.environ["TELEGRAM_CHAT_ID"])
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"

MATERIALS_INTERVAL_MINUTES = 240  # 4h -- file downloads, not worth 30-min polling

DEFAULT_STATE = {
    "enabled": True,
    "interval_minutes": 30,
    "grades": {},
    "announcement_ids": {},  # {course_code: [discussion_id, ...]}
    "last_check_at": None,
    "last_success_at": None,
    "last_materials_check_at": None,
    "last_error": None,
    "last_error_at": None,
    "telegram_offset": 0,
    "force_check": False,
}


def load_state():
    if STATE_FILE.exists():
        state = {**DEFAULT_STATE, **json.loads(STATE_FILE.read_text())}
    else:
        state = dict(DEFAULT_STATE)
    return state


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def telegram_send(text):
    data = urllib.parse.urlencode({"chat_id": TELEGRAM_CHAT_ID, "text": text}).encode()
    req = urllib.request.Request(f"{TELEGRAM_API}/sendMessage", data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as e:  # noqa: BLE001
        print(f"[telegram] send failed: {e}")


def telegram_get_updates(offset, timeout=25):
    params = urllib.parse.urlencode({"offset": offset, "timeout": timeout})
    req = urllib.request.Request(f"{TELEGRAM_API}/getUpdates?{params}")
    try:
        with urllib.request.urlopen(req, timeout=timeout + 10) as resp:
            return json.loads(resp.read())
    except Exception as e:  # noqa: BLE001
        print(f"[telegram] getUpdates failed: {e}")
        return {"ok": False, "result": []}


def handle_command(state, text):
    text = text.strip()
    if text in ("/status", "status"):
        st = "running" if state["enabled"] else "paused"
        msg = (
            f"Status: {st}\n"
            f"Check interval: {state['interval_minutes']} min\n"
            f"Last check: {state['last_check_at'] or 'never'}\n"
            f"Last success: {state['last_success_at'] or 'never'}\n"
            f"Last materials check: {state['last_materials_check_at'] or 'never'}\n"
            f"Last error: {state['last_error'] or 'none'}"
            + (f" (at {state['last_error_at']})" if state["last_error"] else "")
            + f"\nTracked courses: {len(state['grades'])}"
        )
        telegram_send(msg)
    elif text in ("/pause", "pause"):
        state["enabled"] = False
        save_state(state)
        telegram_send("Paused. Won't check grades until /resume.")
    elif text in ("/resume", "resume"):
        state["enabled"] = True
        save_state(state)
        telegram_send("Resumed.")
    elif text in ("/check", "check"):
        state["force_check"] = True
        save_state(state)
        telegram_send("Will check on the next cycle (within a few seconds).")
    elif text.startswith("/interval"):
        parts = text.split()
        if len(parts) == 2 and parts[1].isdigit() and int(parts[1]) >= 5:
            state["interval_minutes"] = int(parts[1])
            save_state(state)
            telegram_send(f"Interval set to {parts[1]} minutes.")
        else:
            telegram_send("Usage: /interval <minutes, minimum 5>")
    elif text in ("/help", "help", "/start"):
        telegram_send(
            "Commands:\n"
            "/status - show current state\n"
            "/pause - stop checking\n"
            "/resume - resume checking\n"
            "/interval <n> - set check interval in minutes\n"
            "/check - force a check right now"
        )
    else:
        telegram_send("Unknown command. /help for the list.")


def poll_telegram_once(state):
    result = telegram_get_updates(state["telegram_offset"], timeout=1)
    if not result.get("ok"):
        return
    for update in result.get("result", []):
        state["telegram_offset"] = update["update_id"] + 1
        msg = update.get("message") or {}
        chat_id = str(msg.get("chat", {}).get("id", ""))
        text = msg.get("text", "")
        if chat_id != TELEGRAM_CHAT_ID:
            print(f"[telegram] ignoring message from unauthorized chat {chat_id}")
            continue
        if text:
            handle_command(state, text)
    save_state(state)


def _grade_rows_diff(old_rows, new_rows):
    """old_rows/new_rows: lists of {item, grade, range, percentage, ...}.
    Returns human-readable lines for any item whose grade actually changed."""
    old_by_item = {r["item"]: r for r in (old_rows or [])}
    lines = []
    for row in new_rows:
        old = old_by_item.get(row["item"])
        if old is None:
            lines.append(f"  {row['item']}: (new) -> {row['grade']}")
        elif old.get("grade") != row.get("grade"):
            lines.append(f"  {row['item']}: {old.get('grade')} -> {row['grade']}")
    return lines


def run_announcements_check(state):
    codes = {name.split(" : ")[0]: cid for name, cid in COURSE_IDS.items()}
    new_by_course = fetch_all_announcements(codes)
    old_ids = state["announcement_ids"]

    changes = []
    updated_ids = {}
    for code, discussions in new_by_course.items():
        seen = set(old_ids.get(code, []))
        new_ones = [d for d in discussions if d["id"] not in seen]
        if new_ones and seen:  # don't spam on the very first run ever
            for d in new_ones:
                changes.append(f"{code}: {d['subject']}\n  {d['url']}")
        updated_ids[code] = [d["id"] for d in discussions]

    state["announcement_ids"] = updated_ids
    if changes:
        telegram_send("New announcement(s):\n\n" + "\n\n".join(changes))
    else:
        print("[monitor] no new announcements")


def run_materials_check(state):
    codes = {name.split(" : ")[0]: cid for name, cid in COURSE_IDS.items()}
    counts = fetch_all_course_materials(codes)
    total = sum(counts.values())
    print(f"[monitor] materials: {total} file(s) across {len(counts)} course(s)")
    state["last_materials_check_at"] = time.strftime("%Y-%m-%d %H:%M:%S")


def run_grade_check(state):
    print("[monitor] running grade check")
    new_grades = fetch_all_course_grades()
    old_grades = state["grades"]

    changes = []
    for course, rows in new_grades.items():
        diff_lines = _grade_rows_diff(old_grades.get(course), rows)
        if diff_lines:
            changes.append(course + "\n" + "\n".join(diff_lines))

    if changes:
        telegram_send("Grade change detected:\n\n" + "\n\n".join(changes))
    else:
        print("[monitor] no grade changes")

    # Push to the dashboard whenever the LMS-derived section differs from
    # what's actually there -- this covers real grade changes AND self-heals
    # if someone manually edited/deleted course cards on the dashboard, not
    # just when our own local grade snapshot changed.
    sync_courses(new_grades)
    state["grades"] = new_grades

    print("[monitor] running announcements check")
    run_announcements_check(state)

    materials_due = state["last_materials_check_at"] is None or (
        time.time() - time.mktime(time.strptime(state["last_materials_check_at"], "%Y-%m-%d %H:%M:%S"))
        >= MATERIALS_INTERVAL_MINUTES * 60
    )
    if materials_due:
        print("[monitor] running materials check")
        try:
            run_materials_check(state)
        except Exception as e:  # noqa: BLE001
            # Materials are a nice-to-have on top of grades -- a failure
            # here shouldn't mark the whole cycle as failed.
            traceback.print_exc()
            telegram_send(f"Materials check failed (grades/announcements still OK): {e}")

    state["last_success_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    state["last_error"] = None


def main():
    state = load_state()
    save_state(state)
    telegram_send("Grade monitor service started.")
    last_check_ts = 0.0

    while True:
        try:
            poll_telegram_once(state)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

        due = (time.time() - last_check_ts) >= state["interval_minutes"] * 60
        if state["enabled"] and (due or state["force_check"]):
            state["force_check"] = False
            state["last_check_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            try:
                run_grade_check(state)
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                state["last_error"] = str(e)
                state["last_error_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                telegram_send(f"Grade check failed: {e}")
            last_check_ts = time.time()
            save_state(state)

        time.sleep(5)


if __name__ == "__main__":
    main()
