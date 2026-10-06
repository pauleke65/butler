"""HTTP surface (AgentCore Runtime protocol, port 8080): ``POST /invocations`` and ``GET /ping``."""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .agent import ASYNC_OPS, Agent, error

log = logging.getLogger("butler.server")


def create_app(agent: Agent | None = None) -> Starlette:
    holder: dict[str, Agent | None] = {"agent": agent}

    def get_agent() -> Agent:
        if holder["agent"] is None:
            from .router import default_agent

            holder["agent"] = default_agent()
        return holder["agent"]  # type: ignore[return-value]

    async def invocations(request: Request) -> JSONResponse:
        try:
            body: Any = await request.json()
        except (json.JSONDecodeError, ValueError):
            return JSONResponse(error("INVALID_INPUT", "Body must be JSON."), status_code=400)
        if not isinstance(body, dict):
            return JSONResponse(error("INVALID_INPUT", "Body must be a JSON object."), status_code=400)
        ag = await run_in_threadpool(get_agent)
        result = await run_in_threadpool(lambda: ag.handle(body, run_async=body.get("op") in ASYNC_OPS))
        return JSONResponse(result)

    async def ping(_: Request) -> JSONResponse:
        ag = holder["agent"]
        busy = bool(ag and ag.runner.busy)
        return JSONResponse({"status": "HealthyBusy" if busy else "Healthy",
                             "time_of_last_update": ag.runner.last_update if ag else 0})

    return Starlette(routes=[Route("/invocations", invocations, methods=["POST"]), Route("/ping", ping, methods=["GET"])])


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(create_app(), host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8080")))


app = create_app()

if __name__ == "__main__":
    main()
