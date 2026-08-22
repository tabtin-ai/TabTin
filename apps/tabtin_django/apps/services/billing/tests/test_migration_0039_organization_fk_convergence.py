from importlib import import_module

from django.db import migrations
from django.test import SimpleTestCase


class OrganizationFkConvergenceMigrationTests(SimpleTestCase):
    def test_nullable_legacy_column_precedes_orphan_cleanup(self):
        migration = import_module(
            "apps.services.billing.migrations.0039_organization_fk_convergence_3832"
        ).Migration

        cleanup_index = next(
            index
            for index, operation in enumerate(migration.operations)
            if isinstance(operation, migrations.RunSQL)
        )
        nullable_index = next(
            index
            for index, operation in enumerate(migration.operations)
            if isinstance(operation, migrations.AlterField)
            and operation.model_name == "billingusageevent"
            and operation.name == "organization_id"
        )

        nullable_operation = migration.operations[nullable_index]
        self.assertTrue(nullable_operation.field.null)
        self.assertLess(nullable_index, cleanup_index)
