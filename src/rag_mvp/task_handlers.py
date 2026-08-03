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

TaskHandler = Callable[[Any, redis.Redis, dict[str, str], bool, bool], None]


def _require_material_id(fields: dict[str, str]) -> str:
    material_id = (fields.get("material_id") or "").strip()
    if not material_id:
        raise ValueError("missing material_id")
    return material_id


def _handle_assignment_generate(
    conn: Any,
    _redis_client: redis.Redis,
    fields: dict[str, str],
    _text_only: bool,
    _skip_kg: bool,
) -> None:
    from rag_mvp.assignment_gen import generate_assignment

    assignment_id = (fields.get("assignment_id") or "").strip()
    course_id = (fields.get("course_id") or "").strip()
    teacher_request = fields.get("teacher_request", "")
    if not assignment_id or not course_id:
        raise ValueError("missing assignment_id or course_id")
    structured_params_raw = (fields.get("structured_params") or "").strip()
    structured_params = json.loads(structured_params_raw) if structured_params_raw else None
    generate_assignment(
        assignment_id,
        course_id,
        teacher_request,
        conn,
        structured_params=structured_params,
    )


def _handle_parse_and_index(
    conn: Any,
    redis_client: redis.Redis,
    fields: dict[str, str],
    text_only: bool,
    skip_kg: bool,
) -> None:
    process_parse_and_index(
        conn,
        _require_material_id(fields),
        text_only=text_only,
        skip_kg=skip_kg,
        r=redis_client,
    )


def _handle_index_only(
    conn: Any,
    _redis_client: redis.Redis,
    fields: dict[str, str],
    text_only: bool,
    skip_kg: bool,
) -> None:
    process_index_only(
        conn,
        _require_material_id(fields),
        text_only=text_only,
        skip_kg=skip_kg,
    )


def _handle_delete_material(
    conn: Any,
    _redis_client: redis.Redis,
    fields: dict[str, str],
    _text_only: bool,
    _skip_kg: bool,
) -> None:
    process_delete_material(conn, _require_material_id(fields))


def _handle_repair_preview(
    conn: Any,
    _redis_client: redis.Redis,
    fields: dict[str, str],
    _text_only: bool,
    _skip_kg: bool,
) -> None:
    process_repair_preview(conn, _require_material_id(fields))


def _handle_convert_preview(
    conn: Any,
    _redis_client: redis.Redis,
    fields: dict[str, str],
    text_only: bool,
    skip_kg: bool,
) -> None:
    process_convert_preview(
        conn,
        _require_material_id(fields),
        text_only=text_only,
        skip_kg=skip_kg,
    )


def _handle_transcribe_and_index(
    conn: Any,
    redis_client: redis.Redis,
    fields: dict[str, str],
    text_only: bool,
    skip_kg: bool,
) -> None:
    process_transcribe_and_index(
        conn,
        _require_material_id(fields),
        text_only=text_only,
        skip_kg=skip_kg,
        r=redis_client,
    )


def _handle_personal_parse_and_index(
    conn: Any,
    redis_client: redis.Redis,
    fields: dict[str, str],
    text_only: bool,
    skip_kg: bool,
) -> None:
    process_personal_parse_and_index(
        conn,
        _require_material_id(fields),
        text_only=text_only,
        skip_kg=skip_kg,
        r=redis_client,
    )


def _handle_personal_convert_preview(
    conn: Any,
    _redis_client: redis.Redis,
    fields: dict[str, str],
    text_only: bool,
    skip_kg: bool,
) -> None:
    process_personal_convert_preview(
        conn,
        _require_material_id(fields),
        text_only=text_only,
        skip_kg=skip_kg,
    )


def _handle_personal_delete_material(
    conn: Any,
    _redis_client: redis.Redis,
    fields: dict[str, str],
    _text_only: bool,
    _skip_kg: bool,
) -> None:
    process_personal_delete_material(conn, _require_material_id(fields))


def _handle_personal_transcribe_and_index(
    conn: Any,
    redis_client: redis.Redis,
    fields: dict[str, str],
    text_only: bool,
    skip_kg: bool,
) -> None:
    process_personal_transcribe_and_index(
        conn,
        _require_material_id(fields),
        text_only=text_only,
        skip_kg=skip_kg,
        r=redis_client,
    )


def _handle_personal_index_only(
    conn: Any,
    _redis_client: redis.Redis,
    fields: dict[str, str],
    text_only: bool,
    skip_kg: bool,
) -> None:
    process_personal_index_only(
        conn,
        _require_material_id(fields),
        text_only=text_only,
        skip_kg=skip_kg,
    )


TASK_HANDLERS: dict[str, TaskHandler] = {
    "assignment.generate": _handle_assignment_generate,
    "parse_and_index": _handle_parse_and_index,
    "index_only": _handle_index_only,
    "delete_material": _handle_delete_material,
    "repair_preview": _handle_repair_preview,
    "convert_preview": _handle_convert_preview,
    "transcribe_and_index": _handle_transcribe_and_index,
    "personal_parse_and_index": _handle_personal_parse_and_index,
    "personal_convert_preview": _handle_personal_convert_preview,
    "personal_delete_material": _handle_personal_delete_material,
    "personal_transcribe_and_index": _handle_personal_transcribe_and_index,
    "personal_index_only": _handle_personal_index_only,
}


def get_task_handler(operation: str | None) -> TaskHandler | None:
    if operation is None:
        return None
    return TASK_HANDLERS.get(operation)
