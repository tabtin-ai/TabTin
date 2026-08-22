"""
视图配置验证器

提供对不同视图类型的配置进行验证，确保配置合法性
"""
from typing import Dict, Any, Tuple, List, Optional
from uuid import UUID

from apps.tabdata.constants import FILE_BASED_FIELD_TYPES, TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField


class ViewConfigValidator:
    """视图配置验证器"""

    @staticmethod
    def _suggest_title_field(fields) -> Optional[str]:
        """
        为展示标题推荐字段；仅作为建议，不参与视图可用性判定。
        优先级：primary -> text -> 第一个可用字段。
        """
        primary_field = fields.filter(is_primary=True).first()
        if primary_field:
            return str(primary_field.id)

        text_field = fields.filter(field_type='text').first()
        if text_field:
            return str(text_field.id)

        first_field = fields.first()
        if first_field:
            return str(first_field.id)

        return None

    @staticmethod
    def validate(table: Table, view_type: str, config: Dict[str, Any], strict: bool = True) -> Tuple[bool, List[str], List[str]]:
        """
        验证视图配置

        Args:
            table: 表格对象
            view_type: 视图类型
            config: 配置字典
            strict: 严格模式（True=编辑时校验，False=创建时允许缺失必填字段）

        Returns:
            (是否合法, 错误列表, 警告列表)
        """
        config = config or {}
        if view_type == 'kanban':
            return ViewConfigValidator.validate_kanban_config(table, config, strict=strict)
        elif view_type == 'calendar':
            return ViewConfigValidator.validate_calendar_config(table, config, strict=strict)
        elif view_type == 'gallery':
            return ViewConfigValidator.validate_gallery_config(table, config, strict=strict)
        elif view_type == 'flashcard':
            return ViewConfigValidator.validate_flashcard_config(table, config, strict=strict)
        elif view_type == 'list':
            return ViewConfigValidator.validate_list_config(table, config)
        elif view_type == 'grid':
            return ViewConfigValidator.validate_grid_config(table, config)
        elif view_type == 'form':
            return ViewConfigValidator.validate_form_config(table, config, strict=strict)
        else:
            return False, [f"不支持的视图类型: {view_type}"], []

    @staticmethod
    def validate_grid_config(table: Table, config: Dict[str, Any]) -> Tuple[bool, List[str], List[str]]:
        """
        验证表格视图配置

        Args:
            table: 表格对象
            config: 配置字典

        Returns:
            (是否合法, 错误列表, 警告列表)
        """
        # 表格视图配置较简单，通常无需验证
        return True, [], []

    @staticmethod
    def validate_list_config(table: Table, config: Dict[str, Any]) -> Tuple[bool, List[str], List[str]]:
        """
        验证列表视图配置

        Args:
            table: 表格对象
            config: 配置字典

        Returns:
            (是否合法, 错误列表, 警告列表)
        """
        # 列表视图目前不强制任何额外配置，复用网格视图的字段展示即可
        return True, [], []

    @staticmethod
    def validate_kanban_config(table: Table, config: Dict[str, Any], strict: bool = True) -> Tuple[bool, List[str], List[str]]:
        """
        验证看板视图配置

        必填字段:
        - group_by_field: 分组字段ID（必须是非文件型有效字段；排除 attachment）
        - card_title_field: 卡片标题字段ID

        可选字段:
        - card_cover_field: 卡片封面字段ID（附件或URL类型）
        - visible_fields: 可见字段列表
        - card_color_by: 卡片颜色依据字段ID
        - collapsed_columns: 折叠的列列表
        - column_stats: 列统计配置

        Args:
            table: 表格对象
            config: 配置字典
            strict: 严格模式，False 时必填字段缺失仅产生 warning

        Returns:
            (是否合法, 错误列表, 警告列表)
        """
        errors = []
        warnings = []

        # 检查必填字段
        if not config.get('group_by_field'):
            if strict:
                errors.append("看板视图必须指定 group_by_field（分组字段）")
                return False, errors, warnings
            else:
                warnings.append("看板视图缺少 group_by_field（分组字段），需后续配置")
                return True, errors, warnings

        if not config.get('card_title_field'):
            if strict:
                errors.append("看板视图必须指定 card_title_field（卡片标题字段）")
                return False, errors, warnings
            else:
                warnings.append("看板视图缺少 card_title_field（卡片标题字段），需后续配置")

        try:
            group_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                id=config['group_by_field'],
                table=table,
                is_deleted=False
            )
            disallowed_types = list(FILE_BASED_FIELD_TYPES)
            if group_field.field_type in disallowed_types:
                errors.append(f"分组字段 '{group_field.name}' 不能是 {group_field.field_type} 类型")
        except TableField.DoesNotExist:
            errors.append(f"分组字段ID '{config['group_by_field']}' 不存在或已删除")

        # 验证 card_title_field 存在；lenient 创建允许暂缺，不能继续下标读取。
        title_field_id = config.get('card_title_field')
        if title_field_id:
            try:
                TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=title_field_id,
                    table=table,
                    is_deleted=False
                )
            except TableField.DoesNotExist:
                errors.append(f"标题字段ID '{title_field_id}' 不存在或已删除")

        # 验证 card_cover_field（如果提供）
        if config.get('card_cover_field'):
            try:
                cover_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['card_cover_field'],
                    table=table,
                    is_deleted=False
                )
                if cover_field.field_type not in (*FILE_BASED_FIELD_TYPES, 'url'):
                    warnings.append(f"封面字段 '{cover_field.name}' 建议使用附件(attachment)或URL类型，当前是 {cover_field.field_type}")
            except TableField.DoesNotExist:
                errors.append(f"封面字段ID '{config['card_cover_field']}' 不存在或已删除")
        else:
            warnings.append("未配置 card_cover_field，卡片将不显示封面")

        # 验证 visible_fields（如果提供）
        if config.get('visible_fields'):
            if not isinstance(config['visible_fields'], list):
                errors.append("visible_fields 必须是字段ID列表")
            else:
                for field_id in config['visible_fields']:
                    try:
                        TableField.objects.using(TABDATA_DB_ALIAS).get(
                            id=field_id,
                            table=table,
                            is_deleted=False
                        )
                    except TableField.DoesNotExist:
                        errors.append(f"可见字段ID '{field_id}' 不存在或已删除")

        # 验证 card_color_by（如果提供）
        if config.get('card_color_by'):
            try:
                color_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['card_color_by'],
                    table=table,
                    is_deleted=False
                )
                if color_field.field_type not in ['select', 'multi_select']:
                    warnings.append(f"颜色字段 '{color_field.name}' 建议使用单选或多选类型，当前是 {color_field.field_type}")
            except TableField.DoesNotExist:
                errors.append(f"颜色字段ID '{config['card_color_by']}' 不存在或已删除")

        return len(errors) == 0, errors, warnings

    @staticmethod
    def validate_calendar_config(table: Table, config: Dict[str, Any], strict: bool = True) -> Tuple[bool, List[str], List[str]]:
        """
        验证日历视图配置

        必填字段:
        - date_field: 日期字段ID

        可选字段:
        - title_field: 标题字段ID
        - end_date_field: 结束日期字段ID
        - color_by_field: 事件颜色依据字段ID
        - default_view_mode: 默认视图模式（month/week/day/agenda）
        - show_weekends: 是否显示周末
        - first_day_of_week: 每周第一天（0=周日，1=周一）
        - time_format: 时间格式（12h/24h）
        - show_time: 是否显示时间
        - event_display_fields: 事件显示字段列表

        Args:
            table: 表格对象
            config: 配置字典
            strict: 严格模式，False 时必填字段缺失仅产生 warning

        Returns:
            (是否合法, 错误列表, 警告列表)
        """
        errors = []
        warnings = []

        # 检查必填字段
        if not config.get('date_field'):
            if strict:
                errors.append("日历视图必须指定 date_field（日期字段）")
                return False, errors, warnings
            else:
                warnings.append("日历视图缺少 date_field（日期字段），需后续配置")
                return True, errors, warnings

        # 验证 date_field 必须是日期字段
        try:
            date_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                id=config['date_field'],
                table=table,
                is_deleted=False
            )
            if date_field.field_type != 'date':
                errors.append(f"日期字段 '{date_field.name}' 必须是日期(date)类型，当前是 {date_field.field_type}")
        except (ValueError, TypeError, TableField.DoesNotExist):
            errors.append(f"日期字段ID '{config['date_field']}' 不存在或已删除")

        # 验证 end_date_field（如果提供）
        if config.get('end_date_field'):
            try:
                end_date_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['end_date_field'],
                    table=table,
                    is_deleted=False
                )
                if end_date_field.field_type != 'date':
                    errors.append(f"结束日期字段 '{end_date_field.name}' 必须是日期(date)类型，当前是 {end_date_field.field_type}")

                # 检查日期字段类型是否匹配
                if 'date_field' in locals():
                    if date_field.field_type != end_date_field.field_type:
                        warnings.append(f"开始日期字段({date_field.field_type})和结束日期字段({end_date_field.field_type})类型不匹配，可能导致显示问题")
            except (ValueError, TypeError, TableField.DoesNotExist):
                errors.append(f"结束日期字段ID '{config['end_date_field']}' 不存在或已删除")
        else:
            warnings.append("未配置 end_date_field，所有事件将显示为单日事件")

        # title_field 是展示配置；只有显式提供时才校验字段合法性。
        if config.get('title_field'):
            try:
                TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['title_field'],
                    table=table,
                    is_deleted=False
                )
            except (ValueError, TypeError, TableField.DoesNotExist):
                errors.append(f"标题字段ID '{config['title_field']}' 不存在或已删除")

        # 验证 color_by_field（如果提供）
        if config.get('color_by_field'):
            try:
                color_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['color_by_field'],
                    table=table,
                    is_deleted=False
                )
                if color_field.field_type not in ['select', 'multi_select']:
                    warnings.append(f"颜色字段 '{color_field.name}' 建议使用单选或多选类型，当前是 {color_field.field_type}")
            except (ValueError, TypeError, TableField.DoesNotExist):
                errors.append(f"颜色字段ID '{config['color_by_field']}' 不存在或已删除")

        # 验证 default_view_mode（如果提供）
        if config.get('default_view_mode'):
            valid_modes = ['month', 'week', 'day', 'agenda']
            if config['default_view_mode'] not in valid_modes:
                errors.append(f"default_view_mode 必须是 {valid_modes} 之一，当前是 {config['default_view_mode']}")

        # 验证 first_day_of_week（如果提供）
        if config.get('first_day_of_week') is not None:
            if config['first_day_of_week'] not in [0, 1]:
                errors.append(f"first_day_of_week 必须是 0（周日）或 1（周一），当前是 {config['first_day_of_week']}")

        # 验证 time_format（如果提供）
        if config.get('time_format'):
            if config['time_format'] not in ['12h', '24h']:
                errors.append(f"time_format 必须是 '12h' 或 '24h'，当前是 {config['time_format']}")

        # 验证 event_display_fields（如果提供）
        if config.get('event_display_fields'):
            if not isinstance(config['event_display_fields'], list):
                errors.append("event_display_fields 必须是字段ID列表")
            else:
                for field_id in config['event_display_fields']:
                    try:
                        TableField.objects.using(TABDATA_DB_ALIAS).get(
                            id=field_id,
                            table=table,
                            is_deleted=False
                        )
                    except TableField.DoesNotExist:
                        errors.append(f"事件显示字段ID '{field_id}' 不存在或已删除")

        return len(errors) == 0, errors, warnings

    @staticmethod
    def validate_gallery_config(table: Table, config: Dict[str, Any], strict: bool = True) -> Tuple[bool, List[str], List[str]]:
        """
        验证画廊视图配置

        可选字段:
        - title_field: 标题字段ID
        - card_size: 卡片大小（small/medium/large）
        - card_aspect_ratio: 卡片纵横比（1:1/4:3/16:9/custom）
        - cover_field: 封面字段ID（附件或URL类型）
        - cover_fit: 封面适配方式（cover/contain/fill）
        - description_field: 描述字段ID
        - visible_fields: 可见字段列表
        - cards_per_row: 每行卡片数（auto/2/3/4/5）
        - show_record_count: 是否显示记录总数
        - enable_lightbox: 是否启用灯箱预览

        Args:
            table: 表格对象
            config: 配置字典
            strict: 严格模式，False 时必填字段缺失仅产生 warning

        Returns:
            (是否合法, 错误列表, 警告列表)
        """
        errors = []
        warnings = []

        # title_field 是展示配置；只有显式提供时才校验字段合法性。
        if config.get('title_field'):
            try:
                TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['title_field'],
                    table=table,
                    is_deleted=False
                )
            except (ValueError, TypeError, TableField.DoesNotExist):
                errors.append(f"标题字段ID '{config['title_field']}' 不存在或已删除")

        # 验证 cover_field（如果提供）
        if config.get('cover_field'):
            try:
                cover_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['cover_field'],
                    table=table,
                    is_deleted=False
                )
                if cover_field.field_type not in (*FILE_BASED_FIELD_TYPES, 'url'):
                    warnings.append(f"封面字段 '{cover_field.name}' 建议使用附件(attachment)或URL类型，当前是 {cover_field.field_type}")
            except (ValueError, TypeError, TableField.DoesNotExist):
                errors.append(f"封面字段ID '{config['cover_field']}' 不存在或已删除")
        else:
            warnings.append("未配置 cover_field，卡片将显示默认占位图")

        # 验证 description_field（如果提供）
        if config.get('description_field'):
            try:
                desc_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['description_field'],
                    table=table,
                    is_deleted=False
                )
            except (ValueError, TypeError, TableField.DoesNotExist):
                errors.append(f"描述字段ID '{config['description_field']}' 不存在或已删除")

        # 验证 visible_fields（如果提供）
        if config.get('visible_fields'):
            if not isinstance(config['visible_fields'], list):
                errors.append("visible_fields 必须是字段ID列表")
            else:
                for field_id in config['visible_fields']:
                    try:
                        TableField.objects.using(TABDATA_DB_ALIAS).get(
                            id=field_id,
                            table=table,
                            is_deleted=False
                        )
                    except (ValueError, TypeError, TableField.DoesNotExist):
                        errors.append(f"可见字段ID '{field_id}' 不存在或已删除")

        # 验证 card_size（如果提供）
        if config.get('card_size'):
            valid_sizes = ['small', 'medium', 'large']
            if config['card_size'] not in valid_sizes:
                errors.append(f"card_size 必须是 {valid_sizes} 之一，当前是 {config['card_size']}")

        # 验证 card_aspect_ratio（如果提供）
        if config.get('card_aspect_ratio'):
            valid_ratios = ['1:1', '4:3', '16:9', 'custom']
            if config['card_aspect_ratio'] not in valid_ratios:
                errors.append(f"card_aspect_ratio 必须是 {valid_ratios} 之一，当前是 {config['card_aspect_ratio']}")

        # 验证 cover_fit（如果提供）
        if config.get('cover_fit'):
            valid_fits = ['cover', 'contain', 'fill']
            if config['cover_fit'] not in valid_fits:
                errors.append(f"cover_fit 必须是 {valid_fits} 之一，当前是 {config['cover_fit']}")

        # 验证 cards_per_row（如果提供）
        if config.get('cards_per_row'):
            valid_values = ['auto', '2', '3', '4', '5', 2, 3, 4, 5]
            if config['cards_per_row'] not in valid_values:
                errors.append(f"cards_per_row 必须是 'auto' 或 2-5 之间的数字，当前是 {config['cards_per_row']}")

        return len(errors) == 0, errors, warnings

    @staticmethod
    def validate_flashcard_config(table: Table, config: Dict[str, Any], strict: bool = True) -> Tuple[bool, List[str], List[str]]:
        """
        验证闪卡视图配置

        必填字段:
        - front_field: 正面字段ID（问题/概念）
        - back_field: 背面字段ID（答案/解释）

        可选字段:
        - mastery_field: 掌握度字段ID（checkbox 类型）
        - tags_field: 标签字段ID
        - auto_shuffle: 是否自动打乱顺序
        - show_progress: 是否显示进度条
        """
        errors: List[str] = []
        warnings: List[str] = []

        if not config.get('front_field'):
            if strict:
                errors.append("闪卡视图必须指定 front_field（正面字段）")
                return False, errors, warnings
            else:
                warnings.append("闪卡视图缺少 front_field（正面字段），需后续配置")
                return True, errors, warnings

        if not config.get('back_field'):
            if strict:
                errors.append("闪卡视图必须指定 back_field（背面字段）")
                return False, errors, warnings
            else:
                warnings.append("闪卡视图缺少 back_field（背面字段），需后续配置")

        # 验证 front_field 存在
        if config.get('front_field'):
            try:
                TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['front_field'], table=table, is_deleted=False,
                )
            except TableField.DoesNotExist:
                errors.append(f"正面字段ID '{config['front_field']}' 不存在或已删除")

        # 验证 back_field 存在
        if config.get('back_field'):
            try:
                TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['back_field'], table=table, is_deleted=False,
                )
            except TableField.DoesNotExist:
                errors.append(f"背面字段ID '{config['back_field']}' 不存在或已删除")

        if config.get('front_field') and config.get('back_field'):
            if config['front_field'] == config['back_field']:
                errors.append("正面字段和背面字段不能相同")

        # 验证 mastery_field（可选，需为 checkbox 类型）
        if config.get('mastery_field'):
            try:
                mastery_field = TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['mastery_field'], table=table, is_deleted=False,
                )
                if mastery_field.field_type != 'checkbox':
                    warnings.append(
                        f"掌握度字段 '{mastery_field.name}' 建议使用 checkbox 类型，"
                        f"当前是 {mastery_field.field_type}"
                    )
            except TableField.DoesNotExist:
                errors.append(f"掌握度字段ID '{config['mastery_field']}' 不存在或已删除")

        # 验证 tags_field（可选）
        if config.get('tags_field'):
            try:
                TableField.objects.using(TABDATA_DB_ALIAS).get(
                    id=config['tags_field'], table=table, is_deleted=False,
                )
            except TableField.DoesNotExist:
                errors.append(f"标签字段ID '{config['tags_field']}' 不存在或已删除")

        return len(errors) == 0, errors, warnings

    @staticmethod
    def validate_form_config(table: Table, config: Dict[str, Any], strict: bool = True) -> Tuple[bool, List[str], List[str]]:
        """
        验证表单视图配置

        可选字段:
        - title: 表单标题（默认使用视图名称）
        - description: 表单描述
        - cover_url: 封面图片URL
        - submit_label: 提交按钮文字（默认"提交"）
        - success_message: 提交成功提示语
        - redirect_url: 提交后跳转URL
        - allow_multiple_submit: 是否允许多次提交
        - login_required: 是否要求登录
        - field_configs: 各字段的表单配置 { field_id: { description, default_value } }
        """
        errors: List[str] = []
        warnings: List[str] = []

        if config.get('submit_label') and len(str(config['submit_label'])) > 50:
            errors.append("submit_label 长度不能超过50字符")

        if config.get('success_message') and len(str(config['success_message'])) > 500:
            errors.append("success_message 长度不能超过500字符")

        if config.get('redirect_url'):
            url = str(config['redirect_url'])
            if not url.startswith(('http://', 'https://')):
                errors.append("redirect_url 必须以 http:// 或 https:// 开头")

        field_configs = config.get('field_configs')
        if field_configs:
            if not isinstance(field_configs, dict):
                errors.append("field_configs 必须是字典格式")
            else:
                for field_id, fc in field_configs.items():
                    if not isinstance(fc, dict):
                        errors.append(f"field_configs['{field_id}'] 必须是字典格式")
                        continue
                    try:
                        TableField.objects.using(TABDATA_DB_ALIAS).get(
                            id=field_id, table=table, is_deleted=False,
                        )
                    except TableField.DoesNotExist:
                        errors.append(f"字段ID '{field_id}' 不存在或已删除")

        if not config.get('title') and not config.get('description'):
            warnings.append("建议配置表单标题(title)或描述(description)以帮助填写者理解表单用途")

        return len(errors) == 0, errors, warnings

    @staticmethod
    def get_config_suggestions(table: Table, view_type: str) -> Dict[str, Any]:
        """
        根据表格字段，提供视图配置建议

        Args:
            table: 表格对象
            view_type: 视图类型

        Returns:
            配置建议字典
        """
        suggestions = {}
        fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(table=table, is_deleted=False).order_by('order')

        if view_type == 'kanban':
            # 推荐第一个单选字段作为分组依据
            select_fields = fields.filter(field_type='select')
            if select_fields.exists():
                suggestions['group_by_field'] = str(select_fields.first().id)

            # 推荐主字段作为标题
            primary_field = fields.filter(is_primary=True).first()
            if primary_field:
                suggestions['card_title_field'] = str(primary_field.id)
            else:
                # 推荐第一个文本字段
                text_field = fields.filter(field_type__in=['text']).first()
                if text_field:
                    suggestions['card_title_field'] = str(text_field.id)

            # 推荐附件字段作为封面
            attachment_field = fields.filter(field_type__in=FILE_BASED_FIELD_TYPES).first()
            if attachment_field:
                suggestions['card_cover_field'] = str(attachment_field.id)

        elif view_type == 'calendar':
            # 推荐第一个日期字段
            date_fields = fields.filter(field_type='date')
            if date_fields.exists():
                suggestions['date_field'] = str(date_fields.first().id)
                if date_fields.count() > 1:
                    suggestions['end_date_field'] = str(date_fields[1].id)

            title_field = ViewConfigValidator._suggest_title_field(fields)
            if title_field:
                suggestions['title_field'] = title_field

            # 推荐单选字段作为颜色依据
            select_field = fields.filter(field_type='select').first()
            if select_field:
                suggestions['color_by_field'] = str(select_field.id)

        elif view_type == 'gallery':
            title_field = ViewConfigValidator._suggest_title_field(fields)
            if title_field:
                suggestions['title_field'] = title_field

            # 推荐附件字段作为封面
            attachment_field = fields.filter(field_type__in=FILE_BASED_FIELD_TYPES).first()
            if attachment_field:
                suggestions['cover_field'] = str(attachment_field.id)

            # 推荐文本字段作为描述（避免与标题字段重复）
            text_field = fields.filter(field_type='text').first()
            if text_field and str(text_field.id) != suggestions.get('title_field'):
                suggestions['description_field'] = str(text_field.id)

        elif view_type == 'flashcard':
            text_fields = list(fields.filter(field_type='text')[:2])
            primary_field = fields.filter(is_primary=True).first()

            if primary_field:
                suggestions['front_field'] = str(primary_field.id)
                non_primary_text = fields.filter(field_type='text', is_primary=False).first()
                if non_primary_text:
                    suggestions['back_field'] = str(non_primary_text.id)
            elif len(text_fields) >= 2:
                suggestions['front_field'] = str(text_fields[0].id)
                suggestions['back_field'] = str(text_fields[1].id)
            elif len(text_fields) == 1:
                suggestions['front_field'] = str(text_fields[0].id)

            checkbox_field = fields.filter(field_type='checkbox').first()
            if checkbox_field:
                suggestions['mastery_field'] = str(checkbox_field.id)

            tags_field = fields.filter(field_type__in=['select', 'multi_select']).first()
            if tags_field:
                suggestions['tags_field'] = str(tags_field.id)

            suggestions.setdefault('auto_shuffle', False)
            suggestions.setdefault('show_progress', True)

        elif view_type == 'form':
            suggestions['submit_label'] = '提交'
            suggestions['success_message'] = '提交成功！感谢您的填写。'
            suggestions['allow_multiple_submit'] = True
            suggestions['login_required'] = False

            form_field_configs = {}
            for f in fields:
                if f.field_type in ('created_time', 'last_modified_time', 'created_by', 'last_modified_by'):
                    continue
                fc = {'description': ''}
                form_field_configs[str(f.id)] = fc
            if form_field_configs:
                suggestions['field_configs'] = form_field_configs

        return suggestions
