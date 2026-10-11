import copy
import unittest

from bs4 import BeautifulSoup
from fetch_courses_http import parse_grades
from sync_dashboard import build_course_items, merge_section, SECTION_TITLE


class SyncTests(unittest.TestCase):
    def test_preserves_user_fields_and_other_sections(self):
        course = {"code": "CS 321", "name": "Custom name", "notes": "Keep me",
                  "homework": [{"title": "Assignment"}], "resources": [{"title": "Book"}]}
        data = {"sections": [{"title": "My courses", "type": "courses", "items": [course]},
                             {"title": "Notes", "type": "notes", "items": ["unchanged"]}]}
        notes = copy.deepcopy(data["sections"][1])
        items = build_course_items({"CS 321.A : Programming Paradigms (Fall 2026/27)": [{"item": "Total", "grade": "90"}],
                                    "EE 301L.A : Lab (Fall 2026/27)": []})
        items[0]["syllabus"] = "docs/sis-cs-321.a.pdf"
        merge_section(data, items)
        self.assertEqual(course["notes"], "Keep me")
        self.assertEqual(course["name"], "Custom name")
        self.assertEqual(len(course["homework"]), 1)
        self.assertEqual(len(course["resources"]), 1)
        self.assertEqual(course["syllabus"], "docs/sis-cs-321.a.pdf")
        self.assertIn(notes, data["sections"])
        self.assertEqual(len([s for s in data["sections"] if s["type"] == "courses"]), 1)
        self.assertEqual(len(data["sections"][0]["items"]), 2)
        snapshot = copy.deepcopy(data)
        merge_section(data, items)
        self.assertEqual(data, snapshot)

    def test_restores_deleted_section(self):
        data = {"sections": []}
        items = build_course_items({"CS 321.A : Programming Paradigms (Fall 2026/27)": []})
        merge_section(data, items)
        self.assertEqual(data["sections"][0]["title"], SECTION_TITLE)
        self.assertEqual(len(data["sections"][0]["items"]), 1)

    def test_consolidation_preserves_unrelated_courses_and_privacy(self):
        data = {"sections": [{"title": "New Section", "type": "courses", "visibility": "private",
                              "items": [{"code": "CS 321", "notes": "Keep"}, {"code": "OTHER"}]}]}
        items = build_course_items({"CS 321.A : Programming Paradigms (Fall 2026/27)": []})
        merge_section(data, items)
        self.assertEqual(data["sections"][0]["visibility"], "private")
        self.assertEqual(data["sections"][0]["items"][0]["notes"], "Keep")
        self.assertEqual(data["sections"][1]["items"], [{"code": "OTHER"}])

    def test_labs_do_not_trigger_pdf_fetches(self):
        from unittest.mock import patch
        from sync_dashboard import fetch_pdf_attachments
        with patch('sync_dashboard.subprocess.run') as run:
            self.assertEqual(fetch_pdf_attachments(["EE 301L.A", "EE 341L.C"]), ({}, []))
            run.assert_not_called()

    def test_grade_columns_and_aggregation_label(self):
        soup = BeautifulSoup('''<table class="user-grade"><tbody>
        <tr><th class="column-itemname">Category</th></tr>
        <tr><th class="column-itemname">Aggregation<span class="gradeitemheader">Course total</span></th>
        <td class="column-grade">85</td><td class="column-weight">50%</td>
        <td class="column-range">0–100</td><td class="column-percentage">85%</td>
        <td class="column-feedback">Good <b>work</b></td></tr></tbody></table>''', 'html.parser')
        self.assertEqual(parse_grades(soup), [{"item": "Course total", "grade": "85", "weight": "50%",
                                             "range": "0–100", "percentage": "85%", "feedback": "Good work"}])

    def test_missing_grade_table_is_not_an_empty_success(self):
        with self.assertRaises(RuntimeError):
            parse_grades(BeautifulSoup('<html>Sign in</html>', 'html.parser'))


if __name__ == '__main__':
    unittest.main()
