from django.apps import apps
from django.test import SimpleTestCase


class SpaceLevelGrantsRetiredTests(SimpleTestCase):
    def test_space_share_and_delegation_models_are_not_registered(self):
        model_names = {
            model.__name__
            for model in apps.get_app_config("tabtinspace").get_models()
        }

        self.assertNotIn("SpaceShare", model_names)
        self.assertNotIn("DelegationGrant", model_names)

    def test_resource_permission_schema_remains_available(self):
        from apps.tabtinspace.schemas.share import ResourcePermissionGrant

        grant = ResourcePermissionGrant(
            subject_type="user",
            subject_id="user-1",
            permission="viewer",
        )

        self.assertEqual(grant.permission, "viewer")

    def test_space_resource_permission_model_is_not_grantable(self):
        from apps.tabtinspace.services.permission_service import _get_permission_model

        self.assertIsNone(_get_permission_model("space"))
        self.assertIsNotNone(_get_permission_model("document"))
        self.assertIsNotNone(_get_permission_model("table"))

    def test_share_scope_has_no_runtime_grant_lookup_api(self):
        from apps.tabtinspace.services import share_scope

        self.assertFalse(hasattr(share_scope, "get_share_object_scope"))
        self.assertFalse(hasattr(share_scope, "get_effective_object_scope"))
        self.assertFalse(hasattr(share_scope, "get_organization_share_object_scopes"))
        self.assertTrue(hasattr(share_scope, "validate_object_scope"))
        self.assertTrue(hasattr(share_scope, "parse_scope_ids"))
