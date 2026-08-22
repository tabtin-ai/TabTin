"""Tests for channel_gateway.compat — unified async bridge."""

from __future__ import annotations

import asyncio
from unittest import TestCase
from unittest.mock import patch

from apps.channel_gateway.compat import run_adapter_coro


class RunAdapterCoroTests(TestCase):
    def test_runs_coroutine_to_completion(self):
        async def add(a, b):
            return a + b

        result = run_adapter_coro(add(2, 3))
        self.assertEqual(result, 5)

    def test_returns_result_via_thread_pool_when_loop_running(self):
        """COM-22: 有事件循环时改用 ThreadPoolExecutor 执行并返回结果，不再返回 None。"""
        async def inner():
            async def dummy():
                return 42

            return run_adapter_coro(dummy())

        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(inner())
            self.assertEqual(result, 42)
        finally:
            loop.close()

    def test_executes_coro_via_thread_pool_when_loop_running(self):
        """COM-22: 有事件循环时协程在子线程中执行，不应被关闭。"""
        executed = []

        async def tracked_coro():
            executed.append(True)
            return 99

        async def inner():
            return run_adapter_coro(tracked_coro())

        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(inner())
            self.assertEqual(result, 99)
            self.assertEqual(executed, [True])
        finally:
            loop.close()

    def test_propagates_exception(self):
        async def boom():
            raise ValueError("test error")

        with self.assertRaises(ValueError) as ctx:
            run_adapter_coro(boom())
        self.assertIn("test error", str(ctx.exception))
