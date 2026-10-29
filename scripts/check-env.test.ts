import { expect, test } from "vitest";
import { missingNames } from "./check-env";
test("reports names only, including blank values", () => {
  expect(
    missingNames("# comment\nA=\nB=\nC=\n", { A: "present", B: " " }),
  ).toEqual(["B", "C"]);
});
