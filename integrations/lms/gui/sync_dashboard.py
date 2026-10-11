#!/usr/bin/env python3
"""Merge LMS grades and SIS PDF attachments into the named Fall semester.

Existing cards keep user-owned fields. Missing courses are restored in a new
section. Writes compare the previous snapshot, back it up, then atomically
replace the semester JSON. The legacy data.json is no longer used.
"""
import json
import re
import subprocess
import sys
import time
import shlex
import base64
import copy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fetch_courses_http import fetch_all_course_grades  # noqa: E402

LEGION_SSH = ["sshpass", "-p", "0412", "ssh", "-p", "6220", "-o", "StrictHostKeyChecking=accept-new", "salih@127.0.0.1"]
REMOTE_DATA_PATH = "/home/salih/CampusDashboard/userdata/salih/data.json"
SECTION_TITLE = "Courses (Fall 2026/27)"
SEMESTER_NAME = "2026-2027 Fall"
NO_SYLLABUS_CODES = {"EE 301L.A", "EE 341L.C"}
_snapshot = None

COURSE_LINE_RE = re.compile(r"^([A-Z]{2,4} \d{3}[A-Za-z0-9.\-]*) : (.+?) \(.+\)$")


def legion_run(remote_cmd):
    return subprocess.run(LEGION_SSH + [remote_cmd], capture_output=True, text=True, check=True)


def fetch_remote_data():
    global REMOTE_DATA_PATH, _snapshot
    root = "/home/salih/CampusDashboard/userdata/salih"
    semesters = json.loads(legion_run(f"cat {root}/semesters.json").stdout)
    matches = [s for s in semesters["semesters"] if s["name"] == SEMESTER_NAME and not s.get("archived")]
    if len(matches) != 1 or not re.fullmatch(r"sem_[a-z0-9]+", matches[0]["id"]):
        raise RuntimeError("Cannot uniquely resolve the Fall semester; refusing sync")
    REMOTE_DATA_PATH = f"{root}/semesters/{matches[0]['id']}.json"
    result = legion_run(f"cat {REMOTE_DATA_PATH}")
    _snapshot = result.stdout
    return json.loads(result.stdout)


def backup_remote_data():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_path = f"{REMOTE_DATA_PATH}.bak-{stamp}"
    legion_run(f"cp {REMOTE_DATA_PATH} {backup_path}")
    print(f"[sync] backed up remote data.json to {backup_path}")
    return backup_path


def write_remote_data(data):
    # Compare immediately before replacing, so a concurrent dashboard edit is
    # retried next cycle rather than overwritten. Back up the exact old file.
    script = """
import sys,json,pathlib,datetime,os
p=pathlib.Path(sys.argv[1]); payload=json.load(sys.stdin)
current=p.read_text()
if current != payload['expected']: raise RuntimeError('Dashboard changed during sync; retry required')
stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
p.with_name(p.name+'.bak-'+stamp).write_text(current)
temp=p.with_name(p.name+'.lms-tmp')
temp.write_text(json.dumps(payload['data'],indent=2,ensure_ascii=False))
os.replace(temp,p)
"""
    payload = json.dumps({"expected": _snapshot, "data": data}, ensure_ascii=False)
    proc = subprocess.run(
        LEGION_SSH + [f"python3 -c {shlex.quote(script)} {shlex.quote(REMOTE_DATA_PATH)}"],
        input=payload, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Failed to write remote data.json: {proc.stderr}")


def build_course_items(grades_by_course, syllabi_by_code=None):
    syllabi_by_code = syllabi_by_code or {}
    items = []
    for course_name, grade_rows in grades_by_course.items():
        m = COURSE_LINE_RE.match(course_name)
        if not m:
            print(f"[sync] WARNING: couldn't parse course name, skipping: {course_name}")
            continue
        code, name = m.group(1), m.group(2)
        items.append({
            "code": code,
            "lmsCode": code,
            "name": name,
            "faculty": "",
            "credits": None,
            "syllabus": "",
            # SIS's catalog gives us description text, not an actual PDF --
            # "syllabus" (above) is a file-path field the UI renders as a PDF
            # button, so this goes in "notes" (free text) instead.
            "notes": syllabi_by_code.get(code, ""),
            "homework": [],
            "exams": [],
            "slides": [],
            "resources": [],
            "grades": grade_rows,
        })
    items.sort(key=lambda it: it["code"])
    return items


def get_current_section_items(data):
    """None if the section is missing entirely (e.g. manually deleted)."""
    for section in data.get("sections", []):
        if section.get("title") == SECTION_TITLE:
            return section.get("items", [])
    return None


def merge_section(data, new_items):
    def base(code):
        return re.sub(r"\.[A-Za-z0-9]+$", "", code).upper().strip()
    sections = data.setdefault("sections", [])
    target = next((s for s in sections if s.get("title") == SECTION_TITLE and s.get("type") == "courses"), None)
    if target is None:
        target = {"title": SECTION_TITLE, "type": "courses", "collapsed": False, "items": []}
        sections.insert(0, target)
    touched = []
    for item in new_items:
        exact = [old for section in data.get("sections", []) if section.get("type") == "courses"
                 for old in section.get("items", []) if old.get("code") == item["code"]]
        matches = exact or [old for section in data.get("sections", []) if section.get("type") == "courses"
                            for old in section.get("items", []) if old.get("code") == base(item["code"])]
        if len(matches) > 1:
            raise RuntimeError(f"Ambiguous dashboard course: {item['code']}")
        if matches:
            old = matches[0]
            old["grades"] = item["grades"]
            old["lmsCode"] = item["code"]
            if item.get("syllabus"):
                old["syllabus"] = item["syllabus"]
            source = next(s for s in sections if any(i is old for i in s.get("items", [])))
            if source is not target:
                if source.get("visibility") == "private":
                    target["visibility"] = "private"
                source["items"] = [i for i in source["items"] if i is not old]
                target["items"].append(old)
                touched.append(source)
        else:
            target["items"].append(copy.deepcopy(item))
    data["sections"] = [s for s in sections if s.get("items") or not any(s is moved for moved in touched)]
    target["items"].sort(key=lambda i: i.get("code", ""))
    return data


def fetch_pdf_attachments(codes):
    codes = [code for code in codes if code not in NO_SYLLABUS_CODES]
    directory = Path(__file__).parent
    cache_path = directory / "syllabi" / "manifest.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    missing = [code for code in codes if code not in cache
               or (cache[code] and not (directory / "syllabi" / cache[code]).exists())
               or (cache[code] is None and time.time() - cache.get("checked_at", 0) > 86400)]
    if missing:
        proc = subprocess.run(["node", str(directory / "fetch_sis_pdfs.cjs"), *missing],
                              capture_output=True, text=True, timeout=900, check=True)
        print(proc.stderr, end="")
        cache.update(json.loads(proc.stdout))
        cache["checked_at"] = time.time()
        cache_path.parent.mkdir(exist_ok=True)
        cache_path.write_text(json.dumps(cache, indent=2))
    result = {}
    upload = """
import sys,json,pathlib,base64,os
root=pathlib.Path('/home/salih/CampusDashboard/userdata/salih/docs')
root.mkdir(exist_ok=True)
for name,encoded in json.load(sys.stdin).items():
 if pathlib.Path(name).name != name: raise ValueError('Invalid filename')
 content=base64.b64decode(encoded)
 if not content.startswith(b'%PDF-'): raise ValueError('Invalid PDF')
 p=root/name
 if p.exists() and p.read_bytes()==content: continue
 if p.exists(): raise RuntimeError('Refusing to replace a different PDF: '+name)
 temp=p.with_suffix('.tmp'); temp.write_bytes(content); os.replace(temp,p)
"""
    payload = {}
    for code in codes:
        if cache.get(code):
            name = cache[code]
            payload[name] = base64.b64encode((directory / "syllabi" / name).read_bytes()).decode()
            result[code] = "docs/" + name
    if payload:
        subprocess.run(LEGION_SSH + ["python3 -c " + shlex.quote(upload)], input=json.dumps(payload),
                       text=True, capture_output=True, check=True, timeout=120)
    return result, [code for code in codes if code not in cache]


def sync_courses(grades_by_course):
    new_items = build_course_items(grades_by_course)
    if not new_items or len(new_items) != len(grades_by_course):
        raise RuntimeError("Incomplete course parsing; refusing sync")
    pdfs, errors = fetch_pdf_attachments([item["code"] for item in new_items])
    for item in new_items:
        item["syllabus"] = pdfs.get(item["code"], "")
    data = fetch_remote_data()
    previous = copy.deepcopy(data)
    merge_section(data, new_items)
    if data != previous:
        write_remote_data(data)
    missing = [item["code"] for item in new_items if item["code"] not in pdfs and item["code"] not in NO_SYLLABUS_CODES]
    print(f"[sync] {len(new_items)} LMS courses, {len(pdfs)} SIS PDFs in {SEMESTER_NAME}")
    if missing:
        print("[sync] No SIS PDF attached for: " + ", ".join(missing))
    if errors:
        raise RuntimeError("Courses synced, but SIS retrieval failed for: " + ", ".join(errors))


def main():
    sync_courses(fetch_all_course_grades())


if __name__ == "__main__":
    main()
