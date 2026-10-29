import { ConvexError, v, type Infer, type Validator } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { live } from "./worker";
import { canonicalOutput } from "./lib/lifecycle";
import * as structural from "./persistenceValidators";
import * as contracts from "../packages/contracts/gen/persistenceValidation";
import { canonical } from "../packages/contracts/validateSchema";
import { sliceCoachSpan } from "../packages/contracts/utf16";
import type { Provenance } from "../packages/contracts/gen/Provenance";

function requireValid(value: unknown): asserts value {
  if (!value) throw Error("CONTRACT_INVALID");
}
function verbatim(a: string, b: string) {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b);
  if (a !== b || x.length !== y.length || x.some((byte, i) => byte !== y[i]))
    throw new ConvexError("VERBATIM_MISMATCH");
}
function unique(values: string[]) {
  requireValid(
    values.every((x) => /^[A-Za-z0-9_.@-]{1,128}$/.test(x)) &&
      new Set(values).size === values.length,
  );
}
function range(start: number, end: number, duration: number) {
  requireValid(start >= 0 && start < end && end <= duration);
}
function box(b: { x1: number; y1: number; x2: number; y2: number }) {
  requireValid(b.x1 >= 0 && b.y1 >= 0 && b.x2 > b.x1 && b.y2 > b.y1);
}
const protectedMark = (a: Doc<"annotations">) =>
  a.placedBy !== "ai" ||
  a.status === "approved" ||
  a.status === "deleted" ||
  a.approvedAt !== undefined ||
  !a.aiPlacement ||
  canonical({
    markType: a.markType,
    anchor: a.anchor,
    ...(a.arrowFrom ? { arrowFrom: a.arrowFrom } : {}),
    startMs: a.startMs,
    endMs: a.endMs,
    ...(a.labelSpan ? { labelSpan: a.labelSpan } : {}),
    labelText: a.labelText,
    ...(a.neutralLabel ? { neutralLabel: a.neutralLabel } : {}),
  }) !== canonical(a.aiPlacement);
async function ownedRemarks(ctx: MutationCtx, session: Doc<"sessions">) {
  const rows = await ctx.db
    .query("remarks")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
    .collect();
  requireValid(rows.every((r) => r.coachId === session.coachId));
  return rows;
}
async function annotations(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  remarkId: string,
) {
  return (
    await ctx.db
      .query("annotations")
      .withIndex("by_sessionId_status", (q) => q.eq("sessionId", session._id))
      .collect()
  ).filter((a) => a.remarkId === remarkId && a.coachId === session.coachId);
}
async function configFor(ctx: MutationCtx, job: Doc<"jobs">) {
  const config = await ctx.db
    .query("pipeline_config")
    .withIndex("by_version", (q) => q.eq("version", job.configVersion))
    .unique();
  requireValid(config);
  return config;
}
type Scope = {
  job: Doc<"jobs">;
  session: Doc<"sessions">;
  run: Doc<"stageRuns">;
  config: Doc<"pipeline_config">;
  remark: Doc<"remarks"> | undefined;
  remarks: Doc<"remarks">[];
};
async function scope(
  ctx: MutationCtx,
  token: string,
  stageRunId: Doc<"stageRuns">["_id"],
  stage: Doc<"stageRuns">["stage"],
): Promise<Scope> {
  const { job, session } = await live(ctx, token);
  const run = await ctx.db.get(stageRunId),
    config = await configFor(ctx, job);
  requireValid(
    run &&
      run.jobId === job._id &&
      run.sessionId === session._id &&
      run.coachId === job.coachId &&
      run.stage === stage,
  );
  const spec = config.stages.find((s) => s.stage === stage);
  requireValid(
    spec?.enabled &&
      spec.workerId === run.workerId &&
      spec.provider === run.provider &&
      spec.workerType === run.workerType &&
      (spec.model ?? undefined) === run.modelVersion &&
      (run.candidate === undefined || spec.candidates.includes(run.candidate)),
  );
  const remarks = await ownedRemarks(ctx, session),
    remark = remarks.find((r) => r.remarkId === run.remarkId);
  requireValid(run.remarkId === undefined || remark);
  requireValid(
    !["moment", "track", "place", "check"].includes(stage) || remark,
  );
  requireValid(
    !["transcode", "transcribe", "plan", "render"].includes(stage) ||
      run.remarkId === undefined,
  );
  requireValid(
    !remark ||
      (remark.aboutSubject !== "no" &&
        remark.aboutSubject !== "general" &&
        remark.mode !== "note_only"),
  );
  requireValid(
    job.kind !== "remark_retrack" ||
      job.remarkId === run.remarkId ||
      stage === "render",
  );
  requireValid(job.kind !== "stage_retry" || job.stage === stage);
  return { job, session, run, config, remarks, remark };
}
async function receipt(
  ctx: MutationCtx,
  s: Scope,
  value: unknown,
): Promise<boolean> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (s.run.persistedOutputHash !== undefined) {
    requireValid(
      s.run.persistedOutputHash === hash &&
        ["running", "done"].includes(s.run.status),
    );
    return true;
  }
  requireValid(s.run.status === "running");
  const runs = await ctx.db
    .query("stageRuns")
    .withIndex("by_jobId_stage", (q) =>
      q.eq("jobId", s.job._id).eq("stage", s.run.stage),
    )
    .collect();
  requireValid(
    !runs.some(
      (r) =>
        r.remarkId === s.run.remarkId && r._creationTime > s.run._creationTime,
    ),
  );
  // Receipt and projections commit together; any later rejection rolls back both.
  await ctx.db.patch(s.run._id, { persistedOutputHash: hash });
  return false;
}
function endpoint<V extends Validator<unknown, "required", string>>(
  stage: Doc<"stageRuns">["stage"],
  output: V,
  validate: (value: unknown) => void,
  apply: (ctx: MutationCtx, s: Scope, value: Infer<V>) => Promise<void>,
) {
  return internalMutation({
    args: { token: v.string(), stageRunId: v.id("stageRuns"), output },
    handler: async (ctx, args) => {
      validate(args.output);
      const s = await scope(ctx, args.token, args.stageRunId, stage);
      if (!(await receipt(ctx, s, { output: args.output })))
        await apply(ctx, s, args.output);
      return { ok: true as const };
    },
  });
}
function key(value: string, s: Scope) {
  requireValid(canonicalOutput(value, s.session._id));
}
function duration(s: Scope) {
  requireValid(s.session.durationMs && s.session.durationMs > 0);
  return s.session.durationMs;
}
function remarkMatch(s: Scope, id: string) {
  requireValid(s.remark && s.remark.remarkId === id);
  return s.remark;
}
async function unedited(ctx: MutationCtx, s: Scope) {
  requireValid(
    s.remark &&
      !(await annotations(ctx, s.session, s.remark.remarkId)).some(
        protectedMark,
      ),
  );
}

export const persistTranscode = endpoint(
  "transcode",
  structural.TranscodeOutput,
  contracts.validateTranscodeOutput,
  async (ctx, s, o) => {
    [
      o.proxyKey,
      o.audioM4aKey,
      o.keyframeIndexKey,
      ...o.audioWavKeys.map((x) => x.key),
    ].forEach((k) => key(k, s));
    requireValid(
      o.sha256Verified &&
        [o.durationMs, o.width, o.height, o.fps, o.frameCount].every(
          (x) => Number.isFinite(x) && x > 0,
        ) &&
        o.audioWavKeys.length > 0,
    );
    let end = 0;
    for (const chunk of o.audioWavKeys) {
      range(chunk.offsetMs, chunk.offsetMs + chunk.durationMs, o.durationMs);
      requireValid(chunk.offsetMs >= end);
      end = chunk.offsetMs + chunk.durationMs;
    }
    // Existing measured duration is immutable across pipeline attempts.
    requireValid(
      s.session.durationMs === undefined ||
        s.session.durationMs === o.durationMs,
    );
    await ctx.db.patch(s.session._id, { durationMs: o.durationMs });
  },
);
export const persistTurns = endpoint(
  "transcribe",
  structural.TranscribeOutput,
  contracts.validateTranscribeOutput,
  async (ctx, s, o) => {
    requireValid(o.audioDurationMs > 0 && o.audioDurationMs <= duration(s));
    unique(o.turns.map((t) => t.turnId));
    let start = -1;
    for (const turn of o.turns) {
      range(turn.startMs, turn.endMs, o.audioDurationMs);
      requireValid(
        turn.startMs >= start &&
          turn.text.length > 0 &&
          turn.speaker.length > 0,
      );
      start = turn.startMs;
      const old = await ctx.db
        .query("transcriptTurns")
        .withIndex("by_sessionId_turnId", (q) =>
          q.eq("sessionId", s.session._id).eq("turnId", turn.turnId),
        )
        .unique();
      if (old) {
        requireValid(
          old.coachId === s.job.coachId &&
            old.startMs === turn.startMs &&
            old.endMs === turn.endMs &&
            old.speaker === turn.speaker,
        );
        verbatim(old.text, turn.text);
      } else
        await ctx.db.insert("transcriptTurns", {
          ...turn,
          sessionId: s.session._id,
          coachId: s.job.coachId,
        });
    }
  },
);
export const persistPlan = endpoint(
  "plan",
  structural.PlanOutput,
  contracts.validatePlanOutput,
  async (ctx, s, o) => {
    unique(o.remarks.map((r) => r.remarkId));
    unique(o.fanOut.map((r) => r.remarkId));
    unique(o.remarks.flatMap((r) => r.turnIds));
    const turns = await ctx.db
      .query("transcriptTurns")
      .withIndex("by_sessionId_turnId", (q) => q.eq("sessionId", s.session._id))
      .collect();
    for (const r of o.remarks) {
      const refs = r.turnIds.map((id) =>
        turns.find((t) => t.turnId === id && t.coachId === s.job.coachId),
      );
      requireValid(refs.every((t) => t));
      const ordered = refs as Doc<"transcriptTurns">[];
      requireValid(
        ordered.every((t, i) => !i || t.startMs >= ordered[i - 1].startMs),
      );
      verbatim(ordered.map((t) => t.text).join(" "), r.coachWords);
      requireValid(r.atMs === ordered[0].startMs);
      const noteOnly = r.aboutSubject === "no" || r.aboutSubject === "general";
      const fan = o.fanOut.find((f) => f.remarkId === r.remarkId);
      requireValid(
        noteOnly
          ? !fan
          : fan &&
              canonical(fan.stages) ===
                canonical(["moment", "subject", "track", "place", "check"]),
      );
      const data = {
        sessionId: s.session._id,
        coachId: s.job.coachId,
        remarkId: r.remarkId,
        turnIds: r.turnIds,
        source: "voice" as const,
        aboutSubject: r.aboutSubject,
        kind: r.kind,
        atMs: r.atMs,
        mode: noteOnly
          ? ("note_only" as const)
          : s.session.renderMode === "stills"
            ? ("still_frame" as const)
            : ("tracked" as const),
        status: "pending" as const,
        includeInShare: noteOnly
          ? s.config.params.otherPersonRemarksInShare
          : true,
      };
      const old = s.remarks.find((x) => x.remarkId === r.remarkId);
      // No worker may reassign existing turns or overwrite coach decisions.
      requireValid(
        !s.remarks.some(
          (x) =>
            x.remarkId !== r.remarkId &&
            x.turnIds.some((id) => r.turnIds.includes(id)),
        ),
      );
      if (old)
        requireValid(
          old.source === "voice" &&
            canonical(old.turnIds) === canonical(r.turnIds) &&
            old.atMs === r.atMs &&
            old.aboutSubject === r.aboutSubject &&
            old.kind === r.kind,
        );
      else await ctx.db.insert("remarks", data);
    }
    requireValid(
      o.fanOut.every((f) => o.remarks.some((r) => r.remarkId === f.remarkId)),
    );
    for (const list of [o.drafts.focus, o.drafts.practice]) {
      unique(list.map((d) => d.id));
      for (const d of list) {
        unique(d.remarkIds);
        requireValid(
          d.remarkIds.every((id) => o.remarks.some((r) => r.remarkId === id)),
        );
      }
    }
    const old = await ctx.db
      .query("lessons")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", s.session._id))
      .unique();
    const note = o.drafts.note;
    const data = {
      sessionId: s.session._id,
      coachId: s.job.coachId,
      focusPoints: o.drafts.focus,
      practice: o.drafts.practice,
      notes: note ? [note] : [],
    };
    if (!old) await ctx.db.insert("lessons", data);
    else {
      requireValid(old.coachId === s.job.coachId);
      const keepFocus = old.focusPoints.filter(
          (d) => d.source === "coach" || d.approved || d.editedByCoach,
        ),
        keepPractice = old.practice.filter(
          (d) => d.source === "coach" || d.approved || d.editedByCoach,
        );
      await ctx.db.patch(old._id, {
        focusPoints: [
          ...keepFocus,
          ...o.drafts.focus.filter(
            (d) => !keepFocus.some((x) => x.id === d.id),
          ),
        ],
        practice: [
          ...keepPractice,
          ...o.drafts.practice.filter(
            (d) => !keepPractice.some((x) => x.id === d.id),
          ),
        ],
        notes: old.notes.length ? old.notes : data.notes,
      });
    }
  },
);
export const persistMoment = endpoint(
  "moment",
  structural.MomentOutput,
  contracts.validateMomentOutput,
  async (ctx, s, o) => {
    const r = remarkMatch(s, o.remarkId);
    await unedited(ctx, s);
    range(o.startMs, o.endMs, duration(s));
    requireValid(
      o.endMs - o.startMs <= s.config.params.maxMomentMs &&
        o.keyframeMs >= o.startMs &&
        o.keyframeMs < o.endMs,
    );
    for (const c of o.candidates) {
      range(c.startMs, c.endMs, duration(s));
      requireValid(c.endMs - c.startMs <= s.config.params.maxMomentMs);
    }
    await ctx.db.patch(r._id, {
      momentStartMs: o.startMs,
      momentEndMs: o.endMs,
      keyframeMs: o.keyframeMs,
      momentWhy: o.why,
    });
  },
);
export const persistTarget = internalMutation({
  args: {
    token: v.string(),
    stageRunId: v.id("stageRuns"),
    output: v.union(structural.SubjectAnchorOutput, structural.SubjectOutput),
  },
  handler: async (ctx, args) => {
    const s = await scope(ctx, args.token, args.stageRunId, "subject");
    const o = args.output;
    if (s.run.remarkId === undefined) contracts.validateSubjectAnchorOutput(o);
    else contracts.validateSubjectOutput(o);
    if (await receipt(ctx, s, { output: o })) return { ok: true };
    requireValid(
      s.session.subject && s.session.subject.role === s.session.subjectRole,
    );
    if ("anchorBox" in o) {
      requireValid(
        o.anchorFrameMs === s.session.subject.frameMs &&
          o.anchorFrameMs < duration(s),
      );
      box(o.anchorBox);
      key(o.referenceCropKey, s);
      await ctx.db.patch(s.session._id, {
        subjectAnchor: {
          box: o.anchorBox,
          frameMs: o.anchorFrameMs,
          referenceCropKey: o.referenceCropKey,
        },
        subjectStatus: "anchored",
      });
    } else {
      const r = remarkMatch(s, o.remarkId);
      requireValid(
        s.session.subjectAnchor &&
          o.target.role === s.session.subjectRole &&
          o.target.frameMs === r.keyframeMs &&
          r.momentStartMs !== undefined &&
          r.momentEndMs !== undefined &&
          o.target.frameMs >= r.momentStartMs &&
          o.target.frameMs < r.momentEndMs,
      );
      box(o.target.promptBox);
      requireValid(o.candidatesCount <= s.config.params.maxSubjectCandidates);
      if (o.method === "anchor_reuse")
        requireValid(
          Math.abs(o.target.frameMs - s.session.subjectAnchor.frameMs) <=
            s.config.params.anchorReuseMs &&
            canonical(o.target.promptBox) ===
              canonical(s.session.subjectAnchor.box),
        );
      // Full target is the runner's artifact, never a fabricated targets table.
    }
    return { ok: true };
  },
});
export const persistTrack = internalMutation({
  args: {
    token: v.string(),
    stageRunId: v.id("stageRuns"),
    output: structural.TrackOutput,
    cacheKey: v.string(),
  },
  handler: async (ctx, args) => {
    contracts.validateTrackOutput(args.output);
    const s = await scope(ctx, args.token, args.stageRunId, "track"),
      o = args.output;
    requireValid(/^[a-f0-9]{64}$/.test(args.cacheKey));
    if (await receipt(ctx, s, { output: o, cacheKey: args.cacheKey }))
      return { ok: true };
    remarkMatch(s, o.remarkId);
    await unedited(ctx, s);
    requireValid(
      o.role === s.session.subjectRole &&
        o.mode === (s.session.renderMode === "stills" ? "still" : "video") &&
        o.trackId.length > 0 &&
        (!o.cacheHit || o.framesBilled === 0),
    );
    key(o.fileRef, s);
    if (o.maskRef !== null) key(o.maskRef, s);
    const sameId = await ctx.db
      .query("tracks")
      .withIndex("by_trackId", (q) => q.eq("trackId", o.trackId))
      .collect();
    requireValid(
      !sameId.some(
        (t) =>
          t.trackId === o.trackId &&
          (t.sessionId !== s.session._id || t.remarkId !== o.remarkId),
      ),
    );
    const sessionTracks = await ctx.db
      .query("tracks")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", s.session._id))
      .collect();
    const matches = sessionTracks.filter((t) => t.remarkId === o.remarkId);
    requireValid(matches.length <= 1);
    const old = matches[0];
    requireValid(!old || old.coachId === s.job.coachId);
    const data = {
      sessionId: s.session._id,
      coachId: s.job.coachId,
      remarkId: o.remarkId,
      trackId: o.trackId,
      role: o.role,
      mode: o.mode,
      fileRef: o.fileRef,
      ...(o.maskRef !== null ? { maskRef: o.maskRef } : {}),
      coverage: o.coverage,
      cacheKey: args.cacheKey,
    };
    if (old) {
      await ctx.db.patch(old._id, { ...data, maskRef: o.maskRef ?? undefined });
    } else await ctx.db.insert("tracks", data);
    // TrackFile.subjectOnly/swaps/frames are validated by the runner, not read here.
    await ctx.db.patch(s.run._id, {
      persistedTrackBinding: { trackId: o.trackId, fileRef: o.fileRef },
    });
    return { ok: true };
  },
});
async function verifiedProvenance(ctx: MutationCtx, s: Scope, p: Provenance) {
  requireValid(
    p.configVersion === s.job.configVersion &&
      p.placedBy === "ai" &&
      p.candidate === (s.run.candidate ?? null),
  );
  const stages = ["moment", "subject", "track", "place"] as const;
  requireValid(
    Object.keys(p.stageRunIds).length === 4 &&
      Object.keys(p.workers).length === 4,
  );
  const models: Record<string, string> = {};
  for (const stage of stages) {
    const id = ctx.db.normalizeId("stageRuns", p.stageRunIds[stage] ?? "");
    const r = id ? await ctx.db.get(id) : null;
    requireValid(
      r &&
        r.coachId === s.job.coachId &&
        r.sessionId === s.session._id &&
        r.stage === stage &&
        r.remarkId === s.run.remarkId &&
        r.persistedOutputHash &&
        p.workers[stage] === r.workerId,
    );
    const spec = s.config.stages.find((x) => x.stage === stage);
    requireValid(
      spec &&
        r.workerId === spec.workerId &&
        r.provider === spec.provider &&
        r.workerType === spec.workerType &&
        r.modelVersion === (spec.model ?? undefined),
    );
    if (r.jobId !== s.job._id) {
      const prior = await ctx.db.get(r.jobId);
      requireValid(
        stage === "moment" &&
          s.job.kind === "subject_retrack" &&
          prior &&
          prior.sessionId === s.session._id &&
          prior.coachId === s.job.coachId &&
          prior.configVersion === s.job.configVersion &&
          prior._creationTime < s.job._creationTime,
      );
    }
    requireValid(
      stage === "place"
        ? r._id === s.run._id && r.status === "running"
        : r.status === "done" &&
            r.outputRef !== undefined &&
            canonicalOutput(r.outputRef, s.session._id),
    );
    if (r.modelVersion) models[stage] = r.modelVersion;
  }
  requireValid(canonical(models) === canonical(p.modelVersions));
}
async function markIds(ctx: MutationCtx, s: Scope) {
  return (await annotations(ctx, s.session, s.run.remarkId!))
    .filter((a) => a.provenance.stageRunIds.place === s.run._id)
    .map((a) => ({ markId: a.markId, annotationId: a._id }))
    .sort((a, b) => (a.markId < b.markId ? -1 : a.markId > b.markId ? 1 : 0));
}
export const persistMarks = internalMutation({
  args: {
    token: v.string(),
    stageRunId: v.id("stageRuns"),
    output: structural.PlaceOutput,
    provenance: structural.Provenance,
  },
  handler: async (ctx, args) => {
    contracts.validatePlaceOutput(args.output);
    contracts.validateProvenance(args.provenance);
    const s = await scope(ctx, args.token, args.stageRunId, "place"),
      o = args.output;
    if (await receipt(ctx, s, { output: o, provenance: args.provenance }))
      return { ok: true, annotationIds: s.run.persistedAnnotationIds ?? [] };
    const r = remarkMatch(s, o.remarkId);
    await verifiedProvenance(ctx, s, args.provenance);
    unique(o.marks.map((m) => m.markId));
    requireValid(
      o.marks.length <= Math.min(3, s.config.params.maxMarksPerRemark),
    );
    const tracks = await ctx.db
      .query("tracks")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", s.session._id))
      .collect();
    const track = tracks.find((t) => t.remarkId === r.remarkId);
    requireValid(
      track &&
        track.coachId === s.job.coachId &&
        track.role === s.session.subjectRole,
    );
    key(track.fileRef, s);
    const trackRunId = ctx.db.normalizeId(
      "stageRuns",
      args.provenance.stageRunIds.track,
    );
    const trackRun = trackRunId ? await ctx.db.get(trackRunId) : null;
    requireValid(
      trackRun?.persistedTrackBinding?.trackId === track.trackId &&
        trackRun.persistedTrackBinding.fileRef === track.fileRef,
    );
    const old = await annotations(ctx, s.session, r.remarkId);
    const ordinal =
      [...s.remarks]
        .sort(
          (a, b) =>
            a.atMs - b.atMs ||
            (a.remarkId < b.remarkId ? -1 : a.remarkId > b.remarkId ? 1 : 0),
        )
        .findIndex((x) => x._id === r._id) + 1;
    for (const m of o.marks) {
      requireValid(
        s.config.params.allowedMarkTypes.includes(m.markType) &&
          m.labelText.length <= Math.min(60, s.config.params.labelMaxChars),
      );
      requireValid(
        r.momentStartMs !== undefined && r.momentEndMs !== undefined,
      );
      range(m.startMs, m.endMs, r.momentEndMs);
      requireValid(m.startMs >= r.momentStartMs);
      if (m.labelSpan) {
        requireValid(
          m.neutralLabel === null &&
            r.turnIds.includes(m.labelSpan.turnId) &&
            m.labelSpan.end - m.labelSpan.start <= 60,
        );
        const turn = await ctx.db
          .query("transcriptTurns")
          .withIndex("by_sessionId_turnId", (q) =>
            q.eq("sessionId", s.session._id).eq("turnId", m.labelSpan!.turnId),
          )
          .unique();
        requireValid(turn && turn.coachId === s.job.coachId);
        let copied: string;
        try {
          copied = sliceCoachSpan(
            turn.text,
            m.labelSpan.start,
            m.labelSpan.end,
          );
        } catch {
          throw new ConvexError("VERBATIM_MISMATCH");
        }
        // A boundary cannot bisect a word (Unicode letters/numbers/marks).
        const word = (x: string) => /[\p{L}\p{N}\p{M}_]/u.test(x);
        requireValid(
          !(
            word([...turn.text.slice(0, m.labelSpan.start)].at(-1) ?? "") &&
            word([...copied][0] ?? "")
          ) &&
            !(
              word([...copied].at(-1) ?? "") &&
              word([...turn.text.slice(m.labelSpan.end)][0] ?? "")
            ),
        );
        verbatim(copied, m.labelText);
      } else {
        const label =
          s.session.subjectRole === "batter"
            ? "Batter"
            : s.session.subjectRole === "bowler"
              ? "Bowler"
              : "Player";
        requireValid(m.neutralLabel === label || m.neutralLabel === "Remark");
        verbatim(
          m.labelText,
          m.neutralLabel === "Remark" ? `Remark ${ordinal}` : label,
        );
      }
      const placement = {
        markType: m.markType,
        anchor: m.anchor,
        ...(m.arrowFrom !== null ? { arrowFrom: m.arrowFrom } : {}),
        startMs: m.startMs,
        endMs: m.endMs,
        ...(m.labelSpan !== null ? { labelSpan: m.labelSpan } : {}),
        labelText: m.labelText,
        ...(m.neutralLabel !== null ? { neutralLabel: m.neutralLabel } : {}),
      };
      const existing = old.find((a) => a.markId === m.markId);
      requireValid(!existing || !protectedMark(existing));
      const data = {
        ...placement,
        sessionId: s.session._id,
        coachId: s.job.coachId,
        remarkId: r.remarkId,
        markId: m.markId,
        role: s.session.subjectRole,
        trackId: track.trackId,
        why: o.why,
        status: "needs_you" as const,
        placedBy: "ai" as const,
        aiPlacement: placement,
        provenance: args.provenance as Doc<"annotations">["provenance"],
        updatedAt: Date.now(),
      };
      if (existing)
        await ctx.db.patch(existing._id, {
          ...data,
          why: existing.why,
          arrowFrom: m.arrowFrom ?? undefined,
          labelSpan: m.labelSpan ?? undefined,
          neutralLabel: m.neutralLabel ?? undefined,
          checkVerdict: undefined,
        });
      else await ctx.db.insert("annotations", data);
    }
    for (const a of old)
      if (!o.marks.some((m) => m.markId === a.markId) && !protectedMark(a))
        await ctx.db.delete(a._id);
    const annotationIds = await markIds(ctx, s);
    await ctx.db.patch(s.run._id, { persistedAnnotationIds: annotationIds });
    return { ok: true, annotationIds };
  },
});
export const persistVerdicts = endpoint(
  "check",
  structural.CheckOutput,
  contracts.validateCheckOutput,
  async (ctx, s, o) => {
    const r = remarkMatch(s, o.remarkId);
    unique(o.verdicts.map((v) => v.markId));
    const marks = (await annotations(ctx, s.session, r.remarkId)).filter(
      (a) => a.placedBy === "ai" && a.status !== "deleted",
    );
    requireValid(
      marks.length > 0 &&
        o.verdicts.length === marks.length &&
        marks.every((a) => o.verdicts.some((v) => v.markId === a.markId)),
    );
    requireValid(o.verdicts.every((v) => v.pass === (v.reason === "ok")));
    const missing = o.verdicts.every((v) =>
      ["no_player", "subject_swap", "low_coverage"].includes(v.reason),
    );
    requireValid(o.remarkStatus === (missing ? "player_missing" : "ok"));
    for (const a of marks) {
      const placeId = ctx.db.normalizeId(
        "stageRuns",
        a.provenance.stageRunIds.place ?? "",
      );
      const place = placeId ? await ctx.db.get(placeId) : null;
      requireValid(
        place &&
          place.jobId === s.job._id &&
          place.sessionId === s.session._id &&
          place.coachId === s.job.coachId &&
          place.stage === "place" &&
          place.remarkId === r.remarkId &&
          place.status === "done" &&
          place.persistedOutputHash,
      );
      const verdict = o.verdicts.find((v) => v.markId === a.markId)!;
      if (protectedMark(a)) continue;
      const { markId, ...checkVerdict } = verdict;
      void markId;
      await ctx.db.patch(a._id, {
        checkVerdict,
        status: ["no_player", "subject_swap", "low_coverage"].includes(
          verdict.reason,
        )
          ? "player_missing"
          : "needs_you",
        provenance: {
          ...a.provenance,
          stageRunIds: { ...a.provenance.stageRunIds, check: s.run._id },
          workers: { ...a.provenance.workers, check: s.run.workerId },
          modelVersions: {
            ...a.provenance.modelVersions,
            ...(s.run.modelVersion ? { check: s.run.modelVersion } : {}),
          },
        },
        updatedAt: Date.now(),
      });
    }
    if (!marks.some(protectedMark))
      await ctx.db.patch(r._id, { status: o.remarkStatus });
  },
);
export const persistRender = endpoint(
  "render",
  structural.RenderOutput,
  contracts.validateRenderOutput,
  async (ctx, s, o) => {
    // Finalize needs a frozen snapshot/input binding; output alone cannot prove that
    // a video excludes unapproved items. Fail closed until that integration lands.
    requireValid(
      o.kind === "preview" &&
        s.job.kind !== "finalize" &&
        o.mode === s.session.renderMode &&
        o.durationMs === duration(s),
    );
    requireValid(
      o.mode === "video"
        ? o.fileRef !== null
        : o.fileRef === null && o.stillRefs.length > 0,
    );
    if (o.fileRef !== null) key(o.fileRef, s);
    unique(o.stillRefs.map((x) => x.annotationId));
    unique(o.segmentRefs.map((x) => x.segmentId));
    for (const ref of o.stillRefs) {
      key(ref.key, s);
      const id = ctx.db.normalizeId("annotations", ref.annotationId),
        a = id ? await ctx.db.get(id) : null;
      requireValid(
        a &&
          a.sessionId === s.session._id &&
          a.coachId === s.job.coachId &&
          a.status !== "deleted",
      );
    }
    for (const ref of o.segmentRefs) key(ref.key, s);
    const old = (
      await ctx.db
        .query("renders")
        .withIndex("by_sessionId_kind", (q) =>
          q.eq("sessionId", s.session._id).eq("kind", o.kind),
        )
        .collect()
    ).find((r) => r.jobId === s.job._id);
    const data = {
      sessionId: s.session._id,
      coachId: s.job.coachId,
      jobId: s.job._id,
      kind: o.kind,
      mode: o.mode,
      ...(o.fileRef !== null ? { fileRef: o.fileRef } : {}),
      stillRefs: o.stillRefs,
      segmentRefs: o.segmentRefs,
      status: "ready" as const,
    };
    if (old) {
      requireValid(old.coachId === s.job.coachId);
      const { _id, _creationTime, createdAt, ...prior } = old;
      void _id;
      void _creationTime;
      void createdAt;
      requireValid(canonical(prior) === canonical(data));
    } else await ctx.db.insert("renders", { ...data, createdAt: Date.now() });
  },
);
