"""Background execution for async ops; reports busy state for ``GET /ping`` (AgentCore ``HealthyBusy``)."""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor

log = logging.getLogger("butler.runner")


class BackgroundRunner:
    def __init__(self, max_workers: int = 4):
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="butler-run")
        self._lock = threading.Lock()
        self._active = 0
        self.last_update = int(time.time())

    @property
    def busy(self) -> bool:
        with self._lock:
            return self._active > 0

    def submit(self, fn: Callable[[], object]) -> Future[object]:
        with self._lock:
            self._active += 1
            self.last_update = int(time.time())
        return self._pool.submit(self._wrap, fn)

    def _wrap(self, fn: Callable[[], object]) -> object:
        try:
            return fn()
        except Exception:
            log.exception("background task crashed")
            return None
        finally:
            with self._lock:
                self._active -= 1
                self.last_update = int(time.time())

    def wait_idle(self, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        while self.busy and time.monotonic() < deadline:
            time.sleep(0.02)
        return not self.busy
