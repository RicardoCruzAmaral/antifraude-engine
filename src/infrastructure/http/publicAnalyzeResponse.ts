import type { Decision } from "../../domain/contracts";

export type PublicAnalyzeResponse = {
  ok: true;
  traceId: string;
  decision: Decision;
  score: number | null;
  reasons: string[];
  ruleVersion: string;
};

type AnalyzeSuccessSource = {
  ok: true;
  traceId: string;
  decision: Decision;
  score: number | null;
  reasons: string[];
  ruleVersion: string;
};

function isAnalyzeSuccessSource(value: unknown): value is AnalyzeSuccessSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AnalyzeSuccessSource>;
  return candidate.ok === true &&
    typeof candidate.traceId === "string" &&
    (candidate.decision === "APPROVE" || candidate.decision === "DECLINE") &&
    (candidate.score === null || (typeof candidate.score === "number" && Number.isFinite(candidate.score))) &&
    Array.isArray(candidate.reasons) &&
    candidate.reasons.every((reason) => typeof reason === "string") &&
    typeof candidate.ruleVersion === "string";
}

export function toPublicAnalyzeResponse(result: unknown): PublicAnalyzeResponse {
  if (!isAnalyzeSuccessSource(result)) {
    throw new Error("INVALID_ANALYZE_SUCCESS_RESULT");
  }
  return {
    ok: true,
    traceId: result.traceId,
    decision: result.decision,
    score: result.score,
    reasons: [...result.reasons],
    ruleVersion: result.ruleVersion,
  };
}
