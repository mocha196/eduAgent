from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import redis

from rag_mvp.material_processor import (
    process_convert_preview,
    process_delete_material,
    process_index_only,
    process_parse_and_index,
    process_personal_convert_preview,
    process_personal_delete_material,
    process_personal_index_only,
    process_personal_parse_and_index,
    process_personal_transcribe_and_index,
    process_repair_preview,
    process_transcribe_and_index,
)

TaskHandler = Callable[[Any, redis.Redis, dict[str, str], bool], None]


def _material_id(fields: dict[str, str]) -> str:
    value = (fields.get("material_id") or "").strip()
    if not value:
        raise ValueError("missing material_id")
    return value


def _assignment(conn: Any, _redis: redis.Redis, fields: dict[str, str], _text_only: bool) -> None:
    from rag_mvp.assignment_gen import generate_assignment

    assignment_id = (fields.get("assignment_id") or "").strip()
    course_id = (fields.get("course_id") or "").strip()
    if not assignment_id or not course_id:
        raise ValueError("missing assignment_id or course_id")
    raw = (fields.get("structured_params") or "").strip()
    generate_assignment(
        assignment_id,
        course_id,
        fields.get("teacher_request", ""),
        conn,
        structured_params=json.loads(raw) if raw else None,
    )


def _parse(conn: Any, client: redis.Redis, fields: dict[str, str], text_only: bool) -> None:
    process_parse_and_index(conn, _material_id(fields), text_only=text_only, r=client)


def _index(conn: Any, _client: redis.Redis, fields: dict[str, str], text_only: bool) -> None:
    process_index_only(conn, _material_id(fields), text_only=text_only)


def _delete(conn: Any, _client: redis.Redis, fields: dict[str, str], _text_only: bool) -> None:
    process_delete_material(conn, _material_id(fields))


def _repair(conn: Any, _client: redis.Redis, fields: dict[str, str], _text_only: bool) -> None:
    process_repair_preview(conn, _material_id(fields))


def _convert(conn: Any, _client: redis.Redis, fields: dict[str, str], text_only: bool) -> None:
    process_convert_preview(conn, _material_id(fields), text_only=text_only)


def _transcribe(conn: Any, client: redis.Redis, fields: dict[str, str], text_only: bool) -> None:
    process_transcribe_and_index(conn, _material_id(fields), text_only=text_only, r=client)


def _personal_parse(conn: Any, client: redis.Redis, fields: dict[str, str], text_only: bool) -> None:
    process_personal_parse_and_index(conn, _material_id(fields), text_only=text_only, r=client)


def _personal_convert(conn: Any, _client: redis.Redis, fields: dict[str, str], text_only: bool) -> None:
    process_personal_convert_preview(conn, _material_id(fields), text_only=text_only)


def _personal_delete(conn: Any, _client: redis.Redis, fields: dict[str, str], _text_only: bool) -> None:
    process_personal_delete_material(conn, _material_id(fields))


def _personal_transcribe(conn: Any, client: redis.Redis, fields: dict[str, str], text_only: bool) -> None:
    process_personal_transcribe_and_index(conn, _material_id(fields), text_only=text_only, r=client)


def _personal_index(conn: Any, _client: redis.Redis, fields: dict[str, str], text_only: bool) -> None:
    process_personal_index_only(conn, _material_id(fields), text_only=text_only)


TASK_HANDLERS: dict[str, TaskHandler] = {
    "assignment.generate": _assignment,
    "parse_and_index": _parse,
    "index_only": _index,
    "delete_material": _delete,
    "repair_preview": _repair,
    "convert_preview": _convert,
    "transcribe_and_index": _transcribe,
    "personal_parse_and_index": _personal_parse,
    "personal_convert_preview": _personal_convert,
    "personal_delete_material": _personal_delete,
    "personal_transcribe_and_index": _personal_transcribe,
    "personal_index_only": _personal_index,
}


def get_task_handler(operation: str | None) -> TaskHandler | None:
    return TASK_HANDLERS.get(operation) if operation else None
