"""Redis transport guardrails for transient Celery pidbox replies.

Kombu's virtual Redis transport accepts queue expiry arguments but does not
translate them into Redis key expiry.  A pidbox collector that dies before its
``finally`` cleanup therefore leaves its reply list without a TTL.  This
transport keeps Kombu's normal behavior for every other key and makes the
pidbox reply ``LPUSH`` plus ``EXPIRE`` one Redis transaction.
"""

from __future__ import annotations

from math import ceil, isfinite

from kombu.transport.redis import Channel as RedisChannel
from kombu.transport.redis import Transport as RedisTransport
from kombu.utils.json import dumps
from redis import Redis


PIDBOX_REPLY_SUFFIX = ".reply.celery.pidbox"
DEFAULT_PIDBOX_REPLY_TTL_SECONDS = 300


class Channel(RedisChannel):
    """Redis channel that bounds only Celery pidbox reply lists."""

    pidbox_reply_ttl = DEFAULT_PIDBOX_REPLY_TTL_SECONDS
    from_transport_options = RedisChannel.from_transport_options + (
        "pidbox_reply_ttl",
    )

    def _put(self, queue, message, **kwargs):
        if not queue.endswith(PIDBOX_REPLY_SUFFIX):
            return super()._put(queue, message, **kwargs)

        try:
            configured_ttl = float(self.pidbox_reply_ttl)
            if not isfinite(configured_ttl) or configured_ttl <= 0:
                raise ValueError
            ttl_seconds = ceil(configured_ttl)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError("pidbox_reply_ttl must be a positive number") from exc

        priority = self._get_message_priority(message, reverse=False)
        redis_key = self._q_for_pri(queue, priority)
        with self.conn_or_acquire() as client:
            physical_key = f"{self.global_keyprefix}{redis_key}"
            # Kombu's prefixed pipeline does not prefix EXPIRE in 5.6.2.
            # Use the same pool with the physical key so both writes remain
            # one transaction even when global_keyprefix is configured.
            raw_client = Redis(connection_pool=client.connection_pool)
            with raw_client.pipeline(transaction=True) as pipe:
                pipe.lpush(physical_key, dumps(message))
                pipe.expire(physical_key, ttl_seconds)
                pipe.execute()


class Transport(RedisTransport):
    """Project Redis transport with finite pidbox reply list lifetimes."""

    Channel = Channel
