#!/usr/bin/env python3
"""
Fetches course descriptions (syllabus text) from sis.ozyegin.edu.tr's public
course catalog search -- no login needed, confirmed by inspecting an
existing scraper at ~/python/scrape/sis/monitor.js which queries the same
page fully unauthenticated. (Exam schedules are a different, login-required
area of SIS -- not handled here.)

One search per COURSE (not per subject): an earlier version searched by
subject alone to cut down on requests (~4 searches instead of 10), but SIS
hard-caps "show descriptions" at some threshold below a full subject's
course count -- clicking it against 30 results pops a blocking "Can't
select that many records at once. Please try working in smaller batches."
dialog instead of revealing anything. One search per course reliably stays
under that cap (single result), so that's what this does despite the extra
requests.

Driven via the same xdotool/Xvfb Firefox as the LMS automation (see
fetch_courses_gui.py's module docstring for why: no CDP/WebDriver
fingerprint). Unlike LMS, real Playwright IS blocked here too (tested: a
plain Playwright Chromium request gets an outright "Forbidden" from
whatever WAF fronts SIS), so this needs the same real-browser approach.
"""
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fetch_courses_gui import (  # noqa: E402
    xdotool, click, key, type_text, goto, read_page_text, contains_any,
)

CATALOG_URL = "https://sis.ozyegin.edu.tr/OZU_GWT/WEB/CourseCatalogOfferUI?locale=tr"
TERM = "2026 - 2027 Güz"  # update each semester

# "CS 321.A" -> ("CS", "CS 321") -- subject for the Konu field, "subject
# number" for the free-text Arama field (which doesn't take section letters).
CODE_RE = re.compile(r"^([A-Z]{2,4}) (\d{3}[A-Za-z0-9.\-]*)")


def _query_for(course_code):
    m = CODE_RE.match(course_code)
    if not m:
        return None, None
    subject, rest = m.group(1), m.group(2)
    number = re.match(r"\d+", rest).group(0)
    return subject, f"{subject} {number}"


def _click_field_and_type(x, y, text):
    click(x, y, settle=0.3)
    xdotool("key", "ctrl+a")
    xdotool("key", "Delete")
    time.sleep(0.2)
    type_text(text, settle=0.8)


def _search_once(subject, query):
    """One attempt at the full search flow. Form-field values (the dropdown
    selections) aren't visible in a plain select-all text dump -- only their
    empty labels are -- so intermediate steps can't be individually verified
    the way the LMS login flow's text-based states can. Instead this is
    wrapped by search() below, which checks the one thing that *is* visible
    (the actual result count, and the descriptions-toggle's label) and
    retries the whole flow from scratch if either is missing, rather than
    trying to verify each click."""
    goto(CATALOG_URL, settle=4)

    # "Detaylı Arama" (detailed search) button -- fixed position on first load.
    click(164, 284, settle=2)

    # Ders Seviyesi (level) = Lisans
    _click_field_and_type(258, 201, "Lisans")
    click(200, 244, settle=0.5)  # click "Lisans" suggestion

    # Donem Kodu (term)
    _click_field_and_type(685, 201, TERM.split(" - ")[0])
    # Suggestion list position is stable for a 4-digit-year query; click the
    # row matching our exact TERM text by scanning is more robust than one
    # hardcoded coordinate across different terms, but for now this project
    # only needs the current term -- revisit if TERM changes and this breaks.
    click(594, 276, settle=0.5)

    # Konu (subject) -- narrows results, paired with the free-text query
    # below so we land on exactly one result (see module docstring: SIS
    # refuses to show descriptions for too many results at once).
    _click_field_and_type(258, 289, subject)
    click(200, 331, settle=0.5)

    # Arama (free text) -- e.g. "CS 321"
    click(316, 320, settle=0.3)
    xdotool("key", "ctrl+a")
    xdotool("key", "Delete")
    time.sleep(0.2)
    type_text(query, settle=0.5)

    # Arama button (search)
    click(50, 391, settle=3)

    # Açıklamaları Göster (show descriptions) -- reveals full text inline.
    click(267, 505, settle=2)

    return read_page_text(click_blank_first=False)


def search(course_code, attempts=4):
    """Runs one catalog search for one course code (e.g. "CS 321.A"),
    retrying the whole flow from scratch if either (a) the result count text
    never shows up, or (b) it shows up but the "show descriptions" toggle
    click didn't register -- its label flips from "Açıklamaları Göster" to
    "Açıklamasız Göster" once it has, the only visible confirmation
    available. Returns None if the code can't be parsed into a subject+query."""
    subject, query = _query_for(course_code)
    if not subject:
        print(f"[step] couldn't parse a subject/number out of course code: {course_code}")
        return None

    for attempt in range(1, attempts + 1):
        text = _search_once(subject, query)
        has_results = contains_any("Kayıt Bulundu")(text)
        has_descriptions = contains_any("Açıklamasız Göster")(text)
        if has_results and has_descriptions:
            return text
        reason = "no results text" if not has_results else "descriptions toggle didn't register"
        print(f"[step] search for {course_code} attempt {attempt}/{attempts}: "
              f"{reason}, {'retrying' if attempt < attempts else 'giving up'}")
    print(f"[step] WARNING: SIS search for {course_code} never fully succeeded after {attempts} attempts, skipping")
    return None


# Matches one result block's header line: code, name, credits.
_COURSE_HEADER_RE = re.compile(
    r"^([A-Z]{2,4} \d{3}[A-Za-z0-9.\-]*)\t(.+?)\t(\d+) credits$"
)


def parse_search_result(text, expected_code):
    """Returns the description text for `expected_code` out of one course's
    search-result page, or "" if that exact code isn't in it (e.g. the query
    matched a different section)."""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        m = _COURSE_HEADER_RE.match(lines[i].strip("\t "))
        if m and m.group(1) == expected_code:
            desc_lines = []
            j = i + 1
            while j < len(lines):
                line = lines[j].strip()
                if not line:
                    j += 1
                    continue
                if _COURSE_HEADER_RE.match(lines[j].strip("\t ")):
                    break
                if line.startswith(("Ön koşul", "Yan koşul", "P\tPt\tS", "P Pt S")):
                    break
                desc_lines.append(line)
                j += 1
            return " ".join(desc_lines).strip()
        i += 1
    return ""


def fetch_syllabi(course_codes):
    """course_codes: iterable of dashboard-style codes, e.g. ["CS 321.A", ...].
    Returns {course_code: description_text} for whichever of them are found."""
    results = {}
    for code in course_codes:
        print(f"[step] searching SIS catalog for: {code}")
        text = search(code)
        if text is None:
            continue
        desc = parse_search_result(text, code)
        if desc:
            results[code] = desc
        else:
            print(f"[step] WARNING: {code} not found in its own search result")
    return results


if __name__ == "__main__":
    import json
    from sync_dashboard import fetch_remote_data, SECTION_TITLE

    data = fetch_remote_data()
    codes = []
    for section in data.get("sections", []):
        if section.get("title") == SECTION_TITLE:
            codes = [item["code"] for item in section.get("items", [])]
    print(f"[step] fetching syllabi for: {codes}")
    result = fetch_syllabi(codes)
    print(json.dumps(result, indent=2, ensure_ascii=False))
