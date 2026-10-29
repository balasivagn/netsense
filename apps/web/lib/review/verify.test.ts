// @vitest-environment node
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import config from "../../../../config/pipeline_config.v1.json";
import fixture from "../../../../fixtures/synthetic/review-verification.json";
import { validateTrack } from "../overlay/track";
import { verifyRange } from "./verify";
// Executes the actual Python checker on the same synthetic cases. No duplicated
// Python coverage algorithm and no new threshold independent of pinned config.
test("TypeScript range verdicts match actual Python checker outcomes on shared synthetic cases", () => {
  const result = JSON.parse(
    execFileSync(
      "uv",
      [
        "run",
        "--project",
        "runner",
        "python",
        "-c",
        `
import json, sys
from netsense_runner.contracts.CheckInput import CheckInput
from netsense_runner.contracts.TrackFile import TrackFile
from netsense_runner.rules.checker import CheckerConfig, check_marks
v=json.load(sys.stdin)
out=[]
for c in v['cases']:
    track={**v['track'], 'gaps':c.get('gaps',[]), 'swaps':c.get('swaps',[])}
    value=CheckInput.model_validate({'remarkId':'synthetic-r1', 'momentStartMs':0, 'momentEndMs':1900, 'marks':[{'markId':'synthetic-m1','markType':'circle','anchor':'box_top','arrowFrom':None,'startMs':c['start'],'endMs':c['end'],'labelSpan':None,'labelText':'Batter','neutralLabel':'Batter'}], 'transcriptTurns':[], 'trackFileRef':'synthetic-track'})
    out.append(check_marks(value,TrackFile.model_validate(track),CheckerConfig(min_mark_coverage=v['minimum']), 'batter').verdicts[0].pass_)
print(json.dumps(out))
`,
      ],
      {
        input: JSON.stringify({
          ...fixture,
          minimum: config.params.minMarkCoverage,
        }),
        encoding: "utf8",
      },
    ),
  );
  const actual = fixture.cases.map((c) => {
    const t = validateTrack(
      { ...fixture.track, gaps: c.gaps ?? [], swaps: c.swaps ?? [] },
      1280,
      720,
      2000,
    );
    try {
      verifyRange(t, c.start, c.end, config.params.minMarkCoverage, "tracked");
      return true;
    } catch {
      return false;
    }
  });
  expect(actual).toEqual(fixture.cases.map((c) => c.pass));
  expect(actual).toEqual(result);
});
