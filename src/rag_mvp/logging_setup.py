"""Centralized logging setup for Python services.

Call ``configure_logging()`` once at process startup (in main.py / worker.py).

- Production / Docker (LOG_FORMAT=json or not a TTY): newline-delimited JSON to stdout.
  Vector reads container stdout via the Docker socket and ships to Loki.
  Labels added by Vector: service, level, component.

- Development (TTY / LOG_FORMAT=pretty): coloured human-readable loguru default.
"""

from __future__ import annotations

import os
import sys

from loguru import logger


def configure_logging(service: str) -> None:
    """Remove the default loguru handler and add the appropriate one for the environment."""
    logger.remove()

    log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
    force_json = os.environ.get("LOG_FORMAT", "").lower() == "json"
    is_json = force_json or not sys.stdout.isatty()

    if is_json:
        # Structured JSON — Vector/Loki pipeline
        logger.add(
            sys.stdout,
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
            sys.stdout,
            level=log_level,
            colorize=True,
            format=(
                "<green>{time:HH:mm:ss.SSS}</green> | "
                "<level>{level: <8}</level> | "
                f"<cyan>{service}</cyan> | "
                "<cyan>{name}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>"
            ),
        )
