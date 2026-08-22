from django.test import SimpleTestCase


class CreateResponseSchemaTests(SimpleTestCase):
    """TabMemo creation endpoints return HTTP 201, so Ninja must know that schema."""

    def test_create_endpoints_declare_201_response_schema(self):
        from apps.tabmemo.api import router

        expected = {
            ("/memos/", "create_memo"),
            ("/collections/", "create_collection"),
            ("/grants/", "create_grants"),
        }
        actual = {}

        for path, path_view in router.path_operations.items():
            for operation in path_view.operations:
                key = (path, operation.view_func.__name__)
                if key in expected:
                    actual[key] = operation

        self.assertEqual(set(actual), expected)
        for operation in actual.values():
            self.assertIn(201, operation.response_models)
