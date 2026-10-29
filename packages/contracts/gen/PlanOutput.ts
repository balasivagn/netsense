/* Generated from JSON Schema. Do not edit. */

export interface PlanOutput {
  remarks: {
    remarkId: string;
    /**
     * @minItems 1
     */
    turnIds: [string, ...string[]];
    aboutSubject: "yes" | "no" | "unclear" | "general";
    kind: "feedback" | "instruction" | "praise" | "other";
    aboutHint: string;
    atMs: number;
    coachWords: string;
  }[];
  fanOut: {
    remarkId: string;
    stages: ("moment" | "subject" | "track" | "place" | "check")[];
  }[];
  drafts: {
    /**
     * @maxItems 2
     */
    focus:
      | []
      | [
          {
            id: string;
            title: string;
            why: string;
            remarkIds: string[];
            source: "ai_draft";
            approved: false;
            editedByCoach: false;
          },
        ]
      | [
          {
            id: string;
            title: string;
            why: string;
            remarkIds: string[];
            source: "ai_draft";
            approved: false;
            editedByCoach: false;
          },
          {
            id: string;
            title: string;
            why: string;
            remarkIds: string[];
            source: "ai_draft";
            approved: false;
            editedByCoach: false;
          },
        ];
    practice: {
      id: string;
      title: string;
      why: string;
      remarkIds: string[];
      source: "ai_draft";
      approved: false;
      editedByCoach: false;
    }[];
    note: {
      text: string;
      why: string;
      source: "ai_draft";
      approved: false;
    } | null;
  };
}
