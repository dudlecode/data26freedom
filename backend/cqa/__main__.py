"""python -m cqa  — start the CQA server (run from backend/)."""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.getenv("CQA_HOST", "127.0.0.1")
    port = int(os.getenv("CQA_PORT", "8000"))
    uvicorn.run("cqa.app:app", host=host, port=port, log_level=os.getenv("CQA_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
