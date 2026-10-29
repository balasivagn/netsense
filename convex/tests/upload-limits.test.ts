import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { api, internal } from "../_generated/api";
import { setup, data } from "./helpers";

test("private local reservation accepts exactly 2 GiB and rejects above before writes", async () => {
  const c = await setup(false);
  await c.t.run((ctx) => ctx.db.delete(c.uploadId));
  await c.coach.mutation(api.sessions.confirmConsent, {
    sessionId: c.sessionId,
  });
  const input = {
    sessionId: c.sessionId,
    coachId: c.coachId,
    sha256: data.upload.sha256,
    mimeType: "video/mp4",
    bytesTotal: 2 * 1024 ** 3 + 1,
    multipartUploadId: randomUUID(),
  };
  await expect(c.t.mutation(internal.uploads.reserve, input)).rejects.toThrow(
    "INVALID_REQUEST",
  );
  expect(await c.t.run((ctx) => ctx.db.query("uploads").collect())).toEqual([]);
  const row = await c.t.mutation(internal.uploads.reserve, {
    ...input,
    bytesTotal: 2 * 1024 ** 3,
  });
  expect(row.bytesTotal).toBe(2 * 1024 ** 3);
  expect(row.bytesConfirmed).toBe(0);
});
