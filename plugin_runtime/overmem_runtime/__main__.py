"""python -m overmem_runtime entry point."""

from __future__ import annotations

import argparse
import os


def main() -> None:
    parser = argparse.ArgumentParser(prog="overmem-runtime", description="OverMem plugin runtime")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--mode", default=None, help="ubuntu | docker")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args()

    if args.mode:
        os.environ["OVERMEM_RUNTIME_MODE"] = args.mode

    import uvicorn

    uvicorn.run(
        "overmem_runtime.app:app",
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )


if __name__ == "__main__":
    main()
