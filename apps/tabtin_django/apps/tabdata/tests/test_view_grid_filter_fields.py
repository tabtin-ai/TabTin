"""filter_native_record_fields 字段过滤回归测试。

复现 GitHub ：网格以 field_key_type='id' 加载视图记录时，
编辑记录对话框读取的 `data`（始终按字段名输出）被错误地用 id 集合过滤、
整体清空，导致编辑对话框为空。
"""
from types import SimpleNamespace
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdata.services.view_grid_service import filter_native_record_fields


def _field(name, *, db_field_name=None):
    return SimpleNamespace(
        id=uuid4(),
        name=name,
        config={'db_field_name': db_field_name} if db_field_name else {},
    )


class FilterNativeRecordFieldsTests(SimpleTestCase):
    def _make_record(self, fields, *, key_type):
        """构造一条序列化记录：data 始终按字段名，fields 按 key_type。"""
        data = {f.name: f'val-{f.name}' for f in fields}
        if key_type == 'id':
            output_fields = {str(f.id): f'val-{f.name}' for f in fields}
        elif key_type == 'dbFieldName':
            output_fields = {
                str(f.config.get('db_field_name') or f.name): f'val-{f.name}'
                for f in fields
            }
        else:
            output_fields = {f.name: f'val-{f.name}' for f in fields}
        return {'data': dict(data), 'fields': dict(output_fields)}

    def test_id_key_type_preserves_name_keyed_data(self):
        """field_key_type='id' 时 data（按名）不应被 id 集合清空（ 根因）。"""
        f_title = _field('标题')
        f_num = _field('数字')
        all_fields = [f_title, f_num]

        record = self._make_record(all_fields, key_type='id')
        visible_ids = {str(f_title.id), str(f_num.id)}

        out = filter_native_record_fields(
            [record], visible_ids,
            all_fields=all_fields, field_key_type='id',
        )

        self.assertEqual(out[0]['data'], {'标题': 'val-标题', '数字': 'val-数字'})
        self.assertEqual(
            set(out[0]['fields'].keys()),
            {str(f_title.id), str(f_num.id)},
        )

    def test_id_key_type_filters_hidden_field_from_both(self):
        """仅可见字段保留：data 按名、fields 按 id 同步裁剪。"""
        f_title = _field('标题')
        f_hidden = _field('隐藏字段')
        all_fields = [f_title, f_hidden]

        record = self._make_record(all_fields, key_type='id')
        visible_ids = {str(f_title.id)}  # 隐藏 f_hidden

        out = filter_native_record_fields(
            [record], visible_ids,
            all_fields=all_fields, field_key_type='id',
        )

        self.assertEqual(out[0]['data'], {'标题': 'val-标题'})
        self.assertEqual(set(out[0]['fields'].keys()), {str(f_title.id)})

    def test_db_field_name_key_type_preserves_data(self):
        f = _field('标题', db_field_name='title_col')
        all_fields = [f]
        record = self._make_record(all_fields, key_type='dbFieldName')
        visible = {'title_col'}

        out = filter_native_record_fields(
            [record], visible,
            all_fields=all_fields, field_key_type='dbFieldName',
        )

        self.assertEqual(out[0]['data'], {'标题': 'val-标题'})
        self.assertEqual(set(out[0]['fields'].keys()), {'title_col'})

    def test_name_key_type_unchanged_behavior(self):
        """name 模式（默认）行为不变：data 与 fields 均按名过滤。"""
        f_title = _field('标题')
        f_num = _field('数字')
        all_fields = [f_title, f_num]
        record = self._make_record(all_fields, key_type='name')
        visible_names = {'标题'}

        out = filter_native_record_fields(
            [record], visible_names,
            all_fields=all_fields, field_key_type='name',
        )

        self.assertEqual(out[0]['data'], {'标题': 'val-标题'})
        self.assertEqual(set(out[0]['fields'].keys()), {'标题'})


class FilterHelperSharedReuseTests(SimpleTestCase):
    """helper 已抽到 utils/record_serializers，供视图 service + 单条 record API 复用。

    覆盖：canonical 位置可导入、单条 record API 走的 ``data_fields_set`` 显式路径、
    以及 ``build_record_data_field_names`` 的 id / dbFieldName 名称映射——避免
    同源 bug 在「单条记录读取」等其他入口换皮复发。
    """

    def test_importable_from_canonical_location(self):
        """从 utils/record_serializers 与 view_grid_service 拿到的是同一函数（再导出）。"""
        from apps.tabdata.utils.record_serializers import (
            filter_native_record_fields as canonical,
        )
        from apps.tabdata.services.view_grid_service import (
            filter_native_record_fields as reexported,
        )
        self.assertIs(canonical, reexported)

    def test_explicit_data_fields_set_filters_data_by_name(self):
        """单条 record API 路径：调用方已有字段名集合，显式传 data_fields_set。

        ``fields`` 仍按 id 过滤，``data``（按名）按显式名称集合过滤——id 集合不应
        把 name-keyed data 清空。
        """
        f_title = _field('标题')
        f_num = _field('数字')
        record = {
            'data': {'标题': 'val-标题', '数字': 'val-数字'},
            'fields': {str(f_title.id): 'val-标题', str(f_num.id): 'val-数字'},
        }
        visible_ids = {str(f_title.id)}  # 仅可见「标题」

        out = filter_native_record_fields(
            [record], visible_ids,
            data_fields_set={'标题'},
        )

        self.assertEqual(out[0]['data'], {'标题': 'val-标题'})
        self.assertEqual(set(out[0]['fields'].keys()), {str(f_title.id)})

    def test_build_data_field_names_id_and_db_field_name(self):
        from apps.tabdata.utils.record_serializers import build_record_data_field_names

        f_title = _field('标题', db_field_name='title_col')
        f_num = _field('数字')
        all_fields = [f_title, f_num]

        by_id = build_record_data_field_names(
            {str(f_title.id), str(f_num.id)},
            all_fields=all_fields, field_key_type='id',
        )
        self.assertEqual(by_id, {'标题', '数字'})

        by_db = build_record_data_field_names(
            {'title_col'}, all_fields=all_fields, field_key_type='dbFieldName',
        )
        self.assertEqual(by_db, {'标题'})

        # name 模式 / 缺 all_fields：原样返回，不做映射。
        self.assertEqual(
            build_record_data_field_names({'标题'}, all_fields=all_fields, field_key_type='name'),
            {'标题'},
        )
        self.assertEqual(
            build_record_data_field_names({'x'}, all_fields=None, field_key_type='id'),
            {'x'},
        )
