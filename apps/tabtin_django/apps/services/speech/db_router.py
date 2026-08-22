from apps.services.common.db_router import PostgresAppRouter


class SpeechRouter(PostgresAppRouter):
    route_app_labels = {"speech"}
