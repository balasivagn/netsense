"""Test-only cache replay through the real Next signing/media HTTP boundary."""
import json
import os
import time
from pathlib import Path

from netsense_runner.budget import Budget
from netsense_runner.clients.convex_worker import ConvexWorkerClient
from netsense_runner.context import StageContext
from netsense_runner.contracts.PipelineConfig import PipelineConfig
from netsense_runner.contracts.RenderInput import Annotation
from netsense_runner.host import NoPaidLedger, SafeLog
from netsense_runner.host_storage import HttpStorage, LocalArtifacts
from netsense_runner.media.segments import build_segments
from netsense_runner.registry import ProviderRegistry
from netsense_runner.stages.s8_render import RenderWorker

root = Path(os.environ["NETSENSE_ARTIFACT_ROOT"])
value = json.loads((root / "replay.json").read_text())
session = os.environ["NETSENSE_SESSION"]
artifacts = LocalArtifacts(root, session)
storage = HttpStorage(os.environ["VM_API_BASE_URL"], os.environ["NETSENSE_JOB_TOKEN"], session, root / "replay-scratch", artifacts)
config = PipelineConfig.model_validate(json.loads(Path("config/pipeline_config.v1.json").read_text()))
value["segments"] = [s.model_dump() for s in build_segments([Annotation.model_validate(a) for a in value["annotations"]], value["durationMs"])]
worker = RenderWorker(download=storage.download, track_loader=storage.load, object_exists=storage.exists, reject_cache=storage.reject_cache)
key = value["previousSegments"][0]["key"]
path = root / key
before = path.stat()


def render():
    ctx = StageContext("job", session, 1, "run", None, 1, time.monotonic() + 30, Budget(config.limits, NoPaidLedger()), storage, ConvexWorkerClient(os.environ["CONVEX_SITE_URL"], os.environ["NETSENSE_JOB_TOKEN"]), ProviderRegistry({}), SafeLog())
    result = worker.run(value, ctx)
    assert result["status"] == "done", "CACHE_RENDER_FAILED"


render()
assert path.stat().st_ino == before.st_ino and path.stat().st_mtime_ns == before.st_mtime_ns
path.unlink()
assert not storage.exists(key, timeout_s=2)
render()
assert path.exists()
path.write_bytes(b"corrupt")
render()
assert path.stat().st_size > 7
assert list(path.parent.glob(".corrupt-*"))
print("CACHE_REUSE_MISSING_CORRUPT_PASSED")
