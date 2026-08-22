from unittest import TestCase
from unittest.mock import MagicMock, patch


class TestAppendSlides(TestCase):
    def test_append_slides_reids_generated_pages_and_preserves_existing_pages(self):
        from apps.tabslide.services.slide_service import SlideService

        svc = SlideService(user=None)
        project = MagicMock()
        project.id = "project-1"
        project.latest_version = 7
        extracted_pages = [
            {"id": "page-1", "elements": [{"id": "e-1", "type": "text"}]},
        ]
        final_pages = [
            {"id": "page-1", "elements": []},
            {"id": "page-new", "elements": [{"id": "e-1", "type": "text"}]},
            {"id": "page-2", "elements": []},
        ]

        with patch.object(svc, "_get_project", return_value=project), \
             patch.object(svc, "_extract_slides_from_html", return_value=(extracted_pages, None, 5)), \
             patch.object(
                 svc,
                 "_read_pages_from_slide_pages",
                 side_effect=[
                     [{"id": "page-1", "elements": []}, {"id": "page-2", "elements": []}],
                     final_pages,
                 ],
             ), \
             patch.object(svc, "save_pages_incremental", return_value=project) as save_incremental, \
             patch.object(svc, "_cas_save_pages") as cas_save, \
             patch.object(svc, "_register_embedded_fonts_for_pages"):
            _, pages = svc.append_slides(
                "project-1",
                html='<div class="ppt-slide">append</div>',
                after_page_id="page-1",
            )

        cas_save.assert_not_called()
        save_incremental.assert_called_once()
        kwargs = save_incremental.call_args.kwargs
        changed_pages = kwargs["changed_pages"]
        new_page_id = next(iter(changed_pages))
        self.assertNotEqual(new_page_id, "page-1")
        self.assertEqual(changed_pages[new_page_id]["id"], new_page_id)
        self.assertEqual(kwargs["page_order"], ["page-1", new_page_id, "page-2"])
        self.assertEqual(kwargs["base_version"], 7)
        self.assertEqual(pages, final_pages)

    def test_append_slides_rejects_page_id_when_html_generates_multiple_pages(self):
        from apps.tabslide.services.slide_service import SlideService

        svc = SlideService(user=None)
        project = MagicMock()
        project.id = "project-1"

        with patch.object(svc, "_get_project", return_value=project), \
             patch.object(
                 svc,
                 "_extract_slides_from_html",
                 return_value=(
                     [
                         {"id": "page-1", "elements": []},
                         {"id": "page-2", "elements": []},
                     ],
                     None,
                     5,
                 ),
             ):
            with self.assertRaises(ValueError) as cm:
                svc.append_slides(
                    "project-1",
                    html='<div class="ppt-slide">one</div><div class="ppt-slide">two</div>',
                    page_id="intro",
                )

        self.assertIn("HTML 只能生成 1 页", str(cm.exception))

    def test_append_slides_rejects_explicit_duplicate_page_id(self):
        from apps.tabslide.services.slide_service import SlideService

        svc = SlideService(user=None)
        project = MagicMock()
        project.id = "project-1"
        project.latest_version = 3

        with patch.object(svc, "_get_project", return_value=project), \
             patch.object(
                 svc,
                 "_extract_slides_from_html",
                 return_value=([{"id": "page-1", "elements": []}], None, 5),
             ), \
             patch.object(
                 svc,
                 "_read_pages_from_slide_pages",
                 return_value=[{"id": "intro", "elements": []}],
             ):
            with self.assertRaises(ValueError) as cm:
                svc.append_slides(
                    "project-1",
                    html='<div class="ppt-slide">append</div>',
                    page_id="intro",
                )

        self.assertIn("页面 ID 已存在", str(cm.exception))
