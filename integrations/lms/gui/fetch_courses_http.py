"""Read Moodle using the Firefox-exported session; GUI is only used to renew it."""
import json
import os
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BASE = "https://lms.ozyegin.edu.tr"
TERM = "Fall 2026/27"


class SessionExpired(RuntimeError):
    pass


def read_html(session, url):
    if urlparse(url).netloc != "lms.ozyegin.edu.tr":
        raise ValueError("Unexpected Moodle link host")
    response = session.get(url, timeout=45)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    if urlparse(response.url).netloc != "lms.ozyegin.edu.tr" or "/login/" in response.url or soup.select_one('input[name="password"]'):
        raise SessionExpired("Moodle session expired")
    return soup


def load_session():
    session = requests.Session()
    files = list(Path.home().joinpath("Downloads").glob("Cookies_lms.ozyegin.edu.tr*.json"))
    if not files:
        raise SessionExpired("No exported Moodle session")
    path = max(files, key=lambda p: p.stat().st_mtime)
    os.chmod(path, 0o600)
    for cookie in json.loads(path.read_text()):
        if cookie["domain"].lstrip(".") == "lms.ozyegin.edu.tr":
            session.cookies.set(cookie["name"], cookie["value"], domain=cookie["domain"], path=cookie["path"])
    return session


def renew_session():
    from fetch_courses_gui import ensure_logged_in, ensure_extension_loaded, goto
    ensure_logged_in()
    ensure_extension_loaded()
    started = time.time()
    goto(BASE + "/course/view.php?id=1693&exportcookies=1", settle=2)
    for _ in range(30):
        if any(p.stat().st_mtime >= started for p in Path.home().joinpath("Downloads").glob("Cookies_lms.ozyegin.edu.tr*.json")):
            return
        time.sleep(1)
    raise RuntimeError("Firefox did not export a fresh Moodle session")


def parse_grades(soup):
    table = soup.select_one("table.user-grade")
    if table is None:
        raise RuntimeError("Moodle grade table missing; refusing partial sync")
    rows = []
    for tr in table.select("tbody tr"):
        if tr.select_one(".column-grade") is None:
            continue
        item = tr.select_one(".gradeitemheader") or tr.select_one(".column-itemname")
        if item is None:
            raise RuntimeError("Grade row has no item name")
        row = {"item": item.get_text(" ", strip=True)}
        for field in ("weight", "grade", "range", "percentage", "feedback"):
            cell = tr.select_one(".column-" + field)
            row[field] = cell.get_text(" ", strip=True) if cell else ""
        rows.append(row)
    return rows


def fetch_all_course_grades():
    for attempt in range(2):
        try:
            with load_session() as session:
                soup = read_html(session, BASE + "/grade/report/overview/index.php")
                table = soup.select_one("#overview-grade")
                if table is None:
                    raise SessionExpired("Authenticated Moodle overview missing")
                courses = {a.get_text(" ", strip=True): urljoin(BASE, a["href"])
                           for a in table.select('a[href*="user.php"]')
                           if TERM in a.get_text()}
                if not courses:
                    raise RuntimeError("No current-term LMS courses; refusing empty sync")
                result = {}
                for name, url in courses.items():
                    result[name] = parse_grades(read_html(session, url))
                return result
        except SessionExpired:
            if attempt:
                raise
            renew_session()
