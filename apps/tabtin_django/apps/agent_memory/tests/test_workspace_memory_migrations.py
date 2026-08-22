from __future__ import annotations

import importlib

from django.db import migrations
from django.test import SimpleTestCase


class WorkspaceMemoryMigrationContractTests(SimpleTestCase):
    def test_schema_migration_is_additive_only(self):
        module = importlib.import_module(
            "apps.agent_memory.migrations.0002_workspacememorysettings_and_more"
        )
        self.assertTrue(
            all(
                isinstance(operation, (migrations.CreateModel, migrations.AddConstraint))
                for operation in module.Migration.operations
            )
        )

    def test_backfill_is_batched_non_atomic_and_non_destructive_on_reverse(self):
        module = importlib.import_module(
            "apps.agent_memory.migrations.0003_backfill_existing_workspace_memory_settings"
        )
        self.assertFalse(module.Migration.atomic)
        self.assertLessEqual(module.BATCH_SIZE, 500)
        operation = module.Migration.operations[0]
        self.assertIsInstance(operation, migrations.RunPython)
        self.assertIs(operation.reverse_code, migrations.RunPython.noop)
