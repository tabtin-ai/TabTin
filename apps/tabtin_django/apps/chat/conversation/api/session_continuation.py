from ninja import Body, Schema

from apps.i18n.response import error_response_with_status, success_response
from ._common import jwt_auth, logger, router
from ..services import session_continuation_service


class CreateSessionContinuationRequest(Schema):
    source_session_id: str
    recipient_user_id: str
    client_request_id: str
    conversation_id: str | None = None


class BatchSessionContinuationRequest(Schema):
    object_ids: list[str]


class CreateContinuationTaskRequest(Schema):
    agent_id: str
    workspace_id: str
    client_request_id: str


@router.post("/session-continuations", auth=jwt_auth, tags=["任务续接"])
def create_session_continuation(
    request,
    data: CreateSessionContinuationRequest = Body(...),
):
    try:
        return success_response(
            data=session_continuation_service.create_and_send(
                sender_user=request.auth,
                source_session_id=data.source_session_id,
                recipient_user_id=data.recipient_user_id,
                client_request_id=data.client_request_id,
                authorization_header=str(
                    getattr(request, "headers", {}).get("Authorization", "") or "",
                ),
                conversation_id_hint=data.conversation_id,
            )
        )
    except session_continuation_service.SessionContinuationDeliveryError as exc:
        return error_response_with_status(
            exc.code,
            message=str(exc),
            status_code=502 if exc.code == "IM_DELIVERY_REJECTED" else 503,
            data=exc.detail,
        )
    except session_continuation_service.SessionContinuationAccessError as exc:
        return error_response_with_status(
            "FORBIDDEN",
            message=str(exc),
            status_code=403,
        )
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=str(exc),
            status_code=400,
        )
    except Exception:
        logger.exception("[session-continuation] create failed")
        return error_response_with_status(
            "INTERNAL_ERROR",
            message="创建任务续接卡失败",
            status_code=500,
        )


@router.post("/session-continuations/batch-get", auth=jwt_auth, tags=["任务续接"])
def batch_get_session_continuations(
    request,
    data: BatchSessionContinuationRequest = Body(...),
):
    try:
        return success_response(
            data={
                "items": session_continuation_service.batch_get_details(
                    object_ids=data.object_ids,
                    viewer_user=request.auth,
                ),
            }
        )
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=str(exc),
            status_code=400,
        )


@router.post(
    "/session-continuations/{continuation_id}/create-task",
    auth=jwt_auth,
    tags=["任务续接"],
)
def create_task_from_continuation(
    request,
    continuation_id: str,
    data: CreateContinuationTaskRequest = Body(...),
):
    try:
        return success_response(
            data=session_continuation_service.create_task(
                continuation_id=continuation_id,
                recipient_user=request.auth,
                agent_id=data.agent_id,
                workspace_id=data.workspace_id,
                client_request_id=data.client_request_id,
            )
        )
    except session_continuation_service.SessionContinuationAccessError as exc:
        return error_response_with_status(
            "FORBIDDEN",
            message=str(exc),
            status_code=403,
        )
    except ValueError as exc:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=str(exc),
            status_code=409,
        )
    except Exception:
        logger.exception(
            "[session-continuation] materialize failed continuation=%s",
            continuation_id,
        )
        return error_response_with_status(
            "MATERIALIZE_FAILED",
            message="创建续接任务失败",
            status_code=500,
        )
