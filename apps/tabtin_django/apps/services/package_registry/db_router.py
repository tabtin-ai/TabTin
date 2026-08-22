from apps.services.common.db_router import PostgresAppRouter


class PackageRegistryRouter(PostgresAppRouter):
    route_app_labels = {"package_registry"}
