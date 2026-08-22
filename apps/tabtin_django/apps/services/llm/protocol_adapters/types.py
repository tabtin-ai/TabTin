from enum import Enum


class ProtocolType(str, Enum):
    OPENAI_COMPATIBLE = "OPENAI_COMPATIBLE"


class StreamEventKind(str, Enum):
    DATA = "data"
    KEEPALIVE = "keepalive"
    USAGE = "usage"
    PROTOCOL_DONE = "protocol_done"
    PROTOCOL_ERROR = "protocol_error"
