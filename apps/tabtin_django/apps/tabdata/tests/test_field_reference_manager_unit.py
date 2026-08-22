import uuid
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.tabdata.services.cascade_service import FieldReferenceManager


class TestFieldReferenceManagerUnit(SimpleTestCase):
    def test_register_references_rejects_self_dependency(self):
        field_id = str(uuid.uuid4())
        with self.assertRaises(ValueError):
            FieldReferenceManager.register_references(
                to_field_id=field_id,
                from_field_ids=[field_id],
            )

    @patch('apps.tabdata.services.cascade_service.FieldReference.objects.filter')
    @patch('apps.tabdata.services.cascade_service.FieldReferenceManager._check_cycle_for_replace')
    def test_register_references_blocks_cycle_before_write(
        self,
        mock_check_cycle,
        mock_filter,
    ):
        mock_check_cycle.return_value = True

        with self.assertRaises(ValueError):
            FieldReferenceManager.register_references(
                to_field_id=str(uuid.uuid4()),
                from_field_ids=[str(uuid.uuid4())],
            )

        mock_filter.assert_not_called()

    @patch('apps.tabdata.services.cascade_service.has_cycle')
    @patch('apps.tabdata.services.cascade_service.FieldReference.objects.exclude')
    def test_check_cycle_for_replace_excludes_old_incoming_edges(
        self,
        mock_exclude,
        mock_has_cycle,
    ):
        to_uuid = uuid.uuid4()
        new_from = uuid.uuid4()
        other = uuid.uuid4()

        mock_exclude.return_value.values_list.return_value = [
            (to_uuid, other),      # 非 incoming 边，应该保留
        ]
        mock_has_cycle.return_value = False

        result = FieldReferenceManager._check_cycle_for_replace(
            to_field_id=to_uuid,
            from_field_ids=[new_from],
        )

        self.assertFalse(result)
        mock_exclude.assert_called_once_with(to_field_id=to_uuid)
        edges = mock_has_cycle.call_args.args[0]
        self.assertIn((str(to_uuid), str(other)), edges)
        self.assertIn((str(new_from), str(to_uuid)), edges)

    @patch('apps.tabdata.services.cascade_service.FieldReferenceManager._check_cycle_for_replace')
    def test_check_cycle_before_add_uses_replace_semantics(self, mock_check_cycle):
        mock_check_cycle.return_value = False
        to_id = str(uuid.uuid4())
        from_id = str(uuid.uuid4())

        result = FieldReferenceManager.check_cycle_before_add(
            to_field_id=to_id,
            from_field_ids=[from_id],
        )

        self.assertFalse(result)
        mock_check_cycle.assert_called_once()
