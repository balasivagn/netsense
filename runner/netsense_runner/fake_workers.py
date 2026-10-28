"""Explicit synthetic development workers; renderer emits a JSON test stub only.

Not registered automatically. No vendor transport, UI seed, or live fallback.
Use the real TranscodeWorker and CheckRulesWorker alongside these workers.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import cast

from netsense_runner.artifacts import ArtifactStore, canonical, digest
from netsense_runner.context import StageContext
from netsense_runner.json_types import JsonValue
from netsense_runner.providers.fake import FakeProvider, FakeProviderRefused
from netsense_runner.stage import StageKey, StageResult, WorkerType

_CONTRACTS: dict[str, tuple[StageKey, WorkerType, str]] = {
    "TranscribeInput": ("transcribe", "model", "TranscribeOutput"),
    "PlanInput": ("plan", "agent", "PlanOutput"),
    "MomentInput": ("moment", "sub_agent", "MomentOutput"),
    "SubjectAnchorInput": ("subject", "sub_agent", "SubjectAnchorOutput"),
    "SubjectInput": ("subject", "sub_agent", "SubjectOutput"),
    "TrackInput": ("track", "tool", "TrackOutput"),
    "PlaceInput": ("place", "sub_agent", "PlaceOutput"),
    "RenderInput": ("render", "tool", "RenderOutput"),
}


class FakeWorker:
    id: str
    stage: StageKey
    worker_type: WorkerType
    input_contract: str
    output_contract: str

    def __init__(
        self,
        worker_id: str,
        contract: str,
        fixtures: Path,
        artifacts: ArtifactStore,
        stream_fixture: str = "stream.json",
    ) -> None:
        environment = os.environ.get("NETSENSE_ENV", "").strip().lower()
        if environment not in {"test", "development"}:
            raise FakeProviderRefused("FAKE_PROVIDER_REFUSED")
        self.provider = FakeProvider.from_environment(fixtures)
        self.id, self.input_contract = worker_id, contract
        self.stage, self.worker_type, self.output_contract = _CONTRACTS[contract]
        self.store = artifacts
        self.stream_fixture = stream_fixture

    def run(self, input_value: Mapping[str, JsonValue], ctx: StageContext) -> StageResult:
        # Guard again at execution; constructing under test cannot enable production use.
        if os.environ.get("NETSENSE_ENV", "").strip().lower() not in {"test", "development"}:
            raise FakeProviderRefused("FAKE_PROVIDER_REFUSED")
        copy = json.loads(self.provider.response("copy.json"))
        v = dict(input_value)
        root = f"sessions/{ctx.session_id}/runs/{ctx.job_id}/{ctx.stage_run_id}"
        if self.stage in {"transcribe", "plan"}:
            output = json.loads(self.provider.response(self.stage + ".json"))
        elif self.stage == "moment":
            frames = cast(list[dict[str, JsonValue]], v["frames"])
            if len(frames) < 2:
                return self._failure("MOMENT_FAILED")
            first, last = frames[-2:]
            output = {
                "remarkId": v["remarkId"],
                "startMs": first["ms"],
                "endMs": last["ms"],
                "keyframeMs": first["ms"],
                "keyframeIdx": first["idx"],
                "candidates": [],
                "why": copy["momentWhy"],
                "confidence": "high",
            }
        elif self.input_contract == "SubjectAnchorInput":
            people = json.loads(self.provider.response("people.json"))
            subject = cast(dict[str, JsonValue], v["subject"])
            point = cast(dict[str, float], subject["point"])
            x, y = point["x"] * people["width"], point["y"] * people["height"]
            matches = [
                p
                for p in people["people"]
                if p["box"]["x1"] <= x <= p["box"]["x2"] and p["box"]["y1"] <= y <= p["box"]["y2"]
            ]
            if len(matches) != 1:
                return self._failure("SUBJECT_NEEDED", "needs_coach")
            ctx.budget.reserve_sam_frames(1)
            crop = root + ".synthetic-crop.json"
            self.store.put_new(crop, canonical(matches[0]), "application/json")
            output = {
                "anchorBox": matches[0]["box"],
                "anchorFrameMs": subject["frameMs"],
                "referenceCropKey": crop,
                "confidence": 1.0,
            }
        elif self.stage == "subject":
            output = {
                "remarkId": v["remarkId"],
                "target": {
                    "role": v["subjectRole"],
                    "promptBox": v["anchorBox"],
                    "promptPoint": None,
                    "frameMs": v["keyframeMs"],
                },
                "method": "anchor_reuse",
                "why": copy["subjectWhy"],
                "confidence": "high",
                "candidatesCount": 3,
            }
        elif self.stage == "track":
            people_data = json.loads(self.provider.response("people.json"))
            people = people_data["people"]
            selected = next((p["id"] for p in people if p["box"] == v["promptBox"]), None)
            if selected is None:
                return self._failure("SEG_NO_TRACK")
            raw = json.loads(self.provider.response(self.stream_fixture))["frames"]
            observations = [f for f in raw if v["windowStartMs"] <= f["ms"] < v["windowEndMs"]]
            ctx.budget.reserve_sam_frames(len(observations))
            frames, gaps, swaps = [], [], []
            last_box = None
            for frame in observations:
                person = next((p for p in frame["objects"] if p["id"] == selected), None)
                if person is None:
                    gaps.append([frame["ms"], frame["ms"] + 100])
                    continue  # Never silently switch to another visible identity.
                box = person["box"]
                if last_box and abs(box["x1"] - last_box["x1"]) > people_data["width"] * 0.25:
                    swaps.append({"ms": frame["ms"], "reason": "jump"})
                frames.append({"ms": frame["ms"], "box": box, "conf": 1.0})
                last_box = box
            if not frames:
                return self._failure("SEG_NO_TRACK")
            key = root + ".track.json"
            self.store.put_new(
                key,
                canonical(
                    {"fps": 10, "subjectOnly": True, "frames": frames, "gaps": gaps, "swaps": swaps}
                ),
                "application/json",
            )
            output = {
                "remarkId": v["remarkId"],
                "trackId": "track-" + digest(v),
                "role": v["role"],
                "mode": v["mode"],
                "fileRef": key,
                "maskRef": None,
                "coverage": len(frames) / len(observations),
                "framesBilled": 0,
                "cacheHit": False,
                "swapSuspected": bool(swaps),
                "reassociations": 0,
            }
        elif self.stage == "place":
            spans = cast(list[dict[str, JsonValue]], v["turnSpans"])
            output = {
                "remarkId": v["remarkId"],
                "marks": [
                    {
                        "markId": str(v["remarkId"]) + "-mark",
                        "markType": "circle",
                        "anchor": "box_top",
                        "arrowFrom": None,
                        "startMs": v["momentStartMs"],
                        "endMs": v["momentEndMs"],
                        "labelSpan": {
                            "turnId": spans[0]["turnId"],
                            "start": 0,
                            "end": spans[0]["length"],
                        },
                        "labelText": "",
                        "neutralLabel": None,
                    }
                ],
                "why": copy["placeWhy"],
            }
        else:
            key = root + ".render-test-stub.json"
            self.store.put_new(key, canonical({"testStub": True, "input": v}), "application/json")
            output = {
                "kind": "preview",
                "mode": v["mode"],
                "fileRef": key,
                "stillRefs": [],
                "segmentRefs": [],
                "durationMs": v["durationMs"],
            }
        return {
            "status": "done",
            "output": output,
            "error_code": None,
            "usage": {"samFrames": 0, "inputTokens": 0, "outputTokens": 0, "audioSeconds": 0},
            "cost_usd": 0,
            "trace": None,
        }

    @staticmethod
    def _failure(code: str, status: str = "failed") -> StageResult:
        return {
            "status": "needs_coach" if status == "needs_coach" else "failed",
            "output": None,
            "error_code": code,
            "usage": {"samFrames": 0, "inputTokens": 0, "outputTokens": 0, "audioSeconds": 0},
            "cost_usd": 0,
            "trace": None,
        }
