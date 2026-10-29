/* Generated from JSON Schema. Do not edit. */

export interface PipelineConfig {
  version: number;
  note: string;
  /**
   * @minItems 9
   * @maxItems 9
   */
  stages: [
    {
      stage:
        | "transcode"
        | "transcribe"
        | "plan"
        | "moment"
        | "subject"
        | "track"
        | "place"
        | "check"
        | "render";
      coachLabel: string;
      workerId: string;
      workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
      provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
      model: string | null;
      fanOut: "none" | "per_remark";
      timeoutMs: number;
      retry: number;
      fallbackWorker: string | null;
      candidates: string[];
      enabled: boolean;
      critic: {
        workerId: string;
        provider:
          "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
        model: string;
        enabled: boolean;
      } | null;
    },
    {
      stage:
        | "transcode"
        | "transcribe"
        | "plan"
        | "moment"
        | "subject"
        | "track"
        | "place"
        | "check"
        | "render";
      coachLabel: string;
      workerId: string;
      workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
      provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
      model: string | null;
      fanOut: "none" | "per_remark";
      timeoutMs: number;
      retry: number;
      fallbackWorker: string | null;
      candidates: string[];
      enabled: boolean;
      critic: {
        workerId: string;
        provider:
          "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
        model: string;
        enabled: boolean;
      } | null;
    },
    {
      stage:
        | "transcode"
        | "transcribe"
        | "plan"
        | "moment"
        | "subject"
        | "track"
        | "place"
        | "check"
        | "render";
      coachLabel: string;
      workerId: string;
      workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
      provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
      model: string | null;
      fanOut: "none" | "per_remark";
      timeoutMs: number;
      retry: number;
      fallbackWorker: string | null;
      candidates: string[];
      enabled: boolean;
      critic: {
        workerId: string;
        provider:
          "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
        model: string;
        enabled: boolean;
      } | null;
    },
    {
      stage:
        | "transcode"
        | "transcribe"
        | "plan"
        | "moment"
        | "subject"
        | "track"
        | "place"
        | "check"
        | "render";
      coachLabel: string;
      workerId: string;
      workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
      provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
      model: string | null;
      fanOut: "none" | "per_remark";
      timeoutMs: number;
      retry: number;
      fallbackWorker: string | null;
      candidates: string[];
      enabled: boolean;
      critic: {
        workerId: string;
        provider:
          "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
        model: string;
        enabled: boolean;
      } | null;
    },
    {
      stage:
        | "transcode"
        | "transcribe"
        | "plan"
        | "moment"
        | "subject"
        | "track"
        | "place"
        | "check"
        | "render";
      coachLabel: string;
      workerId: string;
      workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
      provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
      model: string | null;
      fanOut: "none" | "per_remark";
      timeoutMs: number;
      retry: number;
      fallbackWorker: string | null;
      candidates: string[];
      enabled: boolean;
      critic: {
        workerId: string;
        provider:
          "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
        model: string;
        enabled: boolean;
      } | null;
    },
    {
      stage:
        | "transcode"
        | "transcribe"
        | "plan"
        | "moment"
        | "subject"
        | "track"
        | "place"
        | "check"
        | "render";
      coachLabel: string;
      workerId: string;
      workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
      provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
      model: string | null;
      fanOut: "none" | "per_remark";
      timeoutMs: number;
      retry: number;
      fallbackWorker: string | null;
      candidates: string[];
      enabled: boolean;
      critic: {
        workerId: string;
        provider:
          "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
        model: string;
        enabled: boolean;
      } | null;
    },
    {
      stage:
        | "transcode"
        | "transcribe"
        | "plan"
        | "moment"
        | "subject"
        | "track"
        | "place"
        | "check"
        | "render";
      coachLabel: string;
      workerId: string;
      workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
      provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
      model: string | null;
      fanOut: "none" | "per_remark";
      timeoutMs: number;
      retry: number;
      fallbackWorker: string | null;
      candidates: string[];
      enabled: boolean;
      critic: {
        workerId: string;
        provider:
          "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
        model: string;
        enabled: boolean;
      } | null;
    },
    {
      stage:
        | "transcode"
        | "transcribe"
        | "plan"
        | "moment"
        | "subject"
        | "track"
        | "place"
        | "check"
        | "render";
      coachLabel: string;
      workerId: string;
      workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
      provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
      model: string | null;
      fanOut: "none" | "per_remark";
      timeoutMs: number;
      retry: number;
      fallbackWorker: string | null;
      candidates: string[];
      enabled: boolean;
      critic: {
        workerId: string;
        provider:
          "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
        model: string;
        enabled: boolean;
      } | null;
    },
    {
      stage:
        | "transcode"
        | "transcribe"
        | "plan"
        | "moment"
        | "subject"
        | "track"
        | "place"
        | "check"
        | "render";
      coachLabel: string;
      workerId: string;
      workerType: "agent" | "sub_agent" | "model" | "tool" | "rules";
      provider: "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
      model: string | null;
      fanOut: "none" | "per_remark";
      timeoutMs: number;
      retry: number;
      fallbackWorker: string | null;
      candidates: string[];
      enabled: boolean;
      critic: {
        workerId: string;
        provider:
          "local" | "meta" | "fake" | "gemini" | "fireworks" | "baseten";
        model: string;
        enabled: boolean;
      } | null;
    },
  ];
  /**
   * @minItems 1
   */
  coachStages: [string, ...string[]];
  params: {
    personConcept: string;
    minPersonConfidence: number;
    maxMomentMs: number;
    momentLookbackMs: number;
    keyframeFps: number;
    trackPadMs: number;
    downsampleFps: number | null;
    minMarkCoverage: number;
    stillsThreshold: number;
    allowedMarkTypes: ("circle" | "arrow" | "highlight" | "label")[];
    maxMarksPerRemark: number;
    labelMaxChars: number;
    renderModeDefault: "video" | "stills";
    otherPersonRemarksInShare: boolean;
    anchorReuseMs: number;
    reassocIouMin: number;
    swapIouMin: number;
    swapJumpFrac: number;
    maxSubjectCandidates: number;
    subjectModel: string;
    segmentationModel: string;
  };
  limits: {
    jobSamFrameCap: number;
    jobSparkTokenCap: number;
    fanoutConcurrency: number;
    dailySpendLimitUsd: number;
    sandboxTimeoutCapS: number;
    sandboxIdleTimeoutS: number;
    jobMaxAttempts: number;
    maxVideoMinutes: number;
    jobLeaseS: number;
  };
}
