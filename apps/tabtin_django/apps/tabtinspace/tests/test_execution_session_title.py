"""任务执行会话默认标题：首次固定「执行」，后续走可自动生成的默认标题。"""

from unittest import TestCase
from unittest.mock import MagicMock, patch

from apps.tabtinspace.services.project_task_runtime import build_execution_session_title


class BuildExecutionSessionTitleTests(TestCase):
    def test_first_session_uses_fixed_execution_label(self):
        task = MagicMock(id='task-1')
        with patch(
            'apps.tabtinspace.models.ProjectTaskRun.objects.filter',
        ) as filter_mock:
            filter_mock.return_value.exclude.return_value.exists.return_value = False
            filter_mock.return_value.exists.return_value = False
            self.assertEqual(build_execution_session_title(task, run_id='run-1'), '执行')

    def test_subsequent_session_uses_platform_default_title(self):
        task = MagicMock(id='task-1')
        with patch(
            'apps.tabtinspace.models.ProjectTaskRun.objects.filter',
        ) as filter_mock, patch(
            'apps.chat.conversation.services.title_generator.default_session_title',
            return_value='新任务',
        ):
            qs = filter_mock.return_value.exclude.return_value
            qs.exists.return_value = True
            self.assertEqual(build_execution_session_title(task, run_id='run-2'), '新任务')
