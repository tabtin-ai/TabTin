from django.urls import path
from ninja import NinjaAPI

from apps.updater.admin_api import router as updater_admin_router

api = NinjaAPI()
api.add_router("/auth/admin", updater_admin_router)

urlpatterns = [
    path("api/", api.urls),
]
