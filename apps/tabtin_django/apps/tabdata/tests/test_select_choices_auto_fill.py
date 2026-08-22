"""#5367: select/multi_select 写记录时自动补齐 options.choices。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdata.services.record_service import RecordService
from apps.tabdata.utils.choice_utils import (
    apply_select_choice_renames,
    build_select_choice_value_renames,
    extract_choice_values,
    iter_select_cell_values,
    merge_select_choice_values,
)


class TestChoiceUtilsMerge(SimpleTestCase):
    def test_iter_select_cell_values_single(self):
        self.assertEqual(iter_select_cell_values('进行中', 'select'), ['进行中'])
        self.assertEqual(iter_select_cell_values(None, 'select'), [])

    def test_iter_select_cell_values_multi(self):
        self.assertEqual(
            iter_select_cell_values(['A', 'B', 'A', ''], 'multi_select'),
            ['A', 'B'],
        )

    def test_merge_appends_new_values_and_keeps_colors(self):
        existing = [
            {'value': '待办', 'label': '待办', 'color': '#3B82F6'},
        ]
        merged = merge_select_choice_values(existing, ['进行中', '待办', '完成'])
        self.assertEqual([c['value'] for c in merged], ['待办', '进行中', '完成'])
        self.assertEqual(merged[0]['color'], '#3B82F6')
        self.assertEqual(extract_choice_values(merged), {'待办', '进行中', '完成'})

    def test_merge_respects_max_options(self):
        existing = [f'opt-{i}' for i in range(3)]
        merged = merge_select_choice_values(existing, ['a', 'b'], max_options=4)
        self.assertEqual(len(merged), 4)
        self.assertEqual(merged[-1]['value'], 'a')

    def test_build_renames_by_position_for_ui_string_edit(self):
        """#6330: 字段设置按行改文案时，同位旧值消失+新值新增 → rename。"""
        old = ['待处理', '进行中', '已完成']
        new = ['待处理', '处理中', '已完成']
        self.assertEqual(
            build_select_choice_value_renames(old, new),
            {'进行中': '处理中'},
        )

    def test_build_renames_ignores_reorder_and_pure_add_delete(self):
        self.assertEqual(
            build_select_choice_value_renames(['A', 'B', 'C'], ['B', 'A', 'C']),
            {},
        )
        self.assertEqual(
            build_select_choice_value_renames(['A', 'B'], ['A', 'B', 'C']),
            {},
        )
        self.assertEqual(
            build_select_choice_value_renames(['A', 'B', 'C'], ['A', 'C']),
            {},
        )

    def test_apply_select_choice_renames_single_and_multi(self):
        renames = {'进行中': '处理中'}
        self.assertEqual(
            apply_select_choice_renames('进行中', renames, 'select'),
            ('处理中', True),
        )
        self.assertEqual(
            apply_select_choice_renames('待处理', renames, 'select'),
            ('待处理', False),
        )
        self.assertEqual(
            apply_select_choice_renames(['进行中', '待处理'], renames, 'multi_select'),
            (['处理中', '待处理'], True),
        )


class TestEnsureSelectChoicesFromData(SimpleTestCase):
    def test_empty_select_field_gains_choices_from_record(self):
        field_id = uuid4()
        field = SimpleNamespace(
            id=field_id,
            name='状态',
            field_type='select',
            config={},
            updated_at=None,
        )
        svc = RecordService(user=MagicMock(id='user-1'))
        svc._build_field_input_maps = MagicMock(
            return_value=(
                {'状态': field},
                {str(field_id): field},
                {},
            )
        )

        with patch(
            'apps.tabdata.services.record_service.TableField.objects'
        ) as mock_objects:
            using = mock_objects.using.return_value
            svc._ensure_select_choices_from_data(
                [field],
                [{'状态': '进行中'}, {'状态': '已完成'}],
            )
            using.bulk_update.assert_called_once()
            dirty = using.bulk_update.call_args[0][0]
            self.assertEqual(len(dirty), 1)
            choices = dirty[0].config['choices']
            self.assertEqual(
                [c['value'] for c in choices],
                ['进行中', '已完成'],
            )

    def test_multi_select_merges_list_values(self):
        field_id = uuid4()
        field = SimpleNamespace(
            id=field_id,
            name='标签',
            field_type='multi_select',
            config={'choices': [{'value': '已有', 'label': '已有', 'color': '#22C55E'}]},
            updated_at=None,
        )
        svc = RecordService(user=MagicMock(id='user-1'))
        svc._build_field_input_maps = MagicMock(
            return_value=(
                {'标签': field},
                {str(field_id): field},
                {},
            )
        )

        with patch(
            'apps.tabdata.services.record_service.TableField.objects'
        ) as mock_objects:
            using = mock_objects.using.return_value
            svc._ensure_select_choices_from_data(
                [field],
                [{'标签': ['已有', '新标签']}],
            )
            using.bulk_update.assert_called_once()
            values = [c['value'] for c in field.config['choices']]
            self.assertEqual(values, ['已有', '新标签'])
            self.assertEqual(field.config['choices'][0]['color'], '#22C55E')

    def test_noop_when_all_values_already_present(self):
        field_id = uuid4()
        field = SimpleNamespace(
            id=field_id,
            name='状态',
            field_type='select',
            config={'choices': [{'value': 'A', 'label': 'A', 'color': '#3B82F6'}]},
            updated_at=None,
        )
        svc = RecordService(user=MagicMock(id='user-1'))
        svc._build_field_input_maps = MagicMock(
            return_value=({'状态': field}, {str(field_id): field}, {})
        )

        with patch(
            'apps.tabdata.services.record_service.TableField.objects'
        ) as mock_objects:
            svc._ensure_select_choices_from_data([field], [{'状态': 'A'}])
            mock_objects.using.return_value.bulk_update.assert_not_called()

    def test_deferred_mode_updates_validation_snapshot_without_writing_field(self):
        field_id = uuid4()
        field = SimpleNamespace(
            id=field_id,
            name='状态',
            field_type='select',
            config={},
            updated_at=None,
        )
        svc = RecordService(user=MagicMock(id='user-1'))
        svc._build_field_input_maps = MagicMock(
            return_value=({'状态': field}, {str(field_id): field}, {})
        )

        with patch(
            'apps.tabdata.services.record_service.TableField.objects'
        ) as mock_objects:
            pending = svc._ensure_select_choices_from_data(
                [field],
                [{'状态': '进行中'}],
                persist=False,
            )

        self.assertEqual(pending, {str(field_id): ['进行中']})
        self.assertEqual(
            [choice['value'] for choice in field.config['choices']],
            ['进行中'],
        )
        mock_objects.using.return_value.bulk_update.assert_not_called()
