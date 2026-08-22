"""
TabData Admin 自定义操作

提供数据一致性检查和防呆处理功能
"""

from apps.tabdata.constants import TABDATA_DB_ALIAS
from django.contrib import admin, messages
from django.contrib.auth import get_user_model
from django.db import connections
from django.http import HttpResponseRedirect
from django.urls import path, reverse
from django.shortcuts import render
from django.utils.html import format_html

User = get_user_model()


def check_organization_consistency(modeladmin, request, queryset):
    """
    检查组织数据一致性

    检查所有Organization的owner是否存在于MySQL中
    """
    from apps.tabtinspace.models import Organization

    total_count = 0
    invalid_count = 0
    invalid_organizations = []

    # 检查所有组织
    all_organizations = Organization.objects.all()
    total_count = all_organizations.count()

    for ws in all_organizations:
        try:
            # 尝试访问owner（会触发跨数据库查询）
            _ = ws.owner.email
        except User.DoesNotExist:
            invalid_count += 1
            invalid_organizations.append({
                'id': str(ws.id),
                'name': ws.name,
                'owner_id': ws.owner_id,
            })

    if invalid_count == 0:
        modeladmin.message_user(
            request,
            f"✅ 数据一致性检查通过！检查了 {total_count} 个组织，全部有效。",
            messages.SUCCESS
        )
    else:
        # 构造详细错误信息
        error_details = "<br>".join([
            f"• 组织 {ws['name']} (ID: {ws['id'][:8]}...) - owner_id: {ws['owner_id']} 不存在"
            for ws in invalid_organizations
        ])

        modeladmin.message_user(
            request,
            format_html(
                "⚠️ 发现 {} 个无效组织（owner不存在）：<br>{}",
                invalid_count,
                error_details
            ),
            messages.WARNING
        )

check_organization_consistency.short_description = "🔍 检查组织数据一致性"


def check_table_consistency(modeladmin, request, queryset):
    """
    检查表格数据一致性

    检查所有Table的owner和created_by是否存在
    """
    from apps.tabdata.models import Table

    total_count = 0
    invalid_owner_count = 0
    invalid_tables = []

    # 检查所有表格
    all_tables = Table.objects.using(TABDATA_DB_ALIAS).all()
    total_count = all_tables.count()

    for table in all_tables:
        has_issue = False
        issue_details = []

        # 检查owner
        try:
            _ = table.owner.email
        except User.DoesNotExist:
            has_issue = True
            issue_details.append(f"owner_id {table.owner_id} 不存在")

        if has_issue:
            invalid_owner_count += 1
            invalid_tables.append({
                'id': str(table.id),
                'name': table.name,
                'issues': ', '.join(issue_details)
            })

    if invalid_owner_count == 0:
        modeladmin.message_user(
            request,
            f"✅ 数据一致性检查通过！检查了 {total_count} 个表格，全部有效。",
            messages.SUCCESS
        )
    else:
        error_details = "<br>".join([
            f"• 表格 {t['name']} (ID: {t['id'][:8]}...) - {t['issues']}"
            for t in invalid_tables
        ])

        modeladmin.message_user(
            request,
            format_html(
                "⚠️ 发现 {} 个无效表格：<br>{}",
                invalid_owner_count,
                error_details
            ),
            messages.WARNING
        )

check_table_consistency.short_description = "🔍 检查表格数据一致性"


def check_record_consistency(modeladmin, request, queryset):
    """
    检查记录数据一致性

    检查TableRecord的created_by和updated_by是否存在
    """
    from apps.tabdata.models import TableRecord

    # 只检查前1000条记录（避免太慢）
    sample_size = 1000
    all_records = TableRecord.objects.using(TABDATA_DB_ALIAS).all()[:sample_size]
    total_count = all_records.count()

    invalid_count = 0
    invalid_records = []

    for record in all_records:
        has_issue = False
        issue_details = []

        # 检查created_by
        if record.created_by_id:
            try:
                _ = record.created_by.email
            except User.DoesNotExist:
                has_issue = True
                issue_details.append(f"created_by_id {record.created_by_id} 不存在")

        # 检查updated_by
        if record.updated_by_id:
            try:
                _ = record.updated_by.email
            except User.DoesNotExist:
                has_issue = True
                issue_details.append(f"updated_by_id {record.updated_by_id} 不存在")

        if has_issue:
            invalid_count += 1
            if len(invalid_records) < 10:  # 只显示前10个
                invalid_records.append({
                    'id': str(record.id),
                    'table': record.table.name,
                    'issues': ', '.join(issue_details)
                })

    if invalid_count == 0:
        modeladmin.message_user(
            request,
            f"✅ 数据一致性检查通过！检查了 {total_count} 条记录（采样），全部有效。",
            messages.SUCCESS
        )
    else:
        if invalid_records:
            error_details = "<br>".join([
                f"• 记录 {r['id'][:8]}... (表格: {r['table']}) - {r['issues']}"
                for r in invalid_records
            ])
            if invalid_count > 10:
                error_details += f"<br>... 还有 {invalid_count - 10} 个问题"
        else:
            error_details = "详细信息请查看日志"

        modeladmin.message_user(
            request,
            format_html(
                "⚠️ 发现 {} 条无效记录：<br>{}",
                invalid_count,
                error_details
            ),
            messages.WARNING
        )

check_record_consistency.short_description = "🔍 检查记录数据一致性（采样）"


def check_all_consistency(modeladmin, request, queryset):
    """
    检查所有数据一致性

    一键检查所有跨数据库关联
    """
    from apps.tabtinspace.models import Organization
    from apps.tabdata.models import Table, TableRecord

    results = {
        'organization': {'total': 0, 'invalid': 0},
        'table': {'total': 0, 'invalid': 0},
        'record': {'total': 0, 'invalid': 0},
    }

    # 检查组织
    organizations = Organization.objects.all()
    results['organization']['total'] = organizations.count()
    for ws in organizations:
        try:
            _ = ws.owner.email
        except User.DoesNotExist:
            results['organization']['invalid'] += 1

    # 检查表格
    tables = Table.objects.using(TABDATA_DB_ALIAS).all()
    results['table']['total'] = tables.count()
    for table in tables:
        try:
            _ = table.owner.email
        except User.DoesNotExist:
            results['table']['invalid'] += 1

    # 检查记录（采样1000条）
    records = TableRecord.objects.using(TABDATA_DB_ALIAS).all()[:1000]
    results['record']['total'] = records.count()
    for record in records:
        if record.created_by_id:
            try:
                _ = record.created_by.email
            except User.DoesNotExist:
                results['record']['invalid'] += 1
                continue
        if record.updated_by_id:
            try:
                _ = record.updated_by.email
            except User.DoesNotExist:
                results['record']['invalid'] += 1

    # 汇总结果
    total_checked = sum(r['total'] for r in results.values())
    total_invalid = sum(r['invalid'] for r in results.values())

    message = f"""
    📊 完整数据一致性检查报告：

    • 组织: {results['organization']['total']} 个，无效 {results['organization']['invalid']} 个
    • 表格: {results['table']['total']} 个，无效 {results['table']['invalid']} 个
    • 记录: {results['record']['total']} 条（采样），无效 {results['record']['invalid']} 条

    总计: 检查 {total_checked} 项，发现 {total_invalid} 个问题
    """

    if total_invalid == 0:
        modeladmin.message_user(
            request,
            format_html("✅ " + message.replace('\n', '<br>')),
            messages.SUCCESS
        )
    else:
        modeladmin.message_user(
            request,
            format_html("⚠️ " + message.replace('\n', '<br>')),
            messages.WARNING
        )

check_all_consistency.short_description = "🔍 完整数据一致性检查"


def clean_orphan_organizations(modeladmin, request, queryset):
    """
    清理孤儿组织

    删除owner不存在的组织
    """
    from apps.tabtinspace.models import Organization

    orphan_organizations = []

    for ws in Organization.objects.all():
        try:
            _ = ws.owner.email
        except User.DoesNotExist:
            orphan_organizations.append(ws)

    if not orphan_organizations:
        modeladmin.message_user(
            request,
            "✅ 没有发现孤儿组织",
            messages.INFO
        )
        return

    # 删除孤儿组织
    count = len(orphan_organizations)
    for ws in orphan_organizations:
        ws.delete()

    modeladmin.message_user(
        request,
        f"🧹 已清理 {count} 个孤儿组织",
        messages.SUCCESS
    )

clean_orphan_organizations.short_description = "🧹 清理孤儿组织"


def export_consistency_report(modeladmin, request, queryset):
    """
    导出数据一致性报告（CSV格式）
    """
    import csv
    from django.http import HttpResponse
    from datetime import datetime
    from apps.tabtinspace.models import Organization
    from apps.tabdata.models import Table, TableRecord

    response = HttpResponse(content_type='text/csv; charset=utf-8')
    response['Content-Disposition'] = f'attachment; filename="tabdata_consistency_report_{datetime.now().strftime("%Y%m%d_%H%M%S")}.csv"'

    # 添加BOM以支持Excel打开中文
    response.write('\ufeff')

    writer = csv.writer(response)
    writer.writerow(['模型类型', '记录ID', '记录名称', '问题类型', '关联User ID', '详细说明'])

    # 检查组织
    for ws in Organization.objects.all():
        try:
            _ = ws.owner.email
        except User.DoesNotExist:
            writer.writerow([
                'Organization',
                str(ws.id),
                ws.name,
                'owner不存在',
                ws.owner_id,
                f'组织的owner_id {ws.owner_id} 在users_auth_user表中不存在'
            ])

    # 检查表格
    for table in Table.objects.using(TABDATA_DB_ALIAS).all():
        try:
            _ = table.owner.email
        except User.DoesNotExist:
            writer.writerow([
                'Table',
                str(table.id),
                table.name,
                'owner不存在',
                table.owner_id,
                f'表格的owner_id {table.owner_id} 在users_auth_user表中不存在'
            ])

    # 检查记录（采样）
    for record in TableRecord.objects.using(TABDATA_DB_ALIAS).all()[:1000]:
        if record.created_by_id:
            try:
                _ = record.created_by.email
            except User.DoesNotExist:
                writer.writerow([
                    'TableRecord',
                    str(record.id),
                    f'记录（表格: {record.table.name}）',
                    'created_by不存在',
                    record.created_by_id,
                    f'记录的created_by_id {record.created_by_id} 在users_auth_user表中不存在'
                ])

    return response

export_consistency_report.short_description = "📥 导出一致性报告（CSV）"
