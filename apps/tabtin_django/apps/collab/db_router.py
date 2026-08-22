from apps.services.common.db_router import PostgresAppRouter


class CollabRouter(PostgresAppRouter):
    route_app_labels = {"collab"}
