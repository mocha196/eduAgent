"""Provider-neutral document parsing result and artifact persistence.

Parser providers normalize their native output into :class:`ParsedDocument`.
The rest of the application consumes this model instead of depending on a
provider-specific directory layout or JSON schema.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PARSED_DOCUMENT_FILENAME = "parsed_document.json"
PARSED_DOCUMENT_SCHEMA_VERSION = 1
_IGNORED_BLOCK_TYPES = frozenset({"footer", "page_number", "header"})


@dataclass(slots=True)
class ParsedBlock:
    """One normalized document block.

    ``metadata`` intentionally preserves provider fields that do not yet have a
    first-class representation, so adding a provider does not discard useful
    table, formula, chart, or layout information.
    """

    kind: str
    text: str = ""
    page_idx: int | None = None
    asset_ref: str | None = None
    source_name: str = "document"
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_content_item(
        cls,
        item: dict[str, Any],
        *,
        json_dir: Path,
        artifact_dir: Path,
        source_name: str,
    ) -> ParsedBlock:
        raw = dict(item)
        kind = str(raw.pop("type", "unknown") or "unknown").strip()
        text = str(raw.pop("text", raw.pop("content", "")) or "")
        page_raw = raw.pop("page_idx", None)
        try:
            page_idx = int(page_raw) if page_raw is not None else None
        except (TypeError, ValueError):
            page_idx = None

        asset_ref: str | None = None
        raw_asset = raw.pop("img_path", None)
        if raw_asset:
            value = str(raw_asset)
            if value.startswith(("http://", "https://")):
                asset_ref = value
            else:
                absolute = (json_dir / value).resolve()
                try:
                    asset_ref = absolute.relative_to(artifact_dir.resolve()).as_posix()
                except ValueError:
                    asset_ref = str(absolute)

        return cls(
            kind=kind,
            text=text,
            page_idx=page_idx,
            asset_ref=asset_ref,
            source_name=source_name,
            metadata=raw,
        )

    def resolved_asset(self, artifact_dir: Path) -> str | None:
        if not self.asset_ref or self.asset_ref.startswith(("http://", "https://")):
            return self.asset_ref
        path = Path(self.asset_ref)
        return str(path if path.is_absolute() else (artifact_dir / path).resolve())

    def as_content_item(self, artifact_dir: Path) -> dict[str, Any]:
        """Return a compatibility mapping for existing chunk formatters."""
        item = dict(self.metadata)
        item["type"] = self.kind
        if self.text:
            item["text"] = self.text
        if self.page_idx is not None:
            item["page_idx"] = self.page_idx
        asset = self.resolved_asset(artifact_dir)
        if asset:
            item["img_path"] = asset
        return item

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "text": self.text,
            "page_idx": self.page_idx,
            "asset_ref": self.asset_ref,
            "source_name": self.source_name,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ParsedBlock:
        return cls(
            kind=str(data.get("kind") or "unknown"),
            text=str(data.get("text") or ""),
            page_idx=data.get("page_idx") if isinstance(data.get("page_idx"), int) else None,
            asset_ref=str(data["asset_ref"]) if data.get("asset_ref") else None,
            source_name=str(data.get("source_name") or "document"),
            metadata=dict(data.get("metadata") or {}),
        )


@dataclass(slots=True)
class ParsedDocument:
    source_name: str
    provider: str
    artifact_dir: Path
    blocks: list[ParsedBlock]
    page_count: int | None = None

    @property
    def artifact_path(self) -> Path:
        return self.artifact_dir / PARSED_DOCUMENT_FILENAME

    def save(self) -> Path:
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": PARSED_DOCUMENT_SCHEMA_VERSION,
            "source_name": self.source_name,
            "provider": self.provider,
            "page_count": self.page_count,
            "blocks": [block.to_dict() for block in self.blocks],
        }
        self.artifact_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return self.artifact_path

    def content_items(self, *, skip_ignored: bool = True) -> list[dict[str, Any]]:
        return [
            block.as_content_item(self.artifact_dir)
            for block in self.blocks
            if not skip_ignored or block.kind not in _IGNORED_BLOCK_TYPES
        ]

    def grouped_content_items(self) -> list[tuple[str, list[dict[str, Any]]]]:
        groups: dict[str, list[dict[str, Any]]] = {}
        for block in self.blocks:
            if block.kind in _IGNORED_BLOCK_TYPES:
                continue
            groups.setdefault(block.source_name, []).append(block.as_content_item(self.artifact_dir))
        return list(groups.items())

    def extracted_text(self) -> str:
        texts: list[str] = []
        for block in self.blocks:
            text = block.text.strip()
            if block.kind == "table" and not text:
                text = str(block.metadata.get("html") or "").strip()
            if block.kind in {"text", "table", "equation", "code", "list", "chart"} and text:
                texts.append(text)
        return "\n\n".join(texts)


def _content_list_files(artifact_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in artifact_dir.rglob("*_content_list.json")
        if "_content_list_v2" not in path.name
    )


def document_from_content_lists(
    artifact_dir: Path,
    *,
    source_name: str,
    provider: str,
) -> ParsedDocument:
    """Normalize legacy/provider ``content_list`` artifacts into the domain model."""
    json_files = _content_list_files(artifact_dir)
    if not json_files:
        raise FileNotFoundError(f"No parse artifacts under {artifact_dir}")

    blocks: list[ParsedBlock] = []
    for path in json_files:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise TypeError(f"Parse artifact must contain a list: {path}")
        sub_source = path.stem.removesuffix("_content_list")
        blocks.extend(
            ParsedBlock.from_content_item(
                item,
                json_dir=path.parent,
                artifact_dir=artifact_dir,
                source_name=sub_source,
            )
            for item in raw
            if isinstance(item, dict)
        )

    page_indexes = [block.page_idx for block in blocks if block.page_idx is not None]
    page_count = max(page_indexes) + 1 if page_indexes else None
    return ParsedDocument(
        source_name=source_name,
        provider=provider,
        artifact_dir=artifact_dir,
        blocks=blocks,
        page_count=page_count,
    )


def load_parsed_document(artifact_dir: Path) -> ParsedDocument:
    """Load the canonical artifact, falling back to legacy content-list caches."""
    canonical = artifact_dir / PARSED_DOCUMENT_FILENAME
    if canonical.is_file():
        data = json.loads(canonical.read_text(encoding="utf-8"))
        version = data.get("schema_version")
        if version != PARSED_DOCUMENT_SCHEMA_VERSION:
            raise ValueError(f"Unsupported parsed document schema version: {version}")
        return ParsedDocument(
            source_name=str(data.get("source_name") or artifact_dir.name),
            provider=str(data.get("provider") or "unknown"),
            artifact_dir=artifact_dir,
            blocks=[ParsedBlock.from_dict(item) for item in data.get("blocks", [])],
            page_count=data.get("page_count") if isinstance(data.get("page_count"), int) else None,
        )

    return document_from_content_lists(
        artifact_dir,
        source_name=artifact_dir.name,
        provider="legacy-content-list",
    )


def has_parsed_document(artifact_dir: Path) -> bool:
    if (artifact_dir / PARSED_DOCUMENT_FILENAME).is_file():
        return True
    return any(_content_list_files(artifact_dir))


def blocks_of_kind(document: ParsedDocument, kinds: Iterable[str]) -> list[ParsedBlock]:
    accepted = set(kinds)
    return [block for block in document.blocks if block.kind in accepted]
