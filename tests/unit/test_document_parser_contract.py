import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

from rag_mvp.document_parser import parse_document, register_parser
from rag_mvp.parsed_document import (
    ParsedBlock,
    ParsedDocument,
    has_parsed_document,
    load_parsed_document,
)


def test_legacy_content_list_is_normalized_and_round_trips(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "parsed"
    native_dir = artifact_dir / "native"
    image_dir = native_dir / "images"
    image_dir.mkdir(parents=True)
    (image_dir / "figure.png").write_bytes(b"png")
    (native_dir / "lecture_content_list.json").write_text(
        json.dumps(
            [
                {"type": "header", "text": "ignored", "page_idx": 0},
                {"type": "text", "text": "hello", "page_idx": 0},
                {
                    "type": "image",
                    "img_path": "images/figure.png",
                    "image_caption": ["diagram"],
                    "page_idx": 1,
                },
                {"type": "table", "html": "<table><tr><td>A</td></tr></table>", "page_idx": 2},
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    document = load_parsed_document(artifact_dir)

    assert document.provider == "legacy-content-list"
    assert document.page_count == 3
    assert [item["type"] for item in document.content_items()] == ["text", "image", "table"]
    image = next(block for block in document.blocks if block.kind == "image")
    assert Path(image.resolved_asset(artifact_dir) or "") == (image_dir / "figure.png").resolve()
    assert "<table>" in document.extracted_text()

    document.save()
    reloaded = load_parsed_document(artifact_dir)
    assert reloaded.extracted_text() == document.extracted_text()
    assert has_parsed_document(artifact_dir)


@pytest.mark.asyncio
async def test_registered_provider_is_selected_and_canonical_artifact_is_saved(
    tmp_path: Path,
) -> None:
    class FakeParser:
        name = "fake"

        async def parse(self, file_path: Path, output_dir: Path) -> ParsedDocument:
            return ParsedDocument(
                source_name=file_path.name,
                provider=self.name,
                artifact_dir=output_dir,
                blocks=[ParsedBlock(kind="text", text="from fake parser", page_idx=0)],
                page_count=1,
            )

    register_parser("fake", FakeParser)
    source = tmp_path / "sample.pdf"
    source.write_bytes(b"not a real pdf")
    output_dir = tmp_path / "result"

    document = await parse_document(source, output_dir=output_dir, parser_name="fake")

    assert document.provider == "fake"
    assert document.extracted_text() == "from fake parser"
    assert (output_dir / "parsed_document.json").is_file()
    assert load_parsed_document(output_dir).provider == "fake"


@pytest.mark.asyncio
async def test_plain_text_uses_builtin_provider_even_when_an_external_parser_is_named(
    tmp_path: Path,
) -> None:
    source = tmp_path / "notes.md"
    source.write_text("first line\nsecond line", encoding="utf-8")

    document = await parse_document(
        source,
        output_dir=tmp_path / "parsed-text",
        parser_name="does-not-exist",
    )

    assert document.provider == "plain-text"
    assert document.extracted_text() == "first line\nsecond line"


def test_provider_can_be_loaded_from_configuration_import_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class ImportedParser:
        name = "imported"

        async def parse(self, file_path: Path, output_dir: Path) -> ParsedDocument:
            return ParsedDocument(file_path.name, self.name, output_dir, [])

    module = ModuleType("test_parser_plugin")
    module.create_parser = ImportedParser  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, module.__name__, module)

    from rag_mvp.document_parser import get_document_parser

    parser = get_document_parser(
        tmp_path / "sample.pdf", "test_parser_plugin:create_parser"
    )
    assert parser.name == "imported"


def test_mindmap_can_use_a_canonical_only_provider_artifact(tmp_path: Path) -> None:
    from rag_mvp.mindmap import find_md_files

    artifact_dir = tmp_path / "canonical-only"
    ParsedDocument(
        source_name="lecture.pdf",
        provider="fake",
        artifact_dir=artifact_dir,
        blocks=[ParsedBlock(kind="text", text="section content " * 50, page_idx=0)],
    ).save()

    markdown_files = find_md_files(artifact_dir)

    assert len(markdown_files) == 1
    assert markdown_files[0].name == "lecture_normalized.md"
    assert "section content" in markdown_files[0].read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_index_loader_consumes_canonical_artifact_without_mineru_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from rag_mvp.config import settings
    from rag_mvp.engine import _load_parsed_chunks

    material_id = "00000000-0000-0000-0000-000000000001"
    artifact_dir = tmp_path / material_id
    ParsedDocument(
        source_name="lecture.pdf",
        provider="fake",
        artifact_dir=artifact_dir,
        blocks=[ParsedBlock(kind="text", text="canonical parser output", page_idx=4)],
    ).save()
    monkeypatch.setattr(settings, "output_dir", tmp_path)

    chunks, file_path = await _load_parsed_chunks(
        material_id,
        Path(f"{material_id}.pdf"),
        "lecture.pdf",
        text_only=True,
    )

    assert [chunk.content for chunk in chunks] == ["canonical parser output"]
    assert chunks[0].page_idx == 4
    assert file_path.startswith(f"mat_{material_id}_lecture")
