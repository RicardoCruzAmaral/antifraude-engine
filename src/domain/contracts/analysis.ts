import type { Decision, HardBlockResult, Profile, ScoreBreakdownItem } from "./decision";
import type { NormalizedImeiResult } from "./imei";

export type AnalysisSource = "cache" | "engine";

export type InternalAnalysisResult = {
  source: AnalysisSource;
  decision: Decision;
  score: number | null;
  reasons: string[];
  scoreBreakdown: ScoreBreakdownItem[];
  profile: Profile | null;
  hardBlock: HardBlockResult | null;
  imei: NormalizedImeiResult | null;
  ruleVersion: string;
};
