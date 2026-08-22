from django.urls import path

from apps.extensions import api

urlpatterns = [
    path("", api.list_extensions, name="ext-list"),
    # Builtin auto-connection
    path("ensure-builtins/", api.ensure_builtin_connections, name="ext-ensure-builtins"),
    # ExtensionConnection
    path("connections/", api.list_connections, name="ext-connections"),
    path("connections/create/", api.create_connection, name="ext-connection-create"),
    path("connections/<str:connection_id>/", api.get_connection, name="ext-connection-detail"),
    path("connections/<str:connection_id>/update/", api.update_connection, name="ext-connection-update"),
    path("connections/<str:connection_id>/delete/", api.delete_connection, name="ext-connection-delete"),
    path("connections/<str:connection_id>/probe/", api.probe_connection, name="ext-connection-probe"),
    # WebhookSubscription
    path("webhooks/", api.list_webhooks, name="ext-webhooks"),
    path("webhooks/create/", api.create_webhook, name="ext-webhook-create"),
    path("webhooks/<str:webhook_id>/update/", api.update_webhook, name="ext-webhook-update"),
    path("webhooks/<str:webhook_id>/delete/", api.delete_webhook, name="ext-webhook-delete"),
    # EventBus consumers
    path("event-consumers/", api.list_event_consumers, name="ext-event-consumers"),
    # EventLog
    path("event-logs/", api.list_event_logs, name="ext-event-logs"),
    # Notification Rules
    path("notification-rules/", api.list_notification_rules, name="ext-notification-rules"),
    path("notification-rules/create/", api.create_notification_rule, name="ext-notification-rule-create"),
    path("notification-rules/<str:rule_id>/update/", api.update_notification_rule, name="ext-notification-rule-update"),
    path("notification-rules/<str:rule_id>/delete/", api.delete_notification_rule, name="ext-notification-rule-delete"),
    path("notification-rules/seed/", api.seed_notification_rules, name="ext-notification-rules-seed"),
    path("cli-commands/", api.extension_cli_commands, name="ext-cli-commands"),
    path("<str:extension_id>/cli/<str:command_name>/", api.execute_extension_cli_command, name="ext-cli-exec"),
    # 通配路由必须放在最后，否则会拦截上面所有具体路径
    path("<str:extension_id>/", api.extension_detail, name="ext-detail"),
]
