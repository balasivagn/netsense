/* Generated from JSON Schema. Do not edit. */

export interface Provenance {
  configVersion: number;
  stageRunIds: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^(moment|subject|track|place|check)$".
     */
    [k: string]: string;
  };
  workers: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^(moment|subject|track|place|check)$".
     */
    [k: string]: string;
  };
  modelVersions: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[A-Za-z0-9_.@-]+$".
     */
    [k: string]: string;
  };
  placedBy: "ai" | "coach";
  candidate: string | null;
}
