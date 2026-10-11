#!/usr/bin/env python3
"""
Downloads course materials (files, folder contents) from Moodle using the
same exported-cookie session as fetch_courses_http.py's grade fetching --
plain requests + BeautifulSoup, no browser involved for the actual fetch
(only used, via renew_session(), if the cookie has expired). Organized one
folder per course under materials/<code>/<section name>/.

Selectors match ~/gits/Contributions/ozu-lms-extension's OZU_SELECTORS
(the friend's extension used for grade CSVs) -- standard Moodle Boost-theme
classes, not anything course-specific.
"""
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote

sys.path.insert(0, str(Path(__file__).parent))
from fetch_courses_http import BASE, load_session, read_html, renew_session, SessionExpired  # noqa: E402

MATERIALS_DIR = Path(__file__).parent / "materials"

SECTION_SELECTORS = ["ul.weeks li.section", "ul.topics li.section", "li[id^='section-']"]
FILE_SELECTORS = [".activity.resource a", ".modtype_resource a"]
FOLDER_SELECTORS = [".activity.folder a", ".modtype_folder a"]


def _sanitize(name):
    name = re.sub(r'[\\/:*?"<>|]', "-", name or "").strip()
    return name[:150] or "untitled"


def _select_any(soup, selectors):
    for sel in selectors:
        found = soup.select(sel)
        if found:
            return found
    return []


def _download_file(session, url, dest_dir):
    resp = session.get(url, timeout=60, allow_redirects=True)
    resp.raise_for_status()
    content_type = resp.headers.get("content-type", "")
    if content_type.startswith("text/html"):
        # Most likely a login redirect (session expired mid-run) rather
        # than a real file -- Moodle files are never served as bare HTML.
        raise RuntimeError(f"Got HTML instead of a file from {url} (session expired?)")

    cd = resp.headers.get("content-disposition", "")
    m = re.search(r'filename\*?="?([^";]+)', cd)
    filename = unquote(m.group(1).split("''")[-1]) if m else unquote(Path(urlparse(resp.url).path).name)
    filename = _sanitize(filename or "file")

    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / filename
    path.write_bytes(resp.content)
    return path


def fetch_course_materials(session, course_code, course_id):
    """Downloads one course's files into materials/<code>/<section>/...
    Returns the number of files downloaded."""
    soup = read_html(session, f"{BASE}/course/view.php?id={course_id}")
    sections = _select_any(soup, SECTION_SELECTORS)
    course_dir = MATERIALS_DIR / course_code
    count = 0

    for section in sections:
        title_el = section.select_one(".sectionname") or section.select_one("[aria-label]")
        title = _sanitize(title_el.get_text(strip=True)) if title_el else "General"
        section_dir = course_dir / title

        for a in _select_any(section, FILE_SELECTORS):
            href = a.get("href")
            if not href:
                continue
            url = urljoin(BASE, href)
            try:
                _download_file(session, url, section_dir)
                count += 1
            except Exception as e:  # noqa: BLE001
                print(f"[step] {course_code}/{title}: failed to download {url}: {e}")

        for a in _select_any(section, FOLDER_SELECTORS):
            href = a.get("href")
            if not href:
                continue
            folder_name = _sanitize(a.get_text(strip=True)) or "folder"
            try:
                folder_soup = read_html(session, urljoin(BASE, href))
            except Exception as e:  # noqa: BLE001
                print(f"[step] {course_code}/{title}: failed to open folder {href}: {e}")
                continue
            for fa in folder_soup.select('a[href*="pluginfile.php"]'):
                fhref = fa.get("href")
                if not fhref:
                    continue
                try:
                    _download_file(session, urljoin(BASE, fhref), section_dir / folder_name)
                    count += 1
                except Exception as e:  # noqa: BLE001
                    print(f"[step] {course_code}/{title}/{folder_name}: failed to download: {e}")

    return count


def fetch_all_course_materials(course_ids_by_code):
    """course_ids_by_code: {course_code: moodle_id}. Returns {code: file_count}."""
    for attempt in range(2):
        try:
            with load_session() as session:
                result = {}
                for code, course_id in course_ids_by_code.items():
                    print(f"[step] fetching materials for {code}")
                    result[code] = fetch_course_materials(session, code, course_id)
                return result
        except SessionExpired:
            if attempt:
                raise
            renew_session()


if __name__ == "__main__":
    import json
    from fetch_courses_gui import COURSE_IDS
    codes = {name.split(" : ")[0]: cid for name, cid in COURSE_IDS.items()}
    result = fetch_all_course_materials(codes)
    print(json.dumps(result, indent=2))
