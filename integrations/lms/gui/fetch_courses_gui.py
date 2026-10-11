#!/usr/bin/env python3
"""
Logs into lms.ozyegin.edu.tr via Microsoft SSO using a real, normally-launched
Firefox driven entirely through synthetic X11 input (xdotool) inside a
virtual display (Xvfb) -- no CDP/WebDriver protocol involved, so Firefox has
no automation fingerprint at all.

Session reuse: this script always drives the SAME persistent Firefox profile
(PROFILE_DIR below), so cookies survive between runs. Each run tries the
target URL directly first; if Moodle serves the page straight away, the
session's still valid and no login is needed at all. Only a redirect to
login.microsoftonline.com triggers the full interactive login (email ->
"Use my password" -> password -> MFA number-match approved via the relay).
On "Stay signed in?" we click Yes, to get Microsoft's longest-lived session
cookie and push out future logins as far as possible.

IMPORTANT: this account does NOT support passwordless/no-password sign-in
through the MFA relay -- always go through "Use my password", never accept
a bare Authenticator push offered before a password prompt.

State is read via clipboard (Ctrl+A, Ctrl+C, xclip), not screenshots:
Firefox's compositor does not repaint reliably in this Xvfb setup (confirmed
via clipboard cross-checks -- screenshots can stay frozen on a stale frame
indefinitely even as the page genuinely moves through several states). Only
take screenshots for interactive/manual debugging; never gate script logic
on one.

Click coordinates below were measured empirically against this exact
profile/window/OS-chrome combination (1280x800 Xvfb screen, fluxbox window
manager, Firefox maximized) and will need re-measuring if that setup
changes (see debug/burst_*.png from the session that derived them, if still
present).

Run this on the host that also runs the MFA relay -- it calls the relay over
localhost, sidestepping the relay's IP allowlist entirely.
"""
import csv
import glob
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

DISPLAY = os.environ.get("LMS_GUI_DISPLAY", ":99")
ENV = {**os.environ, "DISPLAY": DISPLAY}

LMS_USERNAME = os.environ["LMS_USERNAME"]
LMS_PASSWORD = os.environ["LMS_PASSWORD"]
MFA_RELAY_URL = os.environ.get("MFA_RELAY_URL", "http://127.0.0.1:8030").rstrip("/")
MFA_RELAY_TOKEN = os.environ["MFA_RELAY_TOKEN"]

LOGIN_URL = "https://lms.ozyegin.edu.tr/login/index.php"
COURSES_URL = "https://lms.ozyegin.edu.tr/my/courses.php"
GRADE_OVERVIEW_URL = "https://lms.ozyegin.edu.tr/grade/report/overview/index.php"

# Moodle course-instance IDs for Fall 2026/27, collected once by clicking
# through grade/report/overview/index.php (course IDs are stable for the
# life of the course instance). Re-collect if a semester rolls over.
COURSE_IDS = {
    "CS 321.A : Programming Paradigms (Fall 2026/27)": 1693,
    "CS 350.A : Operating Systems (Fall 2026/27)": 2244,
    "EE 301.A : Electronics I (Fall 2026/27)": 2126,
    "EE 301L.A : Electronic 1 - Lab. (Fall 2026/27)": 1656,
    "EE 311.A : Introduction to Artificial Intelligence, Machine Learning, and Data Science (Fall 2026/27)": 3152,
    "EE 341.A : Fundamentals of Communication Systems (Fall 2026/27)": 2821,
    "EE 341L.C : Fundamentals of Communication Systems - Lab. (Fall 2026/27)": 3019,
    "EE 401.A : Electrical and Electronics Engineering Senior Project I (Fall 2026/27)": 2450,
    "FE 301.A : Being an Engineer (Fall 2026/27)": 2784,
    "ME 412-512.A : Finite Element Analysis and Engineering Applications (Fall 2026/27 Meta Courses)": 3232,
}


def xdotool(*args):
    subprocess.run(["xdotool", *args], env=ENV, check=False)


def click(x, y, settle=0.5):
    xdotool("mousemove", str(x), str(y))
    xdotool("click", "1")
    time.sleep(settle)


def key(k, settle=0.4):
    xdotool("key", k)
    time.sleep(settle)


def type_text(text, settle=0.4):
    xdotool("type", "--clearmodifiers", text)
    time.sleep(settle)


def goto(url, settle=3):
    key("ctrl+l", settle=0.3)
    type_text(url, settle=0.3)
    key("Return", settle=settle)


def read_page_text(click_blank_first=True):
    """Click a blank area (restores in-page keyboard/selection focus, which
    Tab/chrome interactions can knock out) then select-all + copy."""
    if click_blank_first:
        click(640, 700, settle=0.2)
    xdotool("key", "ctrl+a")
    time.sleep(0.3)
    xdotool("key", "ctrl+c")
    time.sleep(0.4)
    out = subprocess.run(
        ["xclip", "-selection", "clipboard", "-o"],
        env=ENV,
        capture_output=True,
        text=True,
    )
    return out.stdout


def wait_for_state(matchers, timeout=30, interval=1.5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = read_page_text()
        for label, pred in matchers.items():
            if pred(text):
                return label, text
        time.sleep(interval)
    return None, read_page_text()


def contains_any(*needles):
    def pred(text):
        low = text.lower()
        return any(n.lower() in low for n in needles)
    return pred


def current_url():
    xdotool("key", "F6")  # focus address bar
    time.sleep(0.3)
    xdotool("key", "ctrl+c")
    time.sleep(0.3)
    xdotool("key", "Escape")
    time.sleep(0.2)
    out = subprocess.run(
        ["xclip", "-selection", "clipboard", "-o"], env=ENV, capture_output=True, text=True
    )
    return out.stdout.strip()


def dismiss_firefox_welcome_if_present():
    text = read_page_text(click_blank_first=False)
    if "welcome to firefox" in text.lower():
        print("[step] dismissing Firefox welcome dialog")
        click(576, 326)


def dismiss_notification_bars():
    # After a fresh Firefox process start (e.g. systemd restarted the
    # browser service), an "Open previous tabs?" info bar can appear above
    # Microsoft's dialog and shift all its content down ~40px, throwing off
    # coordinates measured without it. Dismiss it so layout stays consistent.
    text = read_page_text(click_blank_first=False)
    if "open previous tabs" in text.lower():
        print("[step] dismissing 'Open previous tabs?' bar")
        click(1255, 182)


def session_is_valid():
    """Try the courses URL directly. If it lands on lms.ozyegin.edu.tr
    without ever hitting Microsoft, the existing session cookie is enough."""
    goto(COURSES_URL, settle=4)
    dismiss_firefox_welcome_if_present()
    url = current_url()
    print(f"[step] direct-nav landed on: {url}")
    return "lms.ozyegin.edu.tr" in url and "login.microsoftonline.com" not in url


def do_login():
    print("[step] session expired/absent -- doing full interactive login")
    goto(LOGIN_URL, settle=4)
    dismiss_firefox_welcome_if_present()
    dismiss_notification_bars()

    label, text = wait_for_state(
        {
            "email_entry": contains_any("Email, phone, or Skype"),
            "pick_account": contains_any("Pick an account"),
            "reverify": contains_any("sign in again after a certain time period"),
        },
        timeout=15,
    )
    print(f"[step] initial state: {label}")

    if label == "pick_account":
        # Microsoft remembered the account (its own persistent cookie
        # survived even though Moodle's session cookie didn't) -- click the
        # remembered entry instead of typing the email again.
        click(650, 469, settle=3)
    elif label == "reverify":
        # Periodic re-verification prompt ("Your organizational policy
        # requires you to sign in again..."), seen after the account's own
        # trust/session has been idle a while. Its only path we support is
        # the same "Use your password instead" link as the other branches.
        click(555, 520, settle=2)
    elif label == "email_entry":
        print("[step] typing email")
        click(640, 390)
        type_text(LMS_USERNAME, settle=0.3)
        click(761, 523, settle=3)
    else:
        raise RuntimeError(f"Unexpected initial state: {label}\n{text[:500]}")

    dismiss_notification_bars()
    label, text = wait_for_state(
        {
            "password": contains_any("Enter password", "Forgot my password"),
            "chooser": contains_any("Choose a way to sign in"),
            "mfa_direct": contains_any("Approve sign in"),
        },
        timeout=25,
    )
    print(f"[step] state after account selection: {label}")

    if label == "chooser":
        # This account's MFA relay setup does NOT support the passwordless
        # push flow -- always take "Use my password", never the
        # Authenticator tile offered here.
        click(591, 401, settle=2)
        label, text = wait_for_state(
            {"password": contains_any("Enter password", "Forgot my password")},
            timeout=20,
        )
        print(f"[step] state after chooser->password: {label}")
    elif label == "mfa_direct":
        # A remembered account can jump straight to offering a passwordless
        # push with no chooser at all -- back out via the password link
        # that's also present on this screen.
        click(555, 604, settle=2)
        label, text = wait_for_state(
            {"password": contains_any("Enter password", "Forgot my password")},
            timeout=20,
        )
        print(f"[step] state after mfa_direct->password: {label}")

    if label != "password":
        raise RuntimeError(f"Expected password prompt, got: {label}\n{text[:500]}")

    # The extra "Your organizational policy requires..." line (present when
    # this screen was reached via the "reverify" branch above) pushes the
    # password field and Sign in button down ~36px from their usual position.
    shifted = "organizational policy" in text.lower()
    print(f"[step] typing password (shifted layout: {shifted})")
    click(640, 403 if shifted else 367)
    type_text(LMS_PASSWORD, settle=0.3)
    click(761, 525 if shifted else 491, settle=3)

    # Firefox's own "Save password?" doorhanger may appear; dismiss if so.
    text = read_page_text()
    if "save password" in text.lower() or "microsoftonline.com?" in text.lower():
        click(502, 291, settle=1)

    label, text = wait_for_state(
        {"mfa": contains_any("Approve sign in", "Open your Authenticator app")},
        timeout=20,
    )
    print(f"[step] state after password: {label}")
    if label != "mfa":
        raise RuntimeError(f"Expected MFA prompt, got: {label}\n{text[:500]}")

    handle_mfa(text)

    # "Stay signed in?" -- click Yes, to maximize session cookie lifetime
    # and avoid full MFA logins on most future runs.
    text = read_page_text()
    if contains_any("Stay signed in")(text):
        print("[step] 'Stay signed in?' -> Yes")
        click(761, 481, settle=3)

    label, _ = wait_for_state(
        {"lms": lambda t: True},
        timeout=10,
        interval=3,
    )


def handle_mfa(text):
    number = None
    for line in text.splitlines():
        m = re.fullmatch(r"\s*(\d{2})\s*", line)
        if m:
            number = int(m.group(1))
            break
    if number is None:
        raise RuntimeError(f"Could not find MFA number in page text:\n{text[:500]}")
    print(f"[step] MFA number: {number}, approving via relay...")

    req = urllib.request.Request(
        f"{MFA_RELAY_URL}/approve",
        data=json.dumps({"number": number}).encode(),
        headers={"Content-Type": "application/json", "X-MFA-Token": MFA_RELAY_TOKEN},
        method="POST",
    )
    last_err = None
    for attempt in range(1, 11):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
            if data.get("approved") is True:
                print(f"[step] relay approved: {data}")
                last_err = None
                break
            last_err = RuntimeError(f"relay response: {data}")
        except Exception as e:  # noqa: BLE001
            last_err = e
        print(f"[step] approve attempt {attempt}/10 failed: {last_err}, retrying...")
        time.sleep(2)
    if last_err:
        raise last_err

    label, _ = wait_for_state(
        {"done": lambda t: not contains_any("Approve sign in", "Open your Authenticator app")(t)},
        timeout=30,
    )
    if label is None:
        raise RuntimeError("MFA prompt never cleared after relay approval")
    print("[step] MFA cleared")


def fetch_course_names():
    goto(COURSES_URL, settle=3)
    # No click-to-focus here: course cards cover most of this page, so the
    # usual blank-area click used elsewhere would navigate into a course.
    text = read_page_text(click_blank_first=False)
    names = []
    seen = set()
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r"^[A-Z]{2,4} \d{3}[A-Za-z0-9.\-]* : .+\(.+\)$", line)
        if m and line not in seen:
            seen.add(line)
            names.append(line)
    return names


def fetch_grades():
    """Returns {course_name: grade_string} from the single grade-overview
    page (one fetch covers every enrolled course's overall grade)."""
    goto(GRADE_OVERVIEW_URL, settle=3)
    text = read_page_text(click_blank_first=False)
    grades = {}
    for line in text.splitlines():
        line = line.rstrip()
        m = re.match(r"^([A-Z]{2,4} \d{3}[A-Za-z0-9.\-]* : .+\(.+\))\t(.+)$", line)
        if m:
            grades[m.group(1)] = m.group(2).strip()
    return grades


EXTENSION_DIR = str(Path(__file__).parent / "ozu-extension")
DOWNLOADS_DIR = str(Path.home() / "Downloads")
EXTENSION_NAME = "Ozyegin LMS Downloader"


def ensure_extension_loaded():
    """Loads our (patched) copy of a friend's LMS-export browser extension
    as a temporary add-on via about:debugging, if not already loaded this
    Firefox process. Its content script (course/view.php pages) exposes a
    real authenticated fetch() to Moodle's own grade report + DOM parsing
    -- far more robust than scraping clipboard text, since it gets Moodle's
    actual HTML table structure rather than a flattened text approximation.
    Temporary add-ons only last for the Firefox process's lifetime, so this
    needs to run again after every Firefox restart (harmless to call when
    already loaded -- it no-ops)."""
    goto("about:debugging#/runtime/this-firefox", settle=2)
    text = read_page_text(click_blank_first=False)
    if EXTENSION_NAME in text:
        return
    print("[step] loading LMS export extension as a temporary add-on")
    click(855, 369, settle=1)  # "Load Temporary Add-on..."
    key("ctrl+l", settle=0.5)  # GTK file chooser: type path directly
    type_text(f"{EXTENSION_DIR}/manifest.json", settle=0.3)
    key("Return", settle=2)


def fetch_course_grades(course_name, course_id):
    """Detailed per-course grade breakdown (individual graded items, not
    just the course's overall total), via the export extension's CSV."""
    for f in glob.glob(f"{DOWNLOADS_DIR}/Grades_{course_id}*.csv"):
        os.remove(f)

    goto(f"https://lms.ozyegin.edu.tr/course/view.php?id={course_id}&autoexport=1", settle=5)

    csv_path = f"{DOWNLOADS_DIR}/Grades_{course_id}.csv"
    for _ in range(10):
        if os.path.exists(csv_path):
            break
        time.sleep(1)
    else:
        raise RuntimeError(f"Grade export CSV never appeared for {course_name} (id={course_id})")

    rows = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            item = row["Item"]
            # The extension's own DOM-parsing quirk concatenates a preceding
            # "Aggregation" label onto "Course total" with no separator.
            if item.endswith("Course total"):
                item = "Course total"
            rows.append({
                "item": item,
                "weight": row["Weight"],
                "grade": row["Grade"],
                "range": row["Range"],
                "percentage": row["Percentage"],
                "feedback": row["Feedback"],
            })
    os.remove(csv_path)
    return rows


def fetch_all_course_grades():
    """Returns {course_name: [grade_item_rows...]} for every known course."""
    ensure_extension_loaded()
    result = {}
    for course_name, course_id in COURSE_IDS.items():
        print(f"[step] fetching detailed grades for {course_name}")
        result[course_name] = fetch_course_grades(course_name, course_id)
    return result


def ensure_logged_in():
    """Idempotent: does nothing if the existing session is still valid."""
    if not session_is_valid():
        do_login()
        return False  # a fresh login happened
    return True  # session was already valid


def main():
    if not session_is_valid():
        do_login()
    else:
        print("[step] existing session still valid, skipped login")

    names = fetch_course_names()
    print(f"[result] {len(names)} courses:")
    print(json.dumps(names, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
