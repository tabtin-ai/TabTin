from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.docparse.parsers.base import ChunkResult, PageResult
from apps.services.docparse.pdf_subprocess import (
    _DAEMONIC_CHILD_ERROR,
    _parent_cannot_spawn_mp_child,
    _spawn_blocked_by_daemon_parent,
    parse_pdf_page_batch_in_subprocess,
)


class PDFSubprocessDaemonFallbackTests(SimpleTestCase):
    def test_spawn_blocked_by_daemon_parent_matches_assertion_message(self):
        exc = AssertionError(_DAEMONIC_CHILD_ERROR)
        self.assertTrue(_spawn_blocked_by_daemon_parent(exc))
        self.assertFalse(_spawn_blocked_by_daemon_parent(AssertionError("other")))

    @patch("apps.services.docparse.pdf_subprocess.mp.current_process")
    def test_daemon_parent_skips_mp_process_and_parses_in_parent(
        self,
        mock_current_process,
    ):
        mock_current_process.return_value = MagicMock(daemon=True)
        expected = [
            PageResult(
                page_number=1,
                width=612,
                height=792,
                chunks=[ChunkResult(
                    chunk_type="paragraph",
                    content="page 1",
                    sequence=1,
                    metadata={"source": "text_layer"},
                )],
                text_content="page 1",
            ),
        ]

        with patch(
            "apps.services.docparse.pdf_subprocess._parse_pages",
            return_value=expected,
        ) as mock_parse_pages, patch(
            "apps.services.docparse.pdf_subprocess.mp.Process",
        ) as mock_process_cls:
            result = parse_pdf_page_batch_in_subprocess(
                file_path="/fake/doc.pdf",
                page_numbers=[1],
                vision_model="vision-model",
                user_id="user-1",
                organization_id="org-1",
            )

        self.assertEqual(result, expected)
        mock_parse_pages.assert_called_once_with(
            file_path="/fake/doc.pdf",
            page_numbers=[1],
            vision_model="vision-model",
            user_id="user-1",
            organization_id="org-1",
        )
        mock_process_cls.assert_not_called()

    @patch("apps.services.docparse.pdf_subprocess.mp.current_process")
    def test_start_blocked_by_daemon_parent_falls_back_to_in_process_parse(
        self,
        mock_current_process,
    ):
        mock_current_process.return_value = MagicMock(daemon=False)
        expected = [
            PageResult(
                page_number=2,
                width=612,
                height=792,
                chunks=[ChunkResult(
                    chunk_type="paragraph",
                    content="page 2",
                    sequence=1,
                    metadata={"source": "text_layer"},
                )],
                text_content="page 2",
            ),
        ]

        blocked = AssertionError(_DAEMONIC_CHILD_ERROR)
        mock_process = MagicMock()
        mock_process.start.side_effect = blocked

        with patch(
            "apps.services.docparse.pdf_subprocess._parse_pages",
            return_value=expected,
        ) as mock_parse_pages, patch(
            "apps.services.docparse.pdf_subprocess.mp.Queue",
            return_value=MagicMock(),
        ), patch(
            "apps.services.docparse.pdf_subprocess.mp.Process",
            return_value=mock_process,
        ):
            result = parse_pdf_page_batch_in_subprocess(
                file_path="/fake/doc.pdf",
                page_numbers=[2],
                vision_model="",
                user_id="user-2",
                organization_id="org-2",
            )

        self.assertEqual(result, expected)
        mock_parse_pages.assert_called_once()
        mock_process.start.assert_called_once()

    @patch("apps.services.docparse.pdf_subprocess.mp.current_process")
    def test_non_daemon_parent_still_uses_mp_process_path(
        self,
        mock_current_process,
    ):
        mock_current_process.return_value = MagicMock(daemon=False)
        mock_process = MagicMock()
        mock_process.is_alive.return_value = False
        mock_queue = MagicMock()
        mock_queue.get_nowait.return_value = {
            "ok": True,
            "pages": [{
                "page_number": 1,
                "width": 612,
                "height": 792,
                "chunks": [{
                    "chunk_type": "paragraph",
                    "content": "child page",
                    "sequence": 1,
                    "bbox": None,
                    "heading_level": None,
                    "metadata": {"source": "text_layer"},
                }],
                "text_content": "child page",
            }],
        }
        mock_queue.get.return_value = mock_queue.get_nowait.return_value

        with patch(
            "apps.services.docparse.pdf_subprocess._parse_pages",
        ) as mock_parse_pages, patch(
            "apps.services.docparse.pdf_subprocess.mp.Queue",
            return_value=mock_queue,
        ), patch(
            "apps.services.docparse.pdf_subprocess.mp.Process",
            return_value=mock_process,
        ):
            result = parse_pdf_page_batch_in_subprocess(
                file_path="/fake/doc.pdf",
                page_numbers=[1],
                vision_model="",
                user_id="user-3",
                organization_id="org-3",
            )

        self.assertEqual(result[0].page_number, 1)
        self.assertEqual(result[0].chunks[0].content, "child page")
        mock_parse_pages.assert_not_called()
        mock_process.start.assert_called_once()
        mock_queue.get.assert_called_once()

    @patch("apps.services.docparse.pdf_subprocess.mp.current_process")
    def test_parent_reads_queue_before_join_to_avoid_large_payload_deadlock(
        self,
        mock_current_process,
    ):
        mock_current_process.return_value = MagicMock(daemon=False)
        events: list[str] = []
        mock_process = MagicMock()
        mock_process.is_alive.return_value = False
        payload = {
            "ok": True,
            "pages": [{
                "page_number": 3,
                "width": 612,
                "height": 792,
                "chunks": [{
                    "chunk_type": "paragraph",
                    "content": "large page",
                    "sequence": 1,
                    "bbox": None,
                    "heading_level": None,
                    "metadata": {"source": "text_layer"},
                }],
                "text_content": "large page",
            }],
        }

        mock_queue = MagicMock()

        def _get(*_args, **_kwargs):
            events.append("get")
            return payload

        def _join(*_args, **_kwargs):
            events.append("join")

        mock_queue.get.side_effect = _get
        mock_process.join.side_effect = _join

        with patch(
            "apps.services.docparse.pdf_subprocess.mp.Queue",
            return_value=mock_queue,
        ), patch(
            "apps.services.docparse.pdf_subprocess.mp.Process",
            return_value=mock_process,
        ):
            result = parse_pdf_page_batch_in_subprocess(
                file_path="/fake/doc.pdf",
                page_numbers=[3],
                vision_model="",
                user_id="user-3",
                organization_id="org-3",
            )

        self.assertEqual(result[0].chunks[0].content, "large page")
        self.assertLess(events.index("get"), events.index("join"))
