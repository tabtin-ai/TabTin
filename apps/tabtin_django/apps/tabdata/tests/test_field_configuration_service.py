from dataclasses import dataclass
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

from django.test import SimpleTestCase

from apps.tabdata.services.field_configuration_service import (
    apply_field_configuration_change,
)
from apps.tabdata.services.collab_service import CollabService
from apps.tabdata.services.undo_redo_operation_service import UndoRedoOperationService


@dataclass
class StubField:
    id: UUID
    table_id: UUID
    field_type: str
    config: dict
    default_value: dict | None


class FieldConfigurationServiceTests(SimpleTestCase):
    def test_legacy_numeric_default_update_is_accepted_and_cleared(self):
        for field_type in ('percent', 'currency'):
            with self.subTest(field_type=field_type):
                field = StubField(
                    id=uuid4(),
                    table_id=uuid4(),
                    field_type=field_type,
                    config={},
                    default_value={'mode': 'literal', 'value': 50},
                )

                result = apply_field_configuration_change(
                    field,
                    default_value={'mode': 'literal', 'value': 100},
                )

                self.assertIsNone(field.default_value)
                self.assertTrue(result.default_changed)

    def test_select_config_only_change_reconciles_literal_default(self):
        field = StubField(
            id=uuid4(),
            table_id=uuid4(),
            field_type='select',
            config={'choices': [{'id': 'todo', 'value': 'Todo'}]},
            default_value={'mode': 'literal', 'value': 'Todo'},
        )

        result = apply_field_configuration_change(
            field,
            config={'choices': [{'id': 'todo', 'value': 'In progress'}]},
        )

        self.assertTrue(result.config_changed)
        self.assertTrue(result.default_changed)
        self.assertEqual(
            field.default_value,
            {'mode': 'literal', 'value': 'In progress'},
        )

    @patch('apps.tabdata.services.table_service.TableService')
    @patch('apps.tabdata.services.collab_service.TableField.objects')
    def test_collab_config_only_path_reconciles_repeated_old_default(
        self,
        field_objects,
        _table_service_cls,
    ):
        field_id = uuid4()
        field = MagicMock(
            id=field_id,
            is_deleted=False,
            name='状态',
            field_type='select',
            config={'choices': [{'id': 'todo', 'value': '待办'}]},
            default_value={'mode': 'literal', 'value': '待办'},
            order=0,
        )
        field_objects.using.return_value.filter.return_value = [field]

        changed = CollabService._persist_collab_fields(
            table=MagicMock(id=uuid4()),
            collab_fields=[{
                'id': str(field_id),
                'name': '状态',
                'field_type': 'select',
                'config': {'choices': [{'id': 'todo', 'value': '进行中'}]},
                'default_value': {'mode': 'literal', 'value': '待办'},
                'order': 0,
            }],
            editor_user=MagicMock(),
        )

        self.assertTrue(changed)
        self.assertEqual(
            field.default_value,
            {'mode': 'literal', 'value': '进行中'},
        )
        field.save.assert_called_once()

    @patch(
        'apps.tabdata.services.field_configuration_service.resolve_schema_partition_id',
        return_value=uuid4(),
    )
    @patch('apps.tabdata.services.field_configuration_service.DDLManager')
    @patch('apps.tabdata.services.field_configuration_service.Table.objects')
    def test_default_only_date_change_checks_actual_native_type(
        self,
        table_objects,
        ddl_manager_cls,
        _resolve_partition,
    ):
        field = StubField(
            id=uuid4(),
            table_id=uuid4(),
            field_type='date',
            config={
                'formatting': {
                    'time': 'HH:mm:ss',
                    'timeZone': 'Asia/Shanghai',
                }
            },
            default_value=None,
        )
        table_objects.using.return_value.get.return_value = object()
        ddl_manager_cls.return_value.alter_column_type.return_value = True

        result = apply_field_configuration_change(
            field,
            default_value={'mode': 'created_time'},
        )

        self.assertTrue(result.default_changed)
        self.assertTrue(result.native_type_changed)
        ddl_manager_cls.return_value.alter_column_type.assert_called_once_with(
            _resolve_partition.return_value,
            field.table_id,
            field.id,
            'date',
            'date',
            config=field.config,
            old_config=field.config,
        )

    @patch('apps.tabdata.services.table_service.TableService')
    @patch(
        'apps.tabdata.services.field_configuration_service.apply_field_configuration_change'
    )
    @patch('apps.tabdata.services.undo_redo_operation_service.TableField.objects')
    def test_undo_field_update_uses_shared_configuration_entry(
        self,
        field_objects,
        apply_configuration_change,
        _table_service_cls,
    ):
        field_id = uuid4()
        table_id = uuid4()
        field = MagicMock(
            id=field_id,
            table_id=table_id,
            name='状态',
            description='',
            order=0,
            width=150,
            is_primary=False,
            is_hidden=False,
        )
        field_objects.using.return_value.select_for_update.return_value.get.return_value = field
        payload = {
            'id': str(field_id),
            'table_id': str(table_id),
            'name': '状态',
            'config': {'choices': [{'id': 'todo', 'value': '进行中'}]},
            'default_value': {'mode': 'literal', 'value': '进行中'},
        }

        UndoRedoOperationService(user=MagicMock())._apply_updated_fields([payload])

        apply_configuration_change.assert_called_once_with(
            field,
            config=payload['config'],
            default_value=payload['default_value'],
        )
