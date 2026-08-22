from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.test import TransactionTestCase


class ConversationMigrationMergeTests(TransactionTestCase):
    databases = {"default"}

    def test_conversation_migration_graph_merges_release_and_shared_task_leaves(self):
        loader = MigrationLoader(connection, ignore_no_migrations=True)

        conversation_leaves = [
            migration_name
            for app_label, migration_name in loader.graph.leaf_nodes("conversation")
            if app_label == "conversation"
        ]

        self.assertEqual(conversation_leaves, ["0100_chatsession_target_device_id"])

        merge_node = loader.graph.node_map[
            ("conversation", "0098_merge_release_and_sessionshare_v2")
        ]
        direct_parents = {parent.key for parent in merge_node.parents}
        self.assertEqual(
            direct_parents,
            {
                ("conversation", "0094_chatsession_pin_state"),
                ("conversation", "0095_merge_20260810_2130"),
                ("conversation", "0096_sessionshare_v2_contract"),
                ("conversation", "0097_reconcile_test_260812_history"),
            },
        )

        status_node = loader.graph.node_map[
            ("conversation", "0099_alter_sessionshare_status")
        ]
        self.assertEqual(
            {parent.key for parent in status_node.parents},
            {("conversation", "0098_merge_release_and_sessionshare_v2")},
        )

        release_merge_node = loader.graph.node_map[
            ("conversation", "0098_merge_20260811_1945")
        ]
        self.assertEqual(
            {parent.key for parent in release_merge_node.parents},
            {("conversation", "0099_alter_sessionshare_status")},
        )

        target_device_node = loader.graph.node_map[
            ("conversation", "0100_chatsession_target_device_id")
        ]
        self.assertEqual(
            {parent.key for parent in target_device_node.parents},
            {("conversation", "0098_merge_20260811_1945")},
        )
