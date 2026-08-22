"""
钱包系统后台管理
"""

from django.contrib import admin
from .models import CreditPackage, WalletTransaction


@admin.register(CreditPackage)
class CreditPackageAdmin(admin.ModelAdmin):
    """点券套餐管理"""

    list_display = [
        'name', 'price', 'credits_amount', 'bonus_credits',
        'total_credits', 'sort_order', 'is_active'
    ]
    list_filter = ['is_active']
    search_fields = ['name', 'description']
    ordering = ['sort_order', 'price']

    fieldsets = (
        ('基本信息', {
            'fields': ('name', 'description', 'is_active', 'sort_order')
        }),
        ('套餐配置', {
            'fields': ('price', 'credits_amount', 'bonus_credits')
        }),
    )

    readonly_fields = ['total_credits']

    def total_credits(self, obj):
        """显示总点券数（含赠送）"""
        return obj.total_credits
    total_credits.short_description = '总 credits 数'


@admin.register(WalletTransaction)
class WalletTransactionAdmin(admin.ModelAdmin):
    """钱包交易记录管理"""

    list_display = [
        'get_organization', 'transaction_type', 'amount',
        'balance_before', 'balance_after', 'created_at'
    ]
    list_filter = ['transaction_type', 'created_at']
    search_fields = ['organization_wallet__organization_id', 'related_order_id', 'usage_event_id', 'description']
    readonly_fields = [
        'organization_wallet', 'transaction_type', 'amount',
        'balance_before', 'balance_after', 'related_order_id',
        'usage_event_id', 'billing_metadata', 'description', 'created_at'
    ]
    ordering = ['-created_at']

    def get_organization(self, obj):
        if obj.organization_wallet:
            return f"组织: {str(obj.organization_wallet.organization_id)[:8]}..."
        return "-"
    get_organization.short_description = '组织'

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
