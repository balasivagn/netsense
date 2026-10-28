import { convexTest } from "convex-test";
import type { Infer } from "convex/values";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import fixture from "../../fixtures/synthetic/contracts/foundation.json";
import { subject as subjectValidator } from "../validators";
export const modules = import.meta.glob("../**/*.ts");
export const data = fixture;
export const tap = fixture.subject as Omit<
  Infer<typeof subjectValidator>,
  "selectedBy" | "selectedAt"
>;
export async function setup(prepareUpload = true) {
  const t = convexTest(schema, modules);
  await t.mutation(internal.config.seed, {});
  const coach = t.withIdentity(data.identity);
  const other = t.withIdentity(data.otherIdentity);
  const coachId = await coach.mutation(api.coaches.ensure, {});
  await other.mutation(api.coaches.ensure, {});
  const studentId = await coach.mutation(api.students.add, {
    label: data.studentLabel,
  });
  const sessionId = await coach.mutation(api.sessions.create, {
    studentId,
    subjectRole: "batter",
    captureMode: "camera_roll",
  });
  if (prepareUpload)
    await coach.mutation(api.sessions.confirmConsent, { sessionId });
  const uploadId = await t.run((ctx) =>
    ctx.db.insert("uploads", {
      ...data.upload,
      phase: "completing",
      driver: "local",
      status: "in_progress",
      sessionId,
      coachId,
    }),
  );
  return { t, coach, other, coachId, studentId, sessionId, uploadId };
}
export async function ready() {
  const context = await setup();
  const { t, coach, sessionId, uploadId, coachId } = context;
  await coach.mutation(api.sessions.setSubject, { sessionId, ...tap });
  const jobId = await t.mutation(internal.uploads.complete, {
    uploadId,
    coachId,
    verifiedBytes: data.upload.bytesTotal,
    durationMs: 2000,
  });
  if (!jobId) throw Error("expected ready job");
  return { ...context, jobId };
}
