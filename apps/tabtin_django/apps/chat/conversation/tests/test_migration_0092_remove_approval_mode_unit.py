"""0092 approval_mode 兼容删除逻辑的无数据库回归测试。"""

from importlib import import_module
from unittest import TestCase
from unittest.mock import MagicMock


migration = import_module(
    "apps.chat.conversation.migrations.0092_remove_chatsession_approval_mode"
)


class RemoveChatSessionApprovalModeUnitTests(TestCase):
    def test_already_removed_column_is_a_noop(self) -> None:
        apps = MagicMock()
        schema_editor = MagicMock()
        cursor = schema_editor.connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = None

        migration.discard_and_remove_chatsession_approval_mode(apps, schema_editor)

        apps.get_model.assert_not_called()
        schema_editor.execute.assert_not_called()

    def test_existing_column_is_audited_then_removed(self) -> None:
        apps = MagicMock()
        schema_editor = MagicMock()
        cursor = schema_editor.connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = (1,)
        schema_editor.quote_name.side_effect = lambda name: f'"{name}"'
        distinct_values = (
            apps.get_model.return_value.objects.using.return_value.order_by.return_value
            .values_list.return_value.distinct.return_value
        )
        distinct_values.__iter__.return_value = iter(["always_ask", "full_access"])

        migration.discard_and_remove_chatsession_approval_mode(apps, schema_editor)

        schema_editor.execute.assert_called_once_with(
            'ALTER TABLE "chat_session" DROP COLUMN "approval_mode"'
        )
