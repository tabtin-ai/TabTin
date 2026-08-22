from apps.services.common.db_router import PostgresAppRouter


class TinsRouter(PostgresAppRouter):
    route_app_labels = {"tins"}
