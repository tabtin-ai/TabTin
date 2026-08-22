from django.contrib import admin

from .models import (
    BillingInvoice,
    BillingInvoiceLine,
    BillingReservation,
    BillingReservationAllocation,
    BillingUsageDaily,
    BillingUsageEvent,
    MeterPricing,
    StoragePackagePlan,
    OrganizationBillingEntitlement,
    OrganizationBillingPolicy,
    OrganizationLlmMonthlyBudget,
    OrganizationStorageSubscription,
    OrganizationStorageUsage,
    OrganizationServicePolicy,
    ProviderAttempt,
)


class _ReadOnlyBillingAuditAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(BillingReservation)
class BillingReservationAdmin(_ReadOnlyBillingAuditAdmin):
    list_display = (
        "id",
        "organization_id",
        "provider_key",
        "total_credits",
        "status",
        "lease_expires_at",
        "updated_at",
    )
    list_filter = ("status", "provider_key", "funding_mode")
    search_fields = (
        "id",
        "organization_id",
        "logical_search_invocation_id",
        "result_reference",
    )
    ordering = ("-created_at",)
    readonly_fields = tuple(
        field.name for field in BillingReservation._meta.fields
    )


@admin.register(BillingReservationAllocation)
class BillingReservationAllocationAdmin(_ReadOnlyBillingAuditAdmin):
    list_display = (
        "reservation_id",
        "source_type",
        "source_reference",
        "credits",
        "status",
        "created_at",
    )
    list_filter = ("source_type", "status")
    search_fields = ("reservation_id", "source_reference")
    ordering = ("-created_at",)
    readonly_fields = tuple(
        field.name for field in BillingReservationAllocation._meta.fields
    )


@admin.register(ProviderAttempt)
class ProviderAttemptAdmin(_ReadOnlyBillingAuditAdmin):
    list_display = (
        "reservation_id",
        "provider_key",
        "generation",
        "attempt_number",
        "outcome",
        "started_at",
        "finished_at",
    )
    list_filter = ("provider_key", "outcome")
    search_fields = ("reservation_id", "provider_request_id", "error_code")
    ordering = ("-started_at",)
    readonly_fields = tuple(field.name for field in ProviderAttempt._meta.fields)


@admin.register(MeterPricing)
class MeterPricingAdmin(admin.ModelAdmin):
    list_display = (
        "meter_key",
        "scope",
        "organization_id",
        "provider_key",
        "model_name",
        "unit_price",
        "currency",
        "unit",
        "priority",
        "is_active",
    )
    list_filter = ("scope", "is_active", "currency")
    search_fields = ("meter_key", "organization_id", "provider_key", "model_name")
    ordering = ("-priority", "-effective_from")


@admin.register(BillingUsageEvent)
class BillingUsageEventAdmin(admin.ModelAdmin):
    list_display = (
        "organization_id",
        "user_id",
        "meter_key",
        "quantity",
        "amount",
        "currency",
        "occurred_at",
    )
    list_filter = ("meter_key", "currency", "occurred_at")
    search_fields = ("organization_id", "user_id", "biz_type", "biz_id", "idempotency_key")
    ordering = ("-occurred_at",)


@admin.register(OrganizationStorageUsage)
class OrganizationStorageUsageAdmin(admin.ModelAdmin):
    list_display = (
        "organization_id",
        "active_file_count",
        "active_storage_bytes",
        "total_uploaded_bytes",
        "total_released_bytes",
        "last_metered_at",
    )
    search_fields = ("organization_id",)
    ordering = ("-updated_at",)


@admin.register(OrganizationBillingPolicy)
class OrganizationBillingPolicyAdmin(admin.ModelAdmin):
    list_display = (
        "organization_id",
        "storage_billing_mode",
        "llm_billing_mode",
        "currency",
        "is_active",
        "updated_at",
    )
    list_filter = ("storage_billing_mode", "llm_billing_mode", "is_active")
    search_fields = ("organization_id",)
    ordering = ("-updated_at",)


@admin.register(OrganizationBillingEntitlement)
class OrganizationBillingEntitlementAdmin(admin.ModelAdmin):
    list_display = (
        "organization_id",
        "included_storage_bytes",
        "purchased_storage_bytes",
        "included_llm_credits_monthly",
        "effective_from",
        "effective_to",
        "is_active",
    )
    list_filter = ("is_active",)
    search_fields = ("organization_id",)
    ordering = ("-updated_at",)


@admin.register(StoragePackagePlan)
class StoragePackagePlanAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "price",
        "storage_bytes",
        "bonus_storage_bytes",
        "duration_months",
        "sort_order",
        "is_active",
    )
    list_filter = ("is_active", "duration_months")
    search_fields = ("name", "description")
    ordering = ("sort_order", "-created_at")


@admin.register(OrganizationStorageSubscription)
class OrganizationStorageSubscriptionAdmin(admin.ModelAdmin):
    list_display = (
        "organization_id",
        "package_plan",
        "storage_bytes",
        "status",
        "start_at",
        "end_at",
        "purchased_by",
    )
    list_filter = ("status", "auto_renew")
    search_fields = ("organization_id", "order_id", "purchased_by")
    ordering = ("-end_at", "-created_at")


@admin.register(OrganizationLlmMonthlyBudget)
class OrganizationLlmMonthlyBudgetAdmin(admin.ModelAdmin):
    list_display = (
        "organization_id",
        "cycle_month",
        "included_credits",
        "consumed_credits",
        "overflow_credits",
        "updated_at",
    )
    list_filter = ("cycle_month",)
    search_fields = ("organization_id",)
    ordering = ("-cycle_month", "-updated_at")


@admin.register(BillingUsageDaily)
class BillingUsageDailyAdmin(admin.ModelAdmin):
    list_display = (
        "organization_id",
        "usage_date",
        "meter_key",
        "quantity",
        "amount",
        "currency",
        "source_event_count",
    )
    list_filter = ("usage_date", "meter_key", "currency")
    search_fields = ("organization_id", "meter_key")
    ordering = ("-usage_date", "-updated_at")


@admin.register(OrganizationServicePolicy)
class OrganizationServicePolicyAdmin(admin.ModelAdmin):
    list_display = (
        "organization_id",
        "enable_media_image",
        "enable_media_video",
        "enable_speech_asr",
        "enable_speech_tts",
        "enable_rag_embedding",
        "enable_web_search",
        "enable_auto_doc_index",
        "updated_at",
    )
    search_fields = ("organization_id",)
    ordering = ("-updated_at",)


class BillingInvoiceLineInline(admin.TabularInline):
    model = BillingInvoiceLine
    extra = 0
    readonly_fields = ("meter_key", "description", "quantity", "unit", "unit_price", "amount", "metadata", "created_at")


@admin.register(BillingInvoice)
class BillingInvoiceAdmin(admin.ModelAdmin):
    list_display = (
        "invoice_no",
        "organization_id",
        "period_start",
        "period_end",
        "status",
        "currency",
        "total_amount",
        "issued_at",
    )
    list_filter = ("status", "currency", "period_start")
    search_fields = ("invoice_no", "organization_id")
    ordering = ("-period_start", "-created_at")
    inlines = [BillingInvoiceLineInline]
