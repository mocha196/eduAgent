"""Centralized logging setup for Python services.

Call ``configure_logging()`` once at process startup (in main.py / worker.py).

- Production / Docker (LOG_FORMAT=json or not a TTY): newline-delimited JSON to stdout.
  Vector reads container stdout via the Docker socket and ships to Loki.
  Labels added by Vector: service, level, component.

- Development (TTY / LOG_FORMAT=pretty): coloured human-readable loguru default.
"""

from __future__ import annotations

import io
import os
import sys

from loguru import logger


def _utf8_stdout() -> io.TextIOWrapper | None:
    """Return a UTF-8 wrapper around stdout.buffer, or None if not available."""
    buf = getattr(sys.stdout, "buffer", None)
    if buf is None:
        return None
    return io.TextIOWrapper(buf, encoding="utf-8", errors="replace", line_buffering=True)


def configure_logging(service: str) -> None:
    """Remove the default loguru handler and add the appropriate one for the environment."""
    logger.remove()

    log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
    force_json = os.environ.get("LOG_FORMAT", "").lower() == "json"
    is_json = force_json or not sys.stdout.isatty()

    # Always use a UTF-8 sink so emoji / CJK in log records survive Windows GBK pipes.
    sink = _utf8_stdout() or sys.stdout

    if is_json:
        # Structured JSON — Vector/Loki pipeline
        logger.add(
            sink,
            level=log_level,
            serialize=True,  # loguru built-in JSON serialisation
            # Inject the service name into every record's extra dict so it appears in JSON.
            format="{message}",
        )
        # Patch every record to carry the service name in extra
        logger.configure(extra={"service": service})
    else:
        # Pretty coloured output for local dev
        logger.add(
            sink,
            level=log_level,
            colorize=False,  # colorize conflicts with TextIOWrapper on Windows
            format=(
                "{time:HH:mm:ss.SSS} | "
                "{level: <8} | "
                f"{service} | "
                "{name}:{line} - {message}"
            ),
        )
