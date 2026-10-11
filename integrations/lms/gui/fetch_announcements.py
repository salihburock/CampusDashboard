#!/usr/bin/env python3
"""
Fetches each course's Announcements forum posts from Moodle, using the same
exported-cookie session as grades/materials.

NOT YET LIVE-VERIFIED: every course has an auto-created "Announcements"
forum in its General section (standard Moodle behavior), and this assumes
the standard Boost-theme forum discussion-list markup. Written during an
MFA cooldown window with no live session available to confirm selectors
against this LMS's actual rendered HTML -- run once with a valid session
and check the printed course/discussion counts (and, if a course comes back
with 0 discussions unexpectedly, the diagnostic HTML dump) before trusting
this in the monitor loop.
"""
import re
import sys
from pathlib import Path
from urllib.parse import urljoin

sys.path.insert(0, str(Path(__file__).parent))
from fetch_courses_http import BASE, load_session, read_html, renew_session, SessionExpired  # noqa: E402

ANNOUNCEMENTS_LINK_RE = re.compile(r"announce|duyuru", re.IGNORECASE)


def find_announcements_forum_url(soup):
    """Returns the absolute URL of the course's Announcements forum, or
    None if no matching link is found."""
    for a in soup.select('a[href*="mod/forum/view.php"]'):
        if ANNOUNCEMENTS_LINK_RE.search(a.get_text(strip=True)):
            return urljoin(BASE, a["href"])
    return None


def parse_discussions(soup):
    """Returns [{"id": str, "subject": str, "author": str, "url": str}, ...]
    from a forum view page. Moodle's discussion list has varied markup
    across versions/themes -- tries a few known patterns."""
    discussions = []
    seen_ids = set()

    # Boost theme (Moodle 4.x): discussion links go to discuss.php?d=<id>.
    for a in soup.select('a[href*="mod/forum/discuss.php"]'):
        href = a.get("href", "")
        m = re.search(r"[?&]d=(\d+)", href)
        if not m:
            continue
        disc_id = m.group(1)
        if disc_id in seen_ids:
            continue
        seen_ids.add(disc_id)
        subject = a.get_text(strip=True)
        if not subject:
            continue
        discussions.append({
            "id": disc_id,
            "subject": subject,
            "url": urljoin(BASE, href),
        })
    return discussions


def fetch_course_announcements(session, course_code, course_id):
    """Returns (discussions, diagnostic_html_snippet_or_None). The
    diagnostic snippet is only populated when no forum link was found, to
    help debug the selector against this LMS's real markup."""
    course_soup = read_html(session, f"{BASE}/course/view.php?id={course_id}")
    forum_url = find_announcements_forum_url(course_soup)
    if forum_url is None:
        return [], str(course_soup)[:3000]

    forum_soup = read_html(session, forum_url)
    discussions = parse_discussions(forum_soup)
    diag = None if discussions else str(forum_soup)[:3000]
    return discussions, diag


def fetch_all_announcements(course_ids_by_code):
    """course_ids_by_code: {course_code: moodle_id}.
    Returns {code: [discussion, ...]}."""
    for attempt in range(2):
        try:
            with load_session() as session:
                result = {}
                for code, course_id in course_ids_by_code.items():
                    print(f"[step] fetching announcements for {code}")
                    discussions, diag = fetch_course_announcements(session, code, course_id)
                    result[code] = discussions
                    print(f"[step] {code}: {len(discussions)} discussion(s)")
                    if diag:
                        print(f"[step] {code}: no discussions found -- diagnostic HTML snippet:\n{diag[:500]}")
                return result
        except SessionExpired:
            if attempt:
                raise
            renew_session()


if __name__ == "__main__":
    import json
    from fetch_courses_gui import COURSE_IDS
    codes = {name.split(" : ")[0]: cid for name, cid in COURSE_IDS.items()}
    result = fetch_all_announcements(codes)
    print(json.dumps(result, indent=2, ensure_ascii=False))
