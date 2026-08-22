"""
支付服务后台管理
"""

from django.contrib import admin
from .models import PaymentOrder, PaymentCallback


@admin.register(PaymentOrder)
class PaymentOrderAdmin(admin.ModelAdmin):
    """支付订单管理"""

    list_display = [
        'order_no', 'user', 'order_type', 'payment_method',
        'amount', 'status', 'created_at', 'paid_at'
    ]
    list_filter = ['status', 'order_type', 'payment_method', 'created_at']
    search_fields = ['order_no', 'third_party_order_no', 'user', 'subject']
    readonly_fields = [
        'order_no', 'third_party_order_no', 'created_at', 'updated_at', 'paid_at'
    ]
    ordering = ['-created_at']

    fieldsets = (
        ('订单基本信息', {
            'fields': (
                'order_no', 'user', 'order_type', 'payment_method', 'status'
            )
        }),
        ('金额信息', {
            'fields': ('amount', 'paid_amount')
        }),
        ('订单详情', {
            'fields': ('subject', 'description', 'business_data')
        }),
        ('第三方信息', {
            'fields': ('third_party_order_no', 'third_party_trade_no')
        }),
        ('时间信息', {
            'fields': ('created_at', 'paid_at', 'expired_at', 'updated_at')
        }),
    )

    def has_add_permission(self, request):
        """禁止手动创建订单"""
        return False

    def has_delete_permission(self, request, obj=None):
        """禁止删除订单"""
        return False


@admin.register(PaymentCallback)
class PaymentCallbackAdmin(admin.ModelAdmin):
    """支付回调记录管理"""

    list_display = [
        'order', 'payment_method', 'is_verified',
        'is_processed', 'created_at'
    ]
    list_filter = ['payment_method', 'is_verified', 'is_processed', 'created_at']
    search_fields = ['order__order_no']
    readonly_fields = [
        'order', 'payment_method', 'callback_data',
        'is_verified', 'is_processed', 'error_message', 'created_at'
    ]
    ordering = ['-created_at']

    fieldsets = (
        ('回调基本信息', {
            'fields': (
                'order', 'payment_method', 'is_verified', 'is_processed'
            )
        }),
        ('回调数据', {
            'fields': ('callback_data',)
        }),
        ('错误信息', {
            'fields': ('error_message',)
        }),
        ('时间信息', {
            'fields': ('created_at',)
        }),
    )

    def has_add_permission(self, request):
        """禁止手动创建回调记录"""
        return False

    def has_delete_permission(self, request, obj=None):
        """禁止删除回调记录"""
        return False
