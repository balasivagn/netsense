import { expect } from "vitest";
import { api } from "../_generated/api";
import { running, post } from "./persistenceHelpers";
export async function reviewReady() {
  const c = await running();
  await c.base();
  const p = await c.start("place", "synthetic-r1");
  expect(
    (
      await c.persist("marks", p, c.f.marks, {
        provenance: await c.provenance(p),
      })
    ).status,
  ).toBe(200);
  await c.finish(p);
  await c.step("check", "verdicts", "synthetic-r1");
  await c.step("render", "render");
  expect(
    (
      await c.t.fetch(
        "/worker/done",
        post({ status: "waiting_for_coach" }, c.token),
      )
    ).status,
  ).toBe(200);
  const data = await c.coach.query(api.playback.get, {
    sessionId: c.sessionId,
  });
  return { ...c, view: data, id: data.annotations[0].id };
}
