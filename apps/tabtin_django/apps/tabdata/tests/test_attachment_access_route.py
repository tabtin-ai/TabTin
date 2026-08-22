from django.test import SimpleTestCase


class AttachmentAccessRouteTests(SimpleTestCase):
    def test_access_url_post_is_not_captured_by_reference_delete_route(self):
        response = self.client.post(
            "/api/tabdata/attachments/access-url",
            data={},
            content_type="application/json",
        )

        self.assertNotEqual(response.status_code, 405)
        self.assertNotEqual(response.headers.get("Allow"), "DELETE")
