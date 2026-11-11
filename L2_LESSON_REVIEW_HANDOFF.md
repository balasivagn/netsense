# L2 lesson review — T1.25 PARTIAL (backend contract)

Base: parent-reviewed `8f002d3939b567caa96d5a6a2cd7f35747ce2c8d` from
`origin/lane/l1-playback-review`. This lane implements the bounded Convex
contract only. It does not claim the Screen 21 route/components, snapshots,
sharing, student views, finalize/next-session focus, or browser acceptance.

## Public API

`lessons.get({sessionId})` is authenticated and owner scoped. It returns only
Screen 21-safe values:

```ts
{
  ownerUserId: string;
  revision: string; // opaque: return unchanged to the next update
  practiceEnabled: boolean;
  notes: Array<{text: string; source: "coach" | "ai_draft"; approved: boolean; why?: string}>;
  focusPoints: Array<{id: string; title: string; source: "coach" | "ai_draft"; approved: boolean; why?: string; remarkIds: string[]; editedByCoach: boolean}>;
  practice: Array<{id: string; title: string; source: "coach" | "ai_draft"; approved: boolean; why?: string; remarkIds: string[]; editedByCoach: boolean}>;
}
```

No pipeline config, model/provider, trace, tombstone, storage, or private job
fields are projected. When `FEATURE_PRACTICE_PLAN` is off (default is on), the
same query returns `practiceEnabled: false` and `practice: []`; stored practice
remains intact.

`lessons.update({sessionId, expectedRevision, action})` accepts exactly one
closed action. The UI must pass the last `revision` exactly and reload on
`LESSON_CONFLICT`.

```ts
type LessonAction =
  | {kind: "approveFocus" | "dismissFocus"; id: string}
  | {kind: "editFocus"; id: string; title: string; remarkIds: string[]}
  | {kind: "addFocus"; id: string; title: string; remarkIds: string[]}
  | {kind: "approvePractice" | "dismissPractice"; id: string}
  | {kind: "editPractice"; id: string; title: string; remarkIds: string[]}
  | {kind: "addPractice"; id: string; title: string; remarkIds: string[]}
  | {kind: "approveNote" | "dismissNote"; noteIndex: number}
  | {kind: "editNote"; noteIndex: number; text: string}
  | {kind: "addNote"; text: string};
```

The result is `{revision: string}`. There is no whole-array write or bulk
approval endpoint. `noteIndex` must be the exact current index and is protected
by the full revision. All title/text values are bounded, non-empty strings;
new item ids are bounded unique tokens; every `remarkIds` entry is unique and
must name an owned remark for the session. Mutations reject foreign/missing rows,
stale selectors, malformed values, and queued/running latest jobs.

Per-item semantics:

- AI entries are `source: "ai_draft"`, initially unapproved. Approve and edit
  preserve both that source and `why`; focus/practice edits set
  `editedByCoach: true`.
- Coach additions are `source: "coach"` and immediately approved. Focus/practice
  additions have `editedByCoach: true`; coach notes are free text and solid.
- At most two approved focus points are enforced inside the mutation, including
  simultaneous approvals/additions. Drafts may exceed two.
- Dismissing an AI focus/practice id or AI note removes it from the projection
  and records a private tombstone. This preserves the coach’s choice through a
  `persistPlan` retry while allowing new, unrelated draft ids through.

## Persistence and playback integration

The `lessons` table now has optional `revision`, `dismissedFocusIds`,
`dismissedPracticeIds`, and `dismissedAiNote` fields. They are backward
compatible with existing rows; plan stage output and shared note/focus shapes
remain frozen. `pipeline.persistPlan` filters incoming drafts through these
tombstones, preserves existing coach/approved/edited focus/practice and notes,
and does not advance the UI revision itself. `playback.get` defensively filters
tombstoned AI suggestions as well, preserving all existing track/revision
behavior.

## UI integration requirements

Load `lessons.get` for the owned session and send one `LessonAction` per user
gesture. Keep the returned revision with the rendered list; on conflict, reload
before retrying. Render item source/status/why from the projection rather than
deriving them locally. Do not show practice when `practiceEnabled` is false and
do not erase its local view state as a server mutation. Do not expose or attempt
to reconstruct dismissal tombstones. Screen 21 must still supply its own
component/browser tests and route wiring.

## Validation boundary

Focused Convex tests cover authenticated ownership/unauthed denial, one-item
approval isolation, AI source/why retention after edits, immutable original
transcript text, stale/duplicate/malformed/busy rejection without writes,
parallel third-focus approval races, practice-flag hide/reject-with-retention,
and persisted-plan retry prevention for dismissed AI note/focus/practice while
retaining coach data and allowing a new unrelated draft.

Browser, live Clerk/Convex, R2, device behavior, and vendor behavior remain
**UNTESTED**. There is no `pnpm e2e` suite yet. No runtime fixture or placeholder
data is introduced; all new test setup remains under `convex/tests` using the
existing synthetic fixture path.
