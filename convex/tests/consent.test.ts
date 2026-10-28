import { expect, test } from "vitest";
import { api } from "../_generated/api";
import { data, setup } from "./helpers";

test("sessions have no consent confirmation until their owner confirms", async () => {
  const { t, coach, sessionId } = await setup();
  const before = await t.run((ctx) => ctx.db.get(sessionId));
  expect(before?.consentConfirmedAt).toBeUndefined();
  expect(before?.consentConfirmedBy).toBeUndefined();

  // convex-test pins a monotonic transaction clock, which can lead wall time.
  const beforeConfirmation = await t.run(async () => Date.now());
  await coach.mutation(api.sessions.confirmConsent, { sessionId });
  const afterConfirmation = await t.run(async () => Date.now());

  expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
    consentConfirmedBy: data.identity.subject,
  });
  const confirmed = await t.run((ctx) => ctx.db.get(sessionId));
  expect(confirmed?.consentConfirmedAt).toBeGreaterThanOrEqual(
    beforeConfirmation,
  );
  expect(confirmed?.consentConfirmedAt).toBeLessThanOrEqual(afterConfirmation);
});

test("only an authenticated, registered owner may confirm without writing", async () => {
  const { t, other, sessionId } = await setup();
  const unregistered = t.withIdentity({ subject: "synthetic-unregistered" });
  const before = await t.run((ctx) => ctx.db.get(sessionId));

  await expect(
    t.mutation(api.sessions.confirmConsent, { sessionId }),
  ).rejects.toThrow("UNAUTHENTICATED");
  await expect(
    unregistered.mutation(api.sessions.confirmConsent, { sessionId }),
  ).rejects.toThrow("COACH_NOT_REGISTERED");
  await expect(
    other.mutation(api.sessions.confirmConsent, { sessionId }),
  ).rejects.toThrow("NOT_FOUND");

  expect(await t.run((ctx) => ctx.db.get(sessionId))).toEqual(before);
});

test("confirmation ignores caller-supplied identity and time and remains immutable", async () => {
  const { t, coach, sessionId } = await setup();
  await expect(
    coach.mutation(api.sessions.confirmConsent, {
      sessionId,
      consentConfirmedAt: 1,
      consentConfirmedBy: data.otherIdentity.subject,
    } as never),
  ).rejects.toThrow("Unexpected field");
  expect(
    (await t.run((ctx) => ctx.db.get(sessionId)))?.consentConfirmedAt,
  ).toBeUndefined();

  await coach.mutation(api.sessions.confirmConsent, { sessionId });
  const first = await t.run((ctx) => ctx.db.get(sessionId));

  await new Promise((resolve) => setTimeout(resolve, 5));
  await coach.mutation(api.sessions.confirmConsent, { sessionId });

  expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
    consentConfirmedBy: data.identity.subject,
  });
  expect(await t.run((ctx) => ctx.db.get(sessionId))).toMatchObject({
    consentConfirmedAt: first?.consentConfirmedAt,
    consentConfirmedBy: first?.consentConfirmedBy,
  });
});

test("concurrent owner confirmations preserve one first confirmation", async () => {
  const { t, coach, sessionId } = await setup();
  await Promise.all([
    coach.mutation(api.sessions.confirmConsent, { sessionId }),
    coach.mutation(api.sessions.confirmConsent, { sessionId }),
  ]);

  const confirmed = await t.run((ctx) => ctx.db.get(sessionId));
  expect(confirmed).toMatchObject({
    consentConfirmedBy: data.identity.subject,
  });
  expect(confirmed?.consentConfirmedAt).toBeTypeOf("number");
});
