"""DEV 入站延迟：并行计时 + 串行 handler，不挡 receive。"""

from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

from asgiref.sync import async_to_sync
from django.test import SimpleTestCase

from apps.services.common.ws.gateway import GatewayConsumer
from apps.services.common.ws.protocol import now_ts


def _envelope_json(request_id: str, message_type: str = "ping") -> str:
    return json.dumps(
        {
            "v": 1,
            "type": message_type,
            "request_id": request_id,
            "ts": now_ts(),
            "device_id": "electron-test",
            "role": "electron",
            "payload": {},
        }
    )


class DevLatencyParallelInboundTests(SimpleTestCase):
    def test_parallel_inbound_delay_does_not_block_receive_and_serializes_handlers(self):
        """两次 receive 应立刻返回；handler 约在 +N 后串行开始。"""

        async def _run():
            consumer = GatewayConsumer()
            consumer.authed = True
            consumer._send_error = AsyncMock()

            starts: list[float] = []
            ends: list[float] = []
            order: list[str] = []
            processing_s = 0.04

            async def slow_handler(envelope):
                order.append(envelope["request_id"])
                starts.append(time.monotonic())
                await asyncio.sleep(processing_s)
                ends.append(time.monotonic())

            consumer._handlers = lambda: {"ping": slow_handler}

            delay_s = 0.05
            t0 = time.monotonic()
            with patch("tabtin.dev_latency.get_latency_seconds", return_value=delay_s):
                await consumer.receive(text_data=_envelope_json("req_a"))
                await consumer.receive(text_data=_envelope_json("req_b"))
                receive_elapsed = time.monotonic() - t0

                self.assertLess(
                    receive_elapsed,
                    delay_s,
                    f"receive blocked on delay: {receive_elapsed:.3f}s >= {delay_s}",
                )

                pending = [t for t in consumer._background_tasks if not t.done()]
                self.assertEqual(len(pending), 2)
                await asyncio.gather(*pending)

            total_elapsed = time.monotonic() - t0
            self.assertEqual(order, ["req_a", "req_b"])
            self.assertEqual(len(starts), 2)
            self.assertEqual(len(ends), 2)

            self.assertLess(abs(starts[0] - t0 - delay_s), 0.03)
            self.assertLess(abs(starts[1] - t0 - delay_s), 0.05)
            self.assertGreaterEqual(starts[1], ends[0] - 0.005)

            expected_serial_sleep = 2 * (delay_s + processing_s)
            self.assertLess(total_elapsed, expected_serial_sleep - 0.02)
            self.assertGreaterEqual(total_elapsed, delay_s + 2 * processing_s - 0.02)

        async_to_sync(_run)()

    def test_disconnect_cancels_pending_delayed_handlers(self):
        async def _run():
            consumer = GatewayConsumer()
            consumer.authed = True
            consumer._send_error = AsyncMock()

            started = asyncio.Event()

            async def never_finish_handler(_envelope):
                started.set()
                await asyncio.sleep(10)

            consumer._handlers = lambda: {"ping": never_finish_handler}

            with patch("tabtin.dev_latency.get_latency_seconds", return_value=0.2):
                await consumer.receive(text_data=_envelope_json("req_cancel"))
                pending = [t for t in consumer._background_tasks if not t.done()]
                self.assertEqual(len(pending), 1)

                for task in list(consumer._background_tasks):
                    if not task.done():
                        task.cancel()
                consumer._background_tasks.clear()
                await asyncio.sleep(0)

                self.assertFalse(started.is_set())

        async_to_sync(_run)()

    def test_zero_latency_awaits_handler_inline(self):
        """N=0 时不走 create_task，receive 内直接 await handler。"""

        async def _run():
            consumer = GatewayConsumer()
            consumer.authed = True
            consumer._send_error = AsyncMock()

            called = asyncio.Event()

            async def handler(_envelope):
                called.set()

            consumer._handlers = lambda: {"ping": handler}

            with patch("tabtin.dev_latency.get_latency_seconds", return_value=0.0):
                await consumer.receive(text_data=_envelope_json("req_inline"))

            self.assertTrue(called.is_set())
            self.assertFalse(any(not t.done() for t in consumer._background_tasks))

        async_to_sync(_run)()
