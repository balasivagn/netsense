import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ownedSession } from "./lib/auth";

const itemId = v.string();
const text = v.string();
const remarks = v.array(v.string());
const action = v.union(
  v.object({ kind: v.literal("approveFocus"), id: itemId }),
  v.object({ kind: v.literal("dismissFocus"), id: itemId }),
  v.object({
    kind: v.literal("editFocus"),
    id: itemId,
    title: text,
    remarkIds: remarks,
  }),
  v.object({
    kind: v.literal("addFocus"),
    id: itemId,
    title: text,
    remarkIds: remarks,
  }),
  v.object({ kind: v.literal("approvePractice"), id: itemId }),
  v.object({ kind: v.literal("dismissPractice"), id: itemId }),
  v.object({
    kind: v.literal("editPractice"),
    id: itemId,
    title: text,
    remarkIds: remarks,
  }),
  v.object({
    kind: v.literal("addPractice"),
    id: itemId,
    title: text,
    remarkIds: remarks,
  }),
  v.object({ kind: v.literal("approveNote"), noteIndex: v.number() }),
  v.object({ kind: v.literal("dismissNote"), noteIndex: v.number() }),
  v.object({ kind: v.literal("editNote"), noteIndex: v.number(), text }),
  v.object({ kind: v.literal("addNote"), text }),
);

function practiceEnabled() {
  const value = process.env.FEATURE_PRACTICE_PLAN;
  return (
    value === undefined || !["0", "false", "off"].includes(value.toLowerCase())
  );
}

function revision(lesson: Doc<"lessons"> | null) {
  return lesson
    ? `lesson:${lesson._id}:${lesson.revision ?? "0"}`
    : "lesson:none:0";
}

function nextRevision(lesson: Doc<"lessons">) {
  const previous = Number(lesson.revision ?? "0");
  return String(
    Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1,
  );
}

function validText(value: string, max = 400) {
  return value.trim().length > 0 && value.length <= max;
}

function validId(value: string) {
  return /^[A-Za-z0-9_-]{1,96}$/.test(value);
}

async function lessonFor(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  create = false,
  rejectBusy = false,
) {
  const session = await ownedSession(ctx, sessionId);
  const job = session.latestJobId
    ? await ctx.db.get(session.latestJobId)
    : null;
  if (
    rejectBusy &&
    job &&
    (job.sessionId !== session._id ||
      job.coachId !== session.coachId ||
      job.status === "queued" ||
      job.status === "running")
  )
    throw Error("JOB_IN_PROGRESS");
  const rows = await ctx.db
    .query("lessons")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
    .collect();
  const lesson = rows.find((row) => row.coachId === session.coachId) ?? null;
  if (rows.some((row) => row.coachId !== session.coachId))
    throw Error("NOT_FOUND");
  if (!lesson && !create) return { session, lesson: null };
  return { session, lesson };
}

async function validateRemarkIds(
  ctx: QueryCtx,
  session: Doc<"sessions">,
  ids: string[],
) {
  if (
    ids.length > 20 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !validId(id))
  )
    throw Error("INVALID_REMARKS");
  const owned = await ctx.db
    .query("remarks")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
    .collect();
  if (
    !ids.every((id) =>
      owned.some(
        (row) => row.coachId === session.coachId && row.remarkId === id,
      ),
    )
  )
    throw Error("INVALID_REMARKS");
}

function indexOf<T extends { id: string }>(items: T[], id: string) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) throw Error("NOT_FOUND");
  return index;
}

function noteAt(lesson: Doc<"lessons">, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= lesson.notes.length)
    throw Error("NOT_FOUND");
  return lesson.notes[index];
}

function requireAi(item: { source: "coach" | "ai_draft" }) {
  if (item.source !== "ai_draft") throw Error("INVALID_ACTION");
}

function requireFocusCapacity(
  items: Doc<"lessons">["focusPoints"],
  replacing?: number,
) {
  const approved = items.filter(
    (item, index) => item.approved && index !== replacing,
  ).length;
  if (approved >= 2) throw Error("FOCUS_LIMIT");
}

export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const { session, lesson } = await lessonFor(ctx, sessionId);
    const coach = await ctx.db.get(session.coachId);
    if (!coach) throw Error("NOT_FOUND");
    const showPractice = practiceEnabled();
    return {
      ownerUserId: coach.clerkUserId,
      revision: revision(lesson),
      practiceEnabled: showPractice,
      notes: lesson?.notes ?? [],
      focusPoints: lesson?.focusPoints ?? [],
      practice: showPractice ? (lesson?.practice ?? []) : [],
    };
  },
});

export const update = mutation({
  args: { sessionId: v.id("sessions"), expectedRevision: v.string(), action },
  handler: async (ctx, args) => {
    const found = await lessonFor(ctx, args.sessionId, true, true);
    let lesson = found.lesson;
    if (!lesson) {
      if (args.expectedRevision !== "lesson:none:0")
        throw Error("LESSON_CONFLICT");
      const id = await ctx.db.insert("lessons", {
        sessionId: found.session._id,
        coachId: found.session.coachId,
        notes: [],
        focusPoints: [],
        practice: [],
        revision: "0",
      });
      lesson = (await ctx.db.get(id))!;
    }
    if (revision(lesson) !== args.expectedRevision)
      throw Error("LESSON_CONFLICT");
    const practiceAction = args.action.kind.toLowerCase().includes("practice");
    if (practiceAction && !practiceEnabled()) throw Error("PRACTICE_DISABLED");

    const focusPoints = [...lesson.focusPoints];
    const practice = [...lesson.practice];
    const notes = [...lesson.notes];
    const dismissedFocusIds = new Set(lesson.dismissedFocusIds ?? []);
    const dismissedPracticeIds = new Set(lesson.dismissedPracticeIds ?? []);
    let dismissedAiNote = lesson.dismissedAiNote ?? false;

    switch (args.action.kind) {
      case "approveFocus": {
        const index = indexOf(focusPoints, args.action.id);
        requireAi(focusPoints[index]);
        if (focusPoints[index].approved) throw Error("INVALID_ACTION");
        requireFocusCapacity(focusPoints, index);
        focusPoints[index] = { ...focusPoints[index], approved: true };
        break;
      }
      case "dismissFocus": {
        const index = indexOf(focusPoints, args.action.id);
        const item = focusPoints[index];
        if (item.source === "ai_draft") dismissedFocusIds.add(item.id);
        focusPoints.splice(index, 1);
        break;
      }
      case "editFocus": {
        const index = indexOf(focusPoints, args.action.id);
        if (!validText(args.action.title)) throw Error("INVALID_TEXT");
        await validateRemarkIds(ctx, found.session, args.action.remarkIds);
        focusPoints[index] = {
          ...focusPoints[index],
          title: args.action.title,
          remarkIds: args.action.remarkIds,
          editedByCoach:
            focusPoints[index].source === "ai_draft"
              ? true
              : focusPoints[index].editedByCoach,
        };
        break;
      }
      case "addFocus": {
        const id = args.action.id;
        if (!validId(id) || focusPoints.some((item) => item.id === id))
          throw Error("DUPLICATE_ID");
        if (!validText(args.action.title)) throw Error("INVALID_TEXT");
        await validateRemarkIds(ctx, found.session, args.action.remarkIds);
        requireFocusCapacity(focusPoints);
        focusPoints.push({
          id,
          title: args.action.title,
          source: "coach",
          approved: true,
          remarkIds: args.action.remarkIds,
          editedByCoach: true,
        });
        break;
      }
      case "approvePractice": {
        const index = indexOf(practice, args.action.id);
        requireAi(practice[index]);
        if (practice[index].approved) throw Error("INVALID_ACTION");
        practice[index] = { ...practice[index], approved: true };
        break;
      }
      case "dismissPractice": {
        const index = indexOf(practice, args.action.id);
        const item = practice[index];
        if (item.source === "ai_draft") dismissedPracticeIds.add(item.id);
        practice.splice(index, 1);
        break;
      }
      case "editPractice": {
        const index = indexOf(practice, args.action.id);
        if (!validText(args.action.title)) throw Error("INVALID_TEXT");
        await validateRemarkIds(ctx, found.session, args.action.remarkIds);
        practice[index] = {
          ...practice[index],
          title: args.action.title,
          remarkIds: args.action.remarkIds,
          editedByCoach:
            practice[index].source === "ai_draft"
              ? true
              : practice[index].editedByCoach,
        };
        break;
      }
      case "addPractice": {
        const id = args.action.id;
        if (!validId(id) || practice.some((item) => item.id === id))
          throw Error("DUPLICATE_ID");
        if (!validText(args.action.title)) throw Error("INVALID_TEXT");
        await validateRemarkIds(ctx, found.session, args.action.remarkIds);
        practice.push({
          id,
          title: args.action.title,
          source: "coach",
          approved: true,
          remarkIds: args.action.remarkIds,
          editedByCoach: true,
        });
        break;
      }
      case "approveNote": {
        const item = noteAt(lesson, args.action.noteIndex);
        requireAi(item);
        if (item.approved) throw Error("INVALID_ACTION");
        notes[args.action.noteIndex] = { ...item, approved: true };
        break;
      }
      case "dismissNote": {
        const item = noteAt(lesson, args.action.noteIndex);
        if (item.source === "ai_draft") dismissedAiNote = true;
        notes.splice(args.action.noteIndex, 1);
        break;
      }
      case "editNote": {
        const item = noteAt(lesson, args.action.noteIndex);
        if (!validText(args.action.text)) throw Error("INVALID_TEXT");
        notes[args.action.noteIndex] = { ...item, text: args.action.text };
        break;
      }
      case "addNote":
        if (!validText(args.action.text)) throw Error("INVALID_TEXT");
        notes.push({ text: args.action.text, source: "coach", approved: true });
        break;
    }

    const next = nextRevision(lesson);
    await ctx.db.patch(lesson._id, {
      focusPoints,
      practice,
      notes,
      dismissedFocusIds: [...dismissedFocusIds],
      dismissedPracticeIds: [...dismissedPracticeIds],
      dismissedAiNote,
      revision: next,
    });
    return { revision: `lesson:${lesson._id}:${next}` };
  },
});
