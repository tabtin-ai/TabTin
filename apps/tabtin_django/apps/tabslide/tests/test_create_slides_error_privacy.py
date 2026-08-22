"""Privacy and compatibility contracts for create-slides failures."""

from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from apps.tabslide import api
from apps.tabslide.error_codes import ErrorCode


class CreateSlidesErrorPrivacyTests(TestCase):
    def test_unexpected_browser_error_does_not_escape_to_logs_or_api(self):
        privacy_sentinel = "PRIVATE_SLIDE_BODY_10835"
        request = SimpleNamespace(auth=SimpleNamespace(id=1))
        body = SimpleNamespace(
            html='<div class="ppt-slide"></div>',
            title=None,
            mode="direct",
            inline_images=False,
        )
        service = SimpleNamespace(
            create_slides=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                RuntimeError(privacy_sentinel)
            )
        )

        with (
            patch.object(api, "_build_service", return_value=service),
            patch.object(
                api,
                "error_response",
                side_effect=lambda code, message: {"code": code, "message": message},
            ),
            self.assertLogs(api.logger, level="ERROR") as captured,
        ):
            result = api.create_slides(request, "project-1", body)

        self.assertEqual(result["code"], ErrorCode.SLIDES_CREATION_FAILED)
        self.assertNotIn(privacy_sentinel, result["message"])
        self.assertNotIn(privacy_sentinel, "\n".join(captured.output))
