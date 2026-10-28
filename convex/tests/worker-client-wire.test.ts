// @vitest-environment node
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { running } from "./persistenceHelpers";

test("Python client accepts actual Convex worker projections before and after persistence", async () => {
  const c = await running();
  for (const populated of [false, true]) {
    if (populated) await c.base();
    const response = await c.t.fetch("/worker/job", {
      headers: { authorization: `Bearer ${c.token}` },
    });
    expect(response.status).toBe(200);
    const result = spawnSync("uv", ["run", "--project", "runner", "python", "-c", [
      "import sys",
      "from netsense_runner.clients.worker_wire import WorkerJobResponse",
      "try:",
      "    WorkerJobResponse.model_validate_json(sys.stdin.read())",
      "except Exception:",
      "    sys.exit(2)",
    ].join("\n")], { input: await response.text(), encoding: "utf8", timeout: 15000 });
    // Report no projection or validation detail (it can contain coach words).
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  }
}, 30000);
