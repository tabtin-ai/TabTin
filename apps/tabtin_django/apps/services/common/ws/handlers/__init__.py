"""
WS Gateway handler modules.

Each module exports a ``create_*_handler(consumer)`` factory that returns
an async callable compatible with ``GatewayConsumer._handlers()``.
"""

from .auth import create_auth_handler                                   # noqa: F401
from .subscription import create_subscribe_handler, create_unsubscribe_handler  # noqa: F401
from .channel import (                                                  # noqa: F401
    create_channel_inbound_handler,
    create_channel_outbound_ack_handler,
    create_channel_status_handler,
)
from .action import create_action_result_handler                        # noqa: F401
from .approval import (                                                 # noqa: F401
    create_approval_request_handler,
    create_approval_response_handler,
)
from .asr_stream import create_asr_stream_handler                      # noqa: F401
from .tts_stream import create_tts_stream_handler                      # noqa: F401
from .git_status import (                                               # noqa: F401
    create_git_status_report_handler,
    create_git_diff_request_handler,
    create_git_diff_response_handler,
)
from .device_runtime import create_device_capabilities_report_handler     # noqa: F401
from .device_capability_refresh import (                                  # noqa: F401
    create_device_capability_refresh_ack_handler,
    create_device_capability_refresh_result_handler,
)
from .monitor import create_monitor_event_handler                          # noqa: F401
from .relay_handler import create_relay_events_handler                     # noqa: F401
from .localrt_user_response import (                                      # noqa: F401
    create_localrt_user_response_delivery_handler,
    create_localrt_user_response_handler,
)
from .chat_send_message import create_chat_send_message_handler             # noqa: F401
from .chat_cancel import create_chat_cancel_handler                         # noqa: F401
from .chat_pause import create_chat_pause_control_handler                   # noqa: F401
from .subagent_cancel import create_subagent_cancel_handler                 # noqa: F401
from .session_viewing import (                                              # noqa: F401
    create_session_viewing_handler,
    cleanup_session_viewing_for_consumer,
)

__all__ = [
    "create_auth_handler",
    "create_subscribe_handler",
    "create_unsubscribe_handler",
    "create_channel_inbound_handler",
    "create_channel_outbound_ack_handler",
    "create_channel_status_handler",
    "create_action_result_handler",
    "create_approval_request_handler",
    "create_approval_response_handler",
    "create_asr_stream_handler",
    "create_tts_stream_handler",
    "create_git_status_report_handler",
    "create_git_diff_request_handler",
    "create_git_diff_response_handler",
    "create_device_capabilities_report_handler",
    "create_device_capability_refresh_ack_handler",
    "create_device_capability_refresh_result_handler",
    "create_monitor_event_handler",
    "create_relay_events_handler",
    "create_localrt_user_response_delivery_handler",
    "create_localrt_user_response_handler",
    "create_chat_send_message_handler",
    "create_chat_cancel_handler",
    "create_chat_pause_control_handler",
    "create_subagent_cancel_handler",
    "create_session_viewing_handler",
    "cleanup_session_viewing_for_consumer",
]
