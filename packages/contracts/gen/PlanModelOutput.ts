/* Generated from JSON Schema. Do not edit. */

export interface PlanModelOutput {
  coachSpeaker: string;
  remarks: {
    /**
     * @minItems 1
     */
    turnIds: [string, ...string[]];
    aboutSubject: "yes" | "no" | "unclear" | "general";
    kind: "feedback" | "instruction" | "praise" | "other";
    aboutHint: string;
  }[];
  /**
   * @maxItems 2
   */
  focusDrafts:
    | []
    | [
        {
          title: string;
          why: string;
          remarkIndexes: number[];
        },
      ]
    | [
        {
          title: string;
          why: string;
          remarkIndexes: number[];
        },
        {
          title: string;
          why: string;
          remarkIndexes: number[];
        },
      ];
  practiceDrafts: {
    title: string;
    why: string;
    remarkIndexes: number[];
  }[];
  noteDraft: {
    text: string;
    why: string;
  };
}
