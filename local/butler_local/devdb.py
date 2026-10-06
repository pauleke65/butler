"""Local DynamoDB: a moto server on :5555 with the ``butler-local`` table (``python -m butler_local.devdb``)."""
from __future__ import annotations

import logging
import os
import signal
import threading

from butler_actions.store import Store
from moto.server import ThreadedMotoServer

log = logging.getLogger("butler.devdb")

DEFAULT_PORT = 5555


def endpoint(port: int = DEFAULT_PORT) -> str:
    return f"http://localhost:{port}"


def start(port: int = DEFAULT_PORT, host: str = "127.0.0.1") -> ThreadedMotoServer:
    """Start the moto server in a background thread and create the table. Returns the server (call .stop())."""
    server = ThreadedMotoServer(ip_address=host, port=port, verbose=False)
    server.start()
    ensure_table(port)
    return server


def ensure_table(port: int = DEFAULT_PORT) -> Store:
    name = os.environ.get("TABLE_NAME", "butler-local")
    store = Store.create_table(name, os.environ.get("AWS_REGION", "us-east-1"), endpoint(port))
    log.info("table %s ready at %s", name, endpoint(port))
    return store


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)  # moto logs every request otherwise
    port = int(os.environ.get("DEVDB_PORT", DEFAULT_PORT))
    server = start(port)
    done = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: done.set())
    log.info("local DynamoDB (moto) listening on %s", endpoint(port))
    done.wait()
    server.stop()


if __name__ == "__main__":
    main()
