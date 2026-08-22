from dataclasses import dataclass
from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.tabdata.utils.view_serializers import build_view_column_meta, parse_view_column_meta


@dataclass
class _FakeField:
    id: str
    name: str


class ViewSerializersTestCase(SimpleTestCase):
    def test_build_view_column_meta_respects_visibility_order_and_width(self):
        fields = [
            _FakeField(id='fld_title', name='Title'),
            _FakeField(id='fld_status', name='Status'),
            _FakeField(id='fld_owner', name='Owner'),
        ]
        view = SimpleNamespace(
            view_type='grid',
            visible_fields=['fld_title', 'fld_owner'],
            field_order=['fld_owner', 'fld_status', 'fld_title'],
            config={'column_widths': {'fld_title': 220}},
        )

        column_meta = build_view_column_meta(view, table_fields=fields)

        self.assertEqual(list(column_meta.keys()), ['fld_owner', 'fld_status', 'fld_title'])
        self.assertEqual(column_meta['fld_owner'], {'order': 0})
        self.assertEqual(column_meta['fld_status'], {'order': 1, 'hidden': True})
        self.assertEqual(column_meta['fld_title'], {'order': 2, 'width': 220})

    def test_parse_view_column_meta_full_payload(self):
        fields = [
            _FakeField(id='fld_title', name='Title'),
            _FakeField(id='fld_status', name='Status'),
            _FakeField(id='fld_owner', name='Owner'),
        ]
        incoming_column_meta = {
            'fld_title': {'order': 2, 'visible': True, 'width': 180},
            'fld_status': {'order': 0, 'hidden': True},
            'fld_owner': {'order': 1, 'visible': True},
        }

        parsed = parse_view_column_meta(
            incoming_column_meta,
            table_fields=fields,
            view_type='grid',
        )

        self.assertEqual(parsed['field_order'], ['fld_status', 'fld_owner', 'fld_title'])
        self.assertEqual(parsed['visible_fields'], ['fld_owner', 'fld_title'])
        self.assertEqual(parsed['column_widths'], {'fld_title': 180})
        self.assertEqual(parsed['column_meta_ext'], {})
        self.assertEqual(parsed['column_meta']['fld_status'], {'order': 0, 'hidden': True})
        self.assertEqual(parsed['column_meta']['fld_title'], {'order': 2, 'width': 180})

    def test_parse_view_column_meta_merges_partial_patch(self):
        fields = [
            _FakeField(id='fld_title', name='Title'),
            _FakeField(id='fld_status', name='Status'),
            _FakeField(id='fld_owner', name='Owner'),
        ]
        base_view = SimpleNamespace(
            view_type='grid',
            visible_fields=['fld_title', 'fld_owner'],
            field_order=['fld_owner', 'fld_status', 'fld_title'],
            config={'column_widths': {'fld_title': 160}},
        )
        base_column_meta = build_view_column_meta(base_view, table_fields=fields)

        parsed = parse_view_column_meta(
            {'fld_status': {'width': 240}},
            table_fields=fields,
            base_column_meta=base_column_meta,
            view_type='grid',
        )

        self.assertEqual(parsed['field_order'], ['fld_owner', 'fld_status', 'fld_title'])
        self.assertEqual(parsed['visible_fields'], ['fld_owner', 'fld_title'])
        self.assertEqual(parsed['column_widths'], {'fld_title': 160, 'fld_status': 240})
        self.assertEqual(parsed['column_meta_ext'], {})

    def test_parse_view_column_meta_supports_field_name_keys(self):
        fields = [
            _FakeField(id='fld_title', name='Title'),
            _FakeField(id='fld_status', name='Status'),
            _FakeField(id='fld_owner', name='Owner'),
        ]

        parsed = parse_view_column_meta(
            {
                'Title': {'order': 1, 'width': 200},
                'Status': {'order': 0, 'hidden': True},
            },
            table_fields=fields,
            view_type='grid',
        )

        self.assertEqual(parsed['field_order'], ['fld_status', 'fld_title', 'fld_owner'])
        self.assertEqual(parsed['visible_fields'], ['fld_title', 'fld_owner'])
        self.assertEqual(parsed['column_widths'], {'fld_title': 200})
        self.assertEqual(parsed['column_meta_ext'], {})

    def test_build_view_column_meta_for_kanban_uses_visible_semantic(self):
        fields = [
            _FakeField(id='fld_title', name='Title'),
            _FakeField(id='fld_status', name='Status'),
            _FakeField(id='fld_owner', name='Owner'),
        ]
        view = SimpleNamespace(
            view_type='kanban',
            visible_fields=['fld_title', 'fld_owner'],
            field_order=['fld_owner', 'fld_status', 'fld_title'],
            config={},
        )

        column_meta = build_view_column_meta(view, table_fields=fields)

        self.assertEqual(column_meta['fld_owner'], {'order': 0, 'visible': True})
        self.assertEqual(column_meta['fld_status'], {'order': 1, 'visible': False})
        self.assertEqual(column_meta['fld_title'], {'order': 2, 'visible': True})

    def test_parse_view_column_meta_for_kanban_prefers_visible_semantic(self):
        fields = [
            _FakeField(id='fld_title', name='Title'),
            _FakeField(id='fld_status', name='Status'),
            _FakeField(id='fld_owner', name='Owner'),
        ]
        parsed = parse_view_column_meta(
            {
                'fld_title': {'order': 1, 'visible': True},
                'fld_status': {'order': 0, 'visible': False},
                'fld_owner': {'order': 2},
            },
            table_fields=fields,
            view_type='kanban',
        )

        self.assertEqual(parsed['field_order'], ['fld_status', 'fld_title', 'fld_owner'])
        self.assertEqual(parsed['visible_fields'], ['fld_title', 'fld_owner'])
        self.assertEqual(parsed['column_meta_ext'], {})

    def test_parse_view_column_meta_retains_extension_properties(self):
        fields = [
            _FakeField(id='fld_title', name='Title'),
            _FakeField(id='fld_status', name='Status'),
            _FakeField(id='fld_owner', name='Owner'),
        ]
        incoming_column_meta = {
            'fld_title': {'order': 2, 'visible': True, 'width': 180, 'statisticFunc': 'sum'},
            'fld_status': {'order': 0, 'hidden': True, 'customFlag': True},
            'fld_owner': {'order': 1, 'visible': True},
        }

        parsed = parse_view_column_meta(
            incoming_column_meta,
            table_fields=fields,
            view_type='grid',
        )

        self.assertEqual(
            parsed['column_meta_ext'],
            {
                'fld_title': {'statisticFunc': 'sum'},
                'fld_status': {'customFlag': True},
            },
        )

    def test_build_view_column_meta_merges_extension_properties_from_config(self):
        fields = [
            _FakeField(id='fld_title', name='Title'),
            _FakeField(id='fld_status', name='Status'),
            _FakeField(id='fld_owner', name='Owner'),
        ]
        view = SimpleNamespace(
            view_type='grid',
            visible_fields=['fld_title', 'fld_owner'],
            field_order=['fld_owner', 'fld_status', 'fld_title'],
            config={
                'column_widths': {'fld_title': 220},
                'column_meta_ext': {
                    'fld_title': {'statisticFunc': 'sum'},
                    'Status': {'customFlag': True},
                },
            },
        )

        column_meta = build_view_column_meta(view, table_fields=fields)

        self.assertEqual(column_meta['fld_title']['statisticFunc'], 'sum')
        self.assertEqual(column_meta['fld_status']['customFlag'], True)

    def test_build_view_column_meta_prefers_persisted_column_meta(self):
        fields = [
            _FakeField(id='fld_title', name='Title'),
            _FakeField(id='fld_status', name='Status'),
            _FakeField(id='fld_owner', name='Owner'),
        ]
        view = SimpleNamespace(
            view_type='grid',
            visible_fields=['fld_title', 'fld_owner'],
            field_order=['fld_owner', 'fld_status', 'fld_title'],
            column_meta={
                'fld_status': {'order': 0, 'hidden': True},
                'fld_title': {'order': 1, 'width': 260},
            },
            config={'column_widths': {'fld_title': 180}},
        )

        column_meta = build_view_column_meta(view, table_fields=fields)

        self.assertEqual(list(column_meta.keys()), ['fld_status', 'fld_owner', 'fld_title'])
        self.assertEqual(column_meta['fld_status']['hidden'], True)
        self.assertEqual(column_meta['fld_title']['width'], 260)
