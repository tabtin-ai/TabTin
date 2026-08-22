from django.urls import path
from ninja import NinjaAPI

from apps.services.oss.admin_api import router as oss_admin_router

api = NinjaAPI()
api.add_router("/auth/admin", oss_admin_router)

urlpatterns = [
    path("api/", api.urls),
]
