from django.urls import path
from ninja import NinjaAPI

from apps.services.billing.api import router as billing_router
from apps.services.billing.api_admin import router as billing_admin_router
from apps.services.payment.api import router as payment_router

api = NinjaAPI()
api.add_router("/services/billing", billing_router)
api.add_router("/services/billing", billing_admin_router)
api.add_router("/services/payment", payment_router)

urlpatterns = [
    path("api/", api.urls),
]
