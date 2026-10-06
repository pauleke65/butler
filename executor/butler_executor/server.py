"""HTTP wrapper for the executor (local replacement for the Lambda): ``POST /invoke`` on :8081."""
from __future__ import annotations

import logging
import os
from typing import Any

import uvicorn
from butler_actions.gateway import GatewayClient
from butler_actions.store import Store
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .handler import handler


def create_app(store: Store | None = None, gateway: GatewayClient | None = None) -> Starlette:
    """Build the app; store/gateway are created lazily from the environment when not injected."""
    state: dict[str, Any] = {"store": store, "gateway": gateway}

    async def invoke(request: Request) -> JSONResponse:
        try:
            event = await request.json()
        except ValueError:
            return JSONResponse({"ok": False, "error": {"code": "INVALID_INPUT", "message": "body must be JSON"}}, 400)
        if not isinstance(event, dict):
            return JSONResponse({"ok": False, "error": {"code": "INVALID_INPUT", "message": "body must be an object"}}, 400)
        result = await run_in_threadpool(handler, event, None, store=state["store"], gateway=state["gateway"])
        return JSONResponse(result)

    async def health(_: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "service": "butler-executor"})

    return Starlette(routes=[Route("/invoke", invoke, methods=["POST"]), Route("/health", health)])


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(create_app(), host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("EXECUTOR_PORT", "8081")), log_level="info")


if __name__ == "__main__":
    main()
