from apps.services.common.db_router import PostgresAppRouter


class NotificationRouter(PostgresAppRouter):
    route_app_labels = {"notification"}
