"""``python -m debug_api.server``: serve the debug API on :8085."""
from __future__ import annotations

import logging
import os

import uvicorn

from .app import create_app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(create_app(), host="0.0.0.0", port=int(os.environ.get("DEBUG_API_PORT", "8085")), log_level="warning")


if __name__ == "__main__":
    main()
