"""Dev supervisor (``make dev``): devdb -> seed -> gateway, executor, debug API, agent (if present)."""
from __future__ import annotations

import importlib.util
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field

LOCAL_ENV = {
    "STAGE": "local", "AWS_REGION": "us-east-1", "TABLE_NAME": "butler-local",
    "DYNAMODB_ENDPOINT": "http://localhost:5555", "GATEWAY_URL": "http://localhost:8090/mcp",
    "AGENT_LOCAL_URL": "http://localhost:8080/invocations", "EXECUTOR_LOCAL_URL": "http://localhost:8081/invoke",
    "DEBUG_API_URL": "http://localhost:8085", "DEBUG_API_TOKEN": "local-debug-token",
    "HOUSEHOLD_BY_SUB": '{"*":"hh_demo"}', "LLM_MODE": "offline",
}
COLORS = ["\033[36m", "\033[32m", "\033[33m", "\033[35m", "\033[34m", "\033[31m"]


@dataclass
class Service:
    name: str
    module: str
    port: int | None = None
    optional_module: str | None = None  # skipped when this module is not importable yet
    proc: subprocess.Popen[str] | None = field(default=None, repr=False)


SERVICES = [
    Service("devdb", "butler_local.devdb", 5555),
    Service("gateway", "butler_local.gateway", 8090),
    Service("executor", "butler_executor.server", 8081),
    Service("debug-api", "debug_api.server", 8085, optional_module="debug_api"),
    Service("agent", "butler_agent.server", 8080, optional_module="butler_agent.server"),
]


def build_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Local defaults under the caller's environment; moto dummy keys only when not using real Bedrock creds."""
    env = {**LOCAL_ENV, **(base if base is not None else os.environ)}
    if env.get("LLM_MODE") != "bedrock":
        env.setdefault("AWS_ACCESS_KEY_ID", "test")
        env.setdefault("AWS_SECRET_ACCESS_KEY", "test")
    env.setdefault("HOST", "127.0.0.1")  # local services are unauthenticated: loopback only
    env["PYTHONUNBUFFERED"] = "1"
    return env


def module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def wait_port(port: int, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            s.settimeout(0.3)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.2)
    return False


class Supervisor:
    def __init__(self, env: dict[str, str]):
        self.env, self.services, self.stop = env, [], threading.Event()
        self._lock = threading.Lock()

    def log(self, name: str, line: str) -> None:
        idx = [s.name for s in SERVICES].index(name) if name in [s.name for s in SERVICES] else 0
        color = COLORS[idx % len(COLORS)] if sys.stdout.isatty() else ""
        reset = "\033[0m" if color else ""
        with self._lock:
            print(f"{color}[{name:<9}]{reset} {line.rstrip()}", flush=True)

    def _pump(self, svc: Service) -> None:
        assert svc.proc and svc.proc.stdout
        for line in svc.proc.stdout:
            self.log(svc.name, line)

    def spawn(self, svc: Service) -> None:
        svc.proc = subprocess.Popen([sys.executable, "-m", svc.module], env=self.env, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, start_new_session=True)
        threading.Thread(target=self._pump, args=(svc,), daemon=True).start()
        self.services.append(svc)

    def run_once(self, name: str, module: str, *args: str) -> int:
        proc = subprocess.run([sys.executable, "-m", module, *args], env=self.env, capture_output=True, text=True, check=False)
        for line in (proc.stdout + proc.stderr).splitlines():
            self.log(name, line)
        return proc.returncode

    def shutdown(self) -> None:
        for svc in reversed(self.services):
            if svc.proc and svc.proc.poll() is None:
                os.killpg(svc.proc.pid, signal.SIGTERM)
        deadline = time.monotonic() + 5
        for svc in self.services:
            if svc.proc:
                try:
                    svc.proc.wait(max(0.1, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    os.killpg(svc.proc.pid, signal.SIGKILL)
        self.log("dev", "all services stopped")

    def run(self) -> int:
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: self.stop.set())
        by_name = {s.name: s for s in SERVICES}
        self.spawn(by_name["devdb"])
        if not wait_port(5555):
            self.log("dev", "devdb did not start on :5555")
            self.shutdown()
            return 1
        if self.run_once("seed", "butler_local.seed") != 0:
            self.log("dev", "seed failed")
            self.shutdown()
            return 1
        for svc in SERVICES[1:]:
            if svc.optional_module and not module_available(svc.optional_module):
                self.log("dev", f"skipping {svc.name}: {svc.optional_module} is not available yet")
                continue
            self.spawn(svc)
        for svc in self.services:
            if svc.port and not wait_port(svc.port):
                self.log("dev", f"{svc.name} is not listening on :{svc.port} yet")
        self.log("dev", "up: " + ", ".join(f"{s.name}:{s.port}" for s in self.services) + "  (Ctrl-C to stop)")
        while not self.stop.wait(1.0):
            for svc in self.services:
                if svc.proc and svc.proc.poll() is not None:
                    self.log("dev", f"{svc.name} exited with code {svc.proc.returncode}")
                    if svc.name == "devdb":
                        self.stop.set()
                    svc.proc = None
        self.shutdown()
        return 0


def main() -> None:
    sys.exit(Supervisor(build_env()).run())


if __name__ == "__main__":
    main()
