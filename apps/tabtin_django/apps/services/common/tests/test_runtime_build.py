from django.test import RequestFactory, SimpleTestCase, override_settings

from apps.services.common.runtime_build import (
    get_server_build,
    is_version_at_least,
    parse_client_build,
)


class RuntimeBuildTests(SimpleTestCase):
    def test_parses_client_build_from_shared_headers(self):
        request = RequestFactory().get(
            "/api/example",
            headers={
                "X-Client-Type": "electron",
                "X-Client-Version": "0.7.0-beta.140",
                "X-Client-Source-Sha": "abc1234",
            },
        )

        build = parse_client_build(request)

        self.assertEqual(build.client_type, "electron")
        self.assertEqual(build.client_version, "0.7.0-beta.140")
        self.assertEqual(build.source_sha, "abc1234")

    @override_settings(
        TABTIN_SERVER_VERSION="1.0.1-beta.1",
        TABTIN_GIT_SHA="def5678",
    )
    def test_reads_server_build_and_compares_supported_versions(self):
        self.assertEqual(get_server_build().release_version, "1.0.1-beta.1")
        self.assertEqual(get_server_build().source_sha, "def5678")
        self.assertTrue(is_version_at_least("1.0.1", "1.0.1-beta.1", kind="release"))
        self.assertTrue(is_version_at_least("0.7.0-beta.140", "0.7.0-beta.139", kind="client"))
        self.assertFalse(is_version_at_least("", "0.7.0", kind="client"))
        self.assertFalse(is_version_at_least("26081", "260805", kind="release"))
