// Generated from JSON Schemas. Do not edit.
import { validateSchema } from "../validateSchema";
import type { TranscodeOutput } from "./TranscodeOutput";
import type { TranscribeOutput } from "./TranscribeOutput";
import type { PlanOutput } from "./PlanOutput";
import type { MomentOutput } from "./MomentOutput";
import type { SubjectAnchorOutput } from "./SubjectAnchorOutput";
import type { SubjectOutput } from "./SubjectOutput";
import type { TrackOutput } from "./TrackOutput";
import type { PlaceOutput } from "./PlaceOutput";
import type { CheckOutput } from "./CheckOutput";
import type { RenderOutput } from "./RenderOutput";
import type { Provenance } from "./Provenance";
const schemas = {
  TranscodeOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "TranscodeOutput",
    type: "object",
    properties: {
      proxyKey: { type: "string" },
      audioWavKeys: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            offsetMs: { type: "integer", minimum: 0 },
            durationMs: { type: "integer", minimum: 0 },
          },
          required: ["key", "offsetMs", "durationMs"],
          additionalProperties: false,
        },
      },
      audioM4aKey: { type: "string" },
      durationMs: { type: "integer", minimum: 0 },
      width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 },
      fps: { type: "number", exclusiveMinimum: 0 },
      frameCount: { type: "integer", minimum: 0 },
      keyframeIndexKey: { type: "string" },
      sha256Verified: { const: true, type: "boolean" },
    },
    required: [
      "proxyKey",
      "audioWavKeys",
      "audioM4aKey",
      "durationMs",
      "width",
      "height",
      "fps",
      "frameCount",
      "keyframeIndexKey",
      "sha256Verified",
    ],
    additionalProperties: false,
  },
  TranscribeOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "TranscribeOutput",
    type: "object",
    properties: {
      turns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            turnId: { type: "string" },
            startMs: { type: "integer", minimum: 0 },
            endMs: { type: "integer", minimum: 0 },
            speaker: { type: "string" },
            text: { type: "string" },
          },
          required: ["turnId", "startMs", "endMs", "speaker", "text"],
          additionalProperties: false,
        },
      },
      audioDurationMs: { type: "integer", minimum: 0 },
      providerSessionIds: { type: "array", items: { type: "string" } },
    },
    required: ["turns", "audioDurationMs", "providerSessionIds"],
    additionalProperties: false,
  },
  PlanOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "PlanOutput",
    type: "object",
    properties: {
      remarks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            remarkId: { type: "string" },
            turnIds: { type: "array", items: { type: "string" }, minItems: 1 },
            aboutSubject: {
              type: "string",
              enum: ["yes", "no", "unclear", "general"],
            },
            kind: {
              type: "string",
              enum: ["feedback", "instruction", "praise", "other"],
            },
            aboutHint: { type: "string" },
            atMs: { type: "integer", minimum: 0 },
            coachWords: { type: "string" },
          },
          required: [
            "remarkId",
            "turnIds",
            "aboutSubject",
            "kind",
            "aboutHint",
            "atMs",
            "coachWords",
          ],
          additionalProperties: false,
        },
      },
      fanOut: {
        type: "array",
        items: {
          type: "object",
          properties: {
            remarkId: { type: "string" },
            stages: {
              type: "array",
              items: {
                type: "string",
                enum: ["moment", "subject", "track", "place", "check"],
              },
              uniqueItems: true,
            },
          },
          required: ["remarkId", "stages"],
          additionalProperties: false,
        },
      },
      drafts: {
        type: "object",
        properties: {
          focus: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                why: { type: "string" },
                remarkIds: { type: "array", items: { type: "string" } },
                source: { type: "string", enum: ["ai_draft"] },
                approved: { const: false, type: "boolean" },
                editedByCoach: { const: false, type: "boolean" },
              },
              required: [
                "id",
                "title",
                "why",
                "remarkIds",
                "source",
                "approved",
                "editedByCoach",
              ],
              additionalProperties: false,
            },
            maxItems: 2,
          },
          practice: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                why: { type: "string" },
                remarkIds: { type: "array", items: { type: "string" } },
                source: { type: "string", enum: ["ai_draft"] },
                approved: { const: false, type: "boolean" },
                editedByCoach: { const: false, type: "boolean" },
              },
              required: [
                "id",
                "title",
                "why",
                "remarkIds",
                "source",
                "approved",
                "editedByCoach",
              ],
              additionalProperties: false,
            },
          },
          note: {
            anyOf: [
              {
                type: "object",
                properties: {
                  text: { type: "string" },
                  why: { type: "string" },
                  source: { type: "string", enum: ["ai_draft"] },
                  approved: { type: "boolean", const: false },
                },
                required: ["text", "why", "source", "approved"],
                additionalProperties: false,
              },
              { type: "null" },
            ],
          },
        },
        required: ["focus", "practice", "note"],
        additionalProperties: false,
      },
    },
    required: ["remarks", "fanOut", "drafts"],
    additionalProperties: false,
  },
  MomentOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "MomentOutput",
    type: "object",
    properties: {
      remarkId: { type: "string" },
      startMs: { type: "integer", minimum: 0 },
      endMs: { type: "integer", minimum: 0 },
      keyframeMs: { type: "integer", minimum: 0 },
      keyframeIdx: { type: "integer", minimum: 0 },
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            startMs: { type: "integer", minimum: 0 },
            endMs: { type: "integer", minimum: 0 },
          },
          required: ["startMs", "endMs"],
          additionalProperties: false,
        },
        maxItems: 2,
      },
      why: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: [
      "remarkId",
      "startMs",
      "endMs",
      "keyframeMs",
      "keyframeIdx",
      "candidates",
      "why",
      "confidence",
    ],
    additionalProperties: false,
  },
  SubjectAnchorOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "SubjectAnchorOutput",
    type: "object",
    properties: {
      anchorBox: {
        type: "object",
        properties: {
          x1: { type: "number", minimum: 0 },
          y1: { type: "number", minimum: 0 },
          x2: { type: "number", minimum: 0 },
          y2: { type: "number", minimum: 0 },
        },
        required: ["x1", "y1", "x2", "y2"],
        additionalProperties: false,
      },
      anchorFrameMs: { type: "integer", minimum: 0 },
      referenceCropKey: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["anchorBox", "anchorFrameMs", "referenceCropKey", "confidence"],
    additionalProperties: false,
  },
  SubjectOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "SubjectOutput",
    type: "object",
    properties: {
      remarkId: { type: "string" },
      target: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["batter", "bowler", "other"] },
          promptBox: {
            type: "object",
            properties: {
              x1: { type: "number", minimum: 0 },
              y1: { type: "number", minimum: 0 },
              x2: { type: "number", minimum: 0 },
              y2: { type: "number", minimum: 0 },
            },
            required: ["x1", "y1", "x2", "y2"],
            additionalProperties: false,
          },
          promptPoint: {
            anyOf: [
              {
                type: "object",
                properties: {
                  x: { type: "number", minimum: 0, maximum: 1 },
                  y: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["x", "y"],
                additionalProperties: false,
              },
              { type: "null" },
            ],
          },
          frameMs: { type: "integer", minimum: 0 },
        },
        required: ["role", "promptBox", "promptPoint", "frameMs"],
        additionalProperties: false,
      },
      method: {
        type: "string",
        enum: ["anchor_reuse", "reid_model", "coach_tap"],
      },
      why: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      candidatesCount: { type: "integer", minimum: 0, maximum: 6 },
    },
    required: [
      "remarkId",
      "target",
      "method",
      "why",
      "confidence",
      "candidatesCount",
    ],
    additionalProperties: false,
  },
  TrackOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "TrackOutput",
    type: "object",
    properties: {
      remarkId: { type: "string" },
      trackId: { type: "string" },
      role: { type: "string", enum: ["batter", "bowler", "other"] },
      mode: { type: "string", enum: ["video", "still"] },
      fileRef: { type: "string" },
      maskRef: { anyOf: [{ type: "string" }, { type: "null" }] },
      coverage: { type: "number", minimum: 0, maximum: 1 },
      framesBilled: { type: "integer", minimum: 0 },
      cacheHit: { type: "boolean" },
      swapSuspected: { type: "boolean" },
      reassociations: { type: "integer", minimum: 0 },
    },
    required: [
      "remarkId",
      "trackId",
      "role",
      "mode",
      "fileRef",
      "maskRef",
      "coverage",
      "framesBilled",
      "cacheHit",
      "swapSuspected",
      "reassociations",
    ],
    additionalProperties: false,
  },
  PlaceOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "PlaceOutput",
    type: "object",
    properties: {
      remarkId: { type: "string" },
      marks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            markId: { type: "string" },
            markType: {
              type: "string",
              enum: ["circle", "arrow", "highlight", "label"],
            },
            anchor: {
              type: "string",
              enum: [
                "box_center",
                "box_top",
                "box_bottom",
                "box_left",
                "box_right",
              ],
            },
            arrowFrom: {
              anyOf: [
                { type: "string", enum: ["left", "right", "above", "below"] },
                { type: "null" },
              ],
            },
            startMs: { type: "integer", minimum: 0 },
            endMs: { type: "integer", minimum: 0 },
            labelSpan: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    turnId: { type: "string" },
                    start: { type: "integer", minimum: 0 },
                    end: { type: "integer", minimum: 1 },
                  },
                  required: ["turnId", "start", "end"],
                  additionalProperties: false,
                  description:
                    "UTF-16 code unit offsets into immutable transcriptTurns.text. Code checks boundaries, start < end, and verbatim copy; models return spans only.",
                },
                { type: "null" },
              ],
            },
            labelText: { type: "string", maxLength: 60 },
            neutralLabel: {
              anyOf: [
                {
                  type: "string",
                  enum: ["Batter", "Bowler", "Player", "Remark"],
                },
                { type: "null" },
              ],
            },
          },
          required: [
            "markId",
            "markType",
            "anchor",
            "arrowFrom",
            "startMs",
            "endMs",
            "labelSpan",
            "labelText",
            "neutralLabel",
          ],
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: 3,
      },
      why: { type: "string" },
    },
    required: ["remarkId", "marks", "why"],
    additionalProperties: false,
  },
  CheckOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "CheckOutput",
    type: "object",
    properties: {
      remarkId: { type: "string" },
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            markId: { type: "string" },
            pass: { type: "boolean" },
            reason: {
              type: "string",
              enum: [
                "ok",
                "no_player",
                "subject_swap",
                "low_coverage",
                "outside_moment",
                "label_mismatch",
                "label_too_long",
              ],
            },
          },
          required: ["markId", "pass", "reason"],
          additionalProperties: false,
        },
      },
      remarkStatus: { type: "string", enum: ["ok", "player_missing"] },
    },
    required: ["remarkId", "verdicts", "remarkStatus"],
    additionalProperties: false,
  },
  RenderOutput: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "RenderOutput",
    type: "object",
    properties: {
      kind: { type: "string", enum: ["preview", "final"] },
      mode: { type: "string", enum: ["video", "stills"] },
      fileRef: { anyOf: [{ type: "string" }, { type: "null" }] },
      stillRefs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            annotationId: { type: "string" },
            key: { type: "string" },
          },
          required: ["annotationId", "key"],
          additionalProperties: false,
        },
      },
      segmentRefs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            segmentId: { type: "string" },
            hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            key: { type: "string" },
          },
          required: ["segmentId", "hash", "key"],
          additionalProperties: false,
        },
      },
      durationMs: { type: "integer", minimum: 0 },
    },
    required: [
      "kind",
      "mode",
      "fileRef",
      "stillRefs",
      "segmentRefs",
      "durationMs",
    ],
    additionalProperties: false,
  },
  Provenance: {
    type: "object",
    properties: {
      configVersion: { type: "integer", minimum: 1 },
      stageRunIds: {
        type: "object",
        patternProperties: {
          "^(moment|subject|track|place|check)$": { type: "string" },
        },
        additionalProperties: false,
      },
      workers: {
        type: "object",
        patternProperties: {
          "^(moment|subject|track|place|check)$": { type: "string" },
        },
        additionalProperties: false,
      },
      modelVersions: {
        type: "object",
        patternProperties: { "^[A-Za-z0-9_.@-]+$": { type: "string" } },
        additionalProperties: false,
      },
      placedBy: { type: "string", enum: ["ai", "coach"] },
      candidate: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: [
      "configVersion",
      "stageRunIds",
      "workers",
      "modelVersions",
      "placedBy",
      "candidate",
    ],
    additionalProperties: false,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Provenance",
  },
};
export function validateTranscodeOutput(
  value: unknown,
): asserts value is TranscodeOutput {
  if (!validateSchema(schemas.TranscodeOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validateTranscribeOutput(
  value: unknown,
): asserts value is TranscribeOutput {
  if (!validateSchema(schemas.TranscribeOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validatePlanOutput(
  value: unknown,
): asserts value is PlanOutput {
  if (!validateSchema(schemas.PlanOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validateMomentOutput(
  value: unknown,
): asserts value is MomentOutput {
  if (!validateSchema(schemas.MomentOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validateSubjectAnchorOutput(
  value: unknown,
): asserts value is SubjectAnchorOutput {
  if (!validateSchema(schemas.SubjectAnchorOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validateSubjectOutput(
  value: unknown,
): asserts value is SubjectOutput {
  if (!validateSchema(schemas.SubjectOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validateTrackOutput(
  value: unknown,
): asserts value is TrackOutput {
  if (!validateSchema(schemas.TrackOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validatePlaceOutput(
  value: unknown,
): asserts value is PlaceOutput {
  if (!validateSchema(schemas.PlaceOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validateCheckOutput(
  value: unknown,
): asserts value is CheckOutput {
  if (!validateSchema(schemas.CheckOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validateRenderOutput(
  value: unknown,
): asserts value is RenderOutput {
  if (!validateSchema(schemas.RenderOutput, value))
    throw Error("CONTRACT_INVALID");
}
export function validateProvenance(
  value: unknown,
): asserts value is Provenance {
  if (!validateSchema(schemas.Provenance, value))
    throw Error("CONTRACT_INVALID");
}
