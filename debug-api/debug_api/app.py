"""Starlette app for the debug API (:8085): bearer token, CORS open to localhost."""
from __future__ import annotations

from butler_actions.store import Store
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .core import route

LOCALHOST_ORIGIN = r"https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?"


def create_app(store: Store | None = None) -> Starlette:
    state = {"store": store}

    async def handle(request: Request) -> JSONResponse:
        if state["store"] is None:
            state["store"] = Store()
        status, body = await run_in_threadpool(
            route, state["store"], request.method, request.url.path, dict(request.query_params),
            request.headers.get("authorization"))
        return JSONResponse(body, status)

    routes = [Route(p, handle, methods=["GET"]) for p in ("/health", "/receipts", "/rules", "/policy-events")]
    middleware = [Middleware(CORSMiddleware, allow_origin_regex=LOCALHOST_ORIGIN, allow_methods=["GET"],
                             allow_headers=["Authorization", "Content-Type"])]
    return Starlette(routes=routes, middleware=middleware)
