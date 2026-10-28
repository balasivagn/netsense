import { expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { setup, tap, data } from "./helpers";
test("signed out reads and writes fail; bootstrap is idempotent", async () => {
  const { t, coach, coachId, sessionId } = await setup();
  await expect(t.query(api.sessions.list, {})).rejects.toThrow(
    "UNAUTHENTICATED",
  );
  await expect(
    t.mutation(api.students.add, { label: data.studentLabel }),
  ).rejects.toThrow("UNAUTHENTICATED");
  await expect(
    t.mutation(api.sessions.setSubject, { sessionId, ...tap }),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(await coach.mutation(api.coaches.ensure, {})).toBe(coachId);
  expect(await t.run((ctx) => ctx.db.query("coaches").collect())).toHaveLength(
    2,
  );
});
test("second coach cannot read or mutate first coach session or use their student", async () => {
  const { other, sessionId, studentId } = await setup();
  expect(await other.query(api.sessions.list, {})).toEqual([]);
  expect(await other.query(api.students.list, {})).toEqual([]);
  await expect(other.query(api.sessions.get, { sessionId })).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(
    other.mutation(api.sessions.setSubject, { sessionId, ...tap }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    other.mutation(api.sessions.setRenderMode, {
      sessionId,
      renderMode: "stills",
    }),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    other.mutation(api.sessions.create, {
      studentId,
      subjectRole: "batter",
      captureMode: "camera_roll",
    }),
  ).rejects.toThrow("NOT_FOUND");
});
test("empty labels fail and config seed is idempotent", async () => {
  const { t, coach } = await setup();
  await expect(
    coach.mutation(api.students.add, { label: " " }),
  ).rejects.toThrow("INVALID_LABEL");
  const first = await t.mutation(internal.config.seed, {});
  expect(await t.mutation(internal.config.seed, {})).toBe(first);
  expect(
    await t.run((ctx) => ctx.db.query("pipeline_config").collect()),
  ).toHaveLength(1);
});
