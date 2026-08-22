from django.test import RequestFactory, SimpleTestCase, override_settings

from apps.users.auth.api.docs_routes import health_check


class RuntimeVersionHealthTests(SimpleTestCase):
    @override_settings(
        TABTIN_SERVER_VERSION="1.0.1-beta.1",
        TABTIN_GIT_SHA="8ad18305",
    )
    def test_health_exposes_deployed_release_and_source_sha(self):
        response = health_check(RequestFactory().get("/api/auth/health"))

        self.assertTrue(response.success)
        self.assertEqual(
            response.data,
            {"release_version": "1.0.1-beta.1", "source_sha": "8ad18305"},
        )
