from apps.services.common.db_router import PostgresAppRouter


class TabcodeRouter(PostgresAppRouter):
    route_app_labels = {"tabcode"}
