"""Pure render-segment normalization and cache identities."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class SegmentRange:
    start_ms: int
    end_ms: int
    annotation_ids: tuple[str, ...]
    digest: str


def canonical_hash(start_ms: int, end_ms: int, annotations: list[dict[str, Any]]) -> str:
    payload = {
        "startMs": start_ms,
        "endMs": end_ms,
        "annotations": sorted(annotations, key=lambda item: item["annotationId"]),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def merged_ranges(annotations: list[dict[str, Any]], duration_ms: int) -> list[SegmentRange]:
    ordered = sorted(
        annotations, key=lambda item: (item["startMs"], item["endMs"], item["annotationId"])
    )
    result: list[SegmentRange] = []
    group: list[dict[str, Any]] = []
    start = end = 0
    for annotation in ordered:
        if not 0 <= annotation["startMs"] < annotation["endMs"] <= duration_ms:
            raise ValueError("CONTRACT_INVALID")
        if group and annotation["startMs"] - end >= 1000:
            result.append(
                SegmentRange(
                    start,
                    end,
                    tuple(item["annotationId"] for item in group),
                    canonical_hash(start, end, group),
                )
            )
            group = []
        if not group:
            start, end = annotation["startMs"], annotation["endMs"]
        else:
            end = max(end, annotation["endMs"])
        group.append(annotation)
    if group:
        result.append(
            SegmentRange(
                start,
                end,
                tuple(item["annotationId"] for item in group),
                canonical_hash(start, end, group),
            )
        )
    return result
