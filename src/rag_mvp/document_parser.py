"""Document parsing through MinerU without a RAG framework dependency."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from loguru import logger

from .config import settings
from .mineru_cloud import MineruCloudError, parse_file_via_cloud

_OFFICE_SUFFIXES = frozenset({".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"})
_TEXT_SUFFIXES = frozenset({".txt", ".md"})


def _write_plain_text_output(file_path: Path, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    text = file_path.read_text(encoding="utf-8", errors="replace")
    (output_dir / f"{file_path.stem}.md").write_text(text, encoding="utf-8")
    payload = [{"type": "text", "text": text, "page_idx": 0}]
    (output_dir / f"{file_path.stem}_content_list.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _convert_office_to_pdf(file_path: Path, temp_dir: Path) -> Path:
    executable = shutil.which("soffice") or shutil.which("libreoffice")
    if not executable:
        raise RuntimeError("LibreOffice is required to parse Office documents")
    result = subprocess.run(
        [executable, "--headless", "--convert-to", "pdf", "--outdir", str(temp_dir), str(file_path)],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    pdf_path = temp_dir / f"{file_path.stem}.pdf"
    if result.returncode != 0 or not pdf_path.exists():
        raise RuntimeError(f"LibreOffice conversion failed: {result.stderr[:500]}")
    return pdf_path


def _run_mineru(file_path: Path, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        "mineru",
        "-p",
        str(file_path),
        "-o",
        str(output_dir),
        "-m",
        settings.parse_method,
        "-b",
        settings.mineru_backend,
        "--source",
        settings.mineru_source,
        "-l",
        settings.mineru_lang,
        "-d",
        settings.mineru_device,
    ]
    logger.info("Executing MinerU for {}", file_path.name)
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if result.returncode != 0:
        raise RuntimeError(f"MinerU failed ({result.returncode}): {result.stderr[-2000:]}")
    if not any(output_dir.rglob("*_content_list.json")):
        raise RuntimeError(f"MinerU completed but produced no content list under {output_dir}")


def _parse_local(file_path: Path, output_dir: Path) -> None:
    if file_path.suffix.lower() in _TEXT_SUFFIXES:
        _write_plain_text_output(file_path, output_dir)
        return
    if file_path.suffix.lower() in _OFFICE_SUFFIXES:
        with tempfile.TemporaryDirectory(prefix="edu_parse_office_") as raw_temp:
            pdf_path = _convert_office_to_pdf(file_path, Path(raw_temp))
            _run_mineru(pdf_path, output_dir)
        return
    _run_mineru(file_path, output_dir)


async def parse_document(file_path: Path) -> None:
    output_dir = settings.output_dir / file_path.stem
    if settings.mineru_cloud_enabled and settings.mineru_cloud_api_key:
        try:
            await parse_file_via_cloud(file_path, output_dir)
            logger.success("Parsed with MinerU Cloud: {}", file_path.name)
            return
        except MineruCloudError as exc:
            if not settings.mineru_cloud_fallback_local:
                raise
            logger.warning("MinerU Cloud failed; using local parser for {}: {}", file_path.name, exc)
    await asyncio.to_thread(_parse_local, file_path, output_dir)
    logger.success("Parsed locally: {}", file_path.name)
