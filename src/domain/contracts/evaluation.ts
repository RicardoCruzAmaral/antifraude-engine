import type {
  Decision,
  HardBlockResult,
  Profile,
  ScoreBreakdownItem,
  TelemetryFlags,
} from "./decision";

export type PreEvaluationResult = {
  hardBlock: HardBlockResult;
  baseScore: number | null;
  scoreBreakdown: ScoreBreakdownItem[];
  telemetryFlags: TelemetryFlags | null;
};

export type FinalEvaluationResult = {
  hardBlock: HardBlockResult;
  score: number | null;
  scoreBreakdown: ScoreBreakdownItem[];
  reasons: string[];
  profile: Profile | null;
  decision: Decision;
};
