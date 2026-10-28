"""Code-owned stage inputs and verbatim text projection (UTF-16 spans)."""

from __future__ import annotations

from collections.abc import Mapping
from unicodedata import category

from netsense_runner.artifacts import digest, model_value, validated
from netsense_runner.clients.worker_wire import WorkerJobResponse
from netsense_runner.contract_text import slice_coach_span
from netsense_runner.contracts.MomentOutput import MomentOutput
from netsense_runner.contracts.PlaceOutput import PlaceOutput
from netsense_runner.contracts.PlanOutput import FanOutItem, PlanOutput, Remark
from netsense_runner.contracts.SubjectAnchorOutput import SubjectAnchorOutput
from netsense_runner.contracts.SubjectOutput import SubjectOutput
from netsense_runner.contracts.TrackFile import TrackFile
from netsense_runner.contracts.TrackOutput import TrackOutput
from netsense_runner.contracts.TranscodeOutput import TranscodeOutput
from netsense_runner.contracts.TranscribeOutput import TranscribeOutput
from netsense_runner.json_types import JsonValue


def _word(char: str) -> bool:
    return char == "_" or category(char)[0] in {"L", "N", "M"}


def utf16(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def lexical(text: str) -> bytes:
    return text.encode("utf-16-be")


def words(plan: PlanOutput, turns: TranscribeOutput) -> PlanOutput:
    result = plan.model_copy(deep=True)
    lookup = {t.turnId: t for t in turns.turns}
    seen: set[str] = set()
    if len(lookup) != len(turns.turns) or len({r.remarkId for r in result.remarks}) != len(
        result.remarks
    ):
        raise ValueError("VERBATIM_MISMATCH")
    for remark in result.remarks:
        ordered = sorted(
            (lookup[t] for t in remark.turnIds), key=lambda t: (t.startMs, lexical(t.turnId))
        )
        if (
            not ordered
            or any(t.turnId in seen for t in ordered)
            or len({t.turnId for t in ordered}) != len(ordered)
        ):
            raise ValueError("VERBATIM_MISMATCH")
        seen.update(t.turnId for t in ordered)
        remark.turnIds = [t.turnId for t in ordered]
        remark.coachWords = " ".join(t.text for t in ordered)
        remark.atMs = ordered[0].startMs
    result.fanOut = [
        FanOutItem(remarkId=r.remarkId, stages=["moment", "subject", "track", "place", "check"])
        for r in result.remarks
        if r.aboutSubject in {"yes", "unclear"}
    ]
    validated("PlanOutput", model_value(result))
    return result


def labels(
    output: PlaceOutput, remark: Remark, turns: TranscribeOutput, role: str, number: int, cap: int
) -> PlaceOutput:
    result = output.model_copy(deep=True)
    lookup = {t.turnId: t.text for t in turns.turns if t.turnId in remark.turnIds}
    neutral = {"batter": "Batter", "bowler": "Bowler", "other": "Player"}[role]
    for mark in result.marks:
        span = mark.labelSpan
        if span is not None:
            text = lookup[span.turnId]
            copied = slice_coach_span(text, span.start, span.end)
            prefix = text.encode("utf-16-le")[: span.start * 2].decode("utf-16-le")
            suffix = text.encode("utf-16-le")[span.end * 2 :].decode("utf-16-le")
            if (
                (prefix and _word(prefix[-1]) and _word(copied[0]))
                or (suffix and _word(suffix[0]) and _word(copied[-1]))
                or mark.neutralLabel is not None
            ):
                raise ValueError("VERBATIM_MISMATCH")
            if utf16(copied) > min(60, cap):
                candidates = [
                    i
                    for i in range(1, len(copied) + 1)
                    if utf16(copied[:i]) <= min(60, cap)
                    and (i == len(copied) or not (_word(copied[i - 1]) and _word(copied[i])))
                ]
                if not candidates:
                    raise ValueError("VERBATIM_MISMATCH")
                copied = copied[: max(candidates)].rstrip()
                if not copied:
                    raise ValueError("VERBATIM_MISMATCH")
                span.end = span.start + utf16(copied)
            mark.labelText = copied
        elif mark.neutralLabel == "Remark":
            mark.labelText = f"Remark {number}"
        elif mark.neutralLabel == neutral:
            mark.labelText = neutral
        else:
            raise ValueError("VERBATIM_MISMATCH")
        if utf16(mark.labelText) > min(60, cap):
            raise ValueError("VERBATIM_MISMATCH")
    validated("PlaceOutput", model_value(result))
    return result


def moment_input(
    remark: Remark, previous: int, frames: list[dict[str, JsonValue]], job: WorkerJobResponse
) -> dict[str, JsonValue]:
    low = max(previous, remark.atMs - job.config.params.momentLookbackMs, 0)
    selected = [
        f for f in frames if isinstance(f["ms"], int) and low <= f["ms"] <= remark.atMs + 1000
    ][:26]
    return {
        "remarkId": remark.remarkId,
        "coachWords": remark.coachWords,
        "atMs": remark.atMs,
        "subjectRole": job.session.subjectRole,
        "frames": [dict(f) for f in selected],
        "previousRemarkAtMs": previous,
    }


def subject_input(
    remark: Remark,
    moment: MomentOutput,
    anchor: SubjectAnchorOutput,
    frames: list[dict[str, JsonValue]],
    role: str,
) -> dict[str, JsonValue]:
    frame = next(
        f for f in frames if f["idx"] == moment.keyframeIdx and f["ms"] == moment.keyframeMs
    )
    return {
        "remarkId": remark.remarkId,
        "coachWords": remark.coachWords,
        "subjectRole": role,
        "referenceCropKey": anchor.referenceCropKey,
        "anchorBox": model_value(anchor.anchorBox),
        "anchorFrameMs": anchor.anchorFrameMs,
        "keyframeKey": frame["key"],
        "keyframeMs": moment.keyframeMs,
        "pointPrompt": None,
    }


def track_input(
    remark: Remark,
    moment: MomentOutput,
    subject: SubjectOutput,
    media: TranscodeOutput,
    proxy_hash: str,
    job: WorkerJobResponse,
) -> dict[str, JsonValue]:
    pad = job.config.params.trackPadMs
    return {
        "remarkId": remark.remarkId,
        "mode": "still" if job.session.renderMode == "stills" else "video",
        "proxyKey": media.proxyKey,
        "windowStartMs": max(0, moment.startMs - pad),
        "windowEndMs": min(media.durationMs, moment.endMs + pad),
        "promptFrameMs": subject.target.frameMs,
        "promptBox": model_value(subject.target.promptBox),
        "promptPoint": None
        if subject.target.promptPoint is None
        else model_value(subject.target.promptPoint),
        "role": job.session.subjectRole,
        "downsampleFps": job.config.params.downsampleFps.root
        if job.config.params.downsampleFps
        else None,
        "proxySha256": proxy_hash,
    }


def cache_key(value: Mapping[str, JsonValue]) -> str:
    # SPEC 7.5: proxy | window | prompt | downsample, canonical JSON components.
    return digest(
        [
            value["proxySha256"],
            [value["windowStartMs"], value["windowEndMs"]],
            [value["mode"], value["promptFrameMs"], value["promptBox"], value["promptPoint"]],
            value["downsampleFps"],
        ]
    )


def place_input(
    remark: Remark,
    moment: MomentOutput,
    track: TrackOutput,
    file: TrackFile,
    turns: TranscribeOutput,
    number: int,
    job: WorkerJobResponse,
) -> dict[str, JsonValue]:
    frame = next(f for f in file.frames if f.ms == moment.keyframeMs)
    return {
        "remarkId": remark.remarkId,
        "coachWords": remark.coachWords,
        "turnSpans": [
            {"turnId": t.turnId, "length": utf16(t.text)}
            for t in turns.turns
            if t.turnId in remark.turnIds
        ],
        "role": job.session.subjectRole,
        "momentStartMs": moment.startMs,
        "momentEndMs": moment.endMs,
        "keyframeMs": moment.keyframeMs,
        "boxAtKeyframe": model_value(frame.box),
        "coverage": track.coverage,
        "allowedMarkTypes": list(job.config.params.allowedMarkTypes),
        "remarkNumber": number,
    }
