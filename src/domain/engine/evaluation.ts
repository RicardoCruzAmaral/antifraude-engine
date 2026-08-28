import type {
  EnrichmentResultForDecision,
  FinalEvaluationResult,
  InputSummary,
  NormalizedImeiResult,
  ImeiBlacklistStatus,
  PreEvaluationResult,
  TelemetryFlags,
} from "../contracts";
import { detectHardBlock } from "./hardBlocks";
import { classifyProfileByScore } from "./profiles";
import { computeScoreLocal } from "./scoring";

export function computeTelemetryFlags(
  enrichResult: EnrichmentResultForDecision,
  input: InputSummary
): TelemetryFlags {
  const motivos = Array.isArray(enrichResult?.summary?.motivos)
    ? enrichResult.summary.motivos
    : [];

  return {
    // hard blocks do fingerprint (quando você ligar)
    nonMobile: input?.device?.isMobile === false,

    // divergências básicas (se a techtrail mandar como motivo)
    emailDivergente: motivos.includes("EMAIL DIVERGENTE"),
    telefoneDivergente: motivos.includes("TELEFONE DIVERGENTE"),
    cepDivergente: motivos.includes("CEP DIVERGENTE"),

    // risco (se vier no summary)
    riscoCredito: enrichResult?.summary?.riscoCredito ?? null,
    probabilidadePagamento:
      enrichResult?.summary?.probabilidadePagamento ?? null,

    // processos
    quantidadeProcessos: enrichResult?.summary?.quantidadeProcessos ?? null,
  };
}

export function preEvaluate(
  enrichResult: EnrichmentResultForDecision,
  input: InputSummary
): PreEvaluationResult {
  const hardBlock = detectHardBlock(enrichResult);

  if (hardBlock.isHardBlock) {
    return {
      hardBlock,
      baseScore: null,
      scoreBreakdown: [],
      telemetryFlags: null,
    };
  }

  console.log("🟦 about to call computeScoreLocal");
  const scoreResult = computeScoreLocal(enrichResult, input);
  console.log("🟩 returned from computeScoreLocal", scoreResult);

  const baseScore = Number.isFinite(scoreResult?.score)
    ? scoreResult.score
    : 0;
  const scoreBreakdown = Array.isArray(scoreResult?.breakdown)
    ? scoreResult.breakdown
    : [];

  return {
    hardBlock,
    baseScore,
    scoreBreakdown,
    telemetryFlags: computeTelemetryFlags(enrichResult, input),
  };
}

export function finalizeEvaluation(
  preEvaluation: PreEvaluationResult,
  imeiResult: NormalizedImeiResult | null,
  imeiProblemScore: number
): FinalEvaluationResult {
  if (preEvaluation.hardBlock.isHardBlock) {
    return {
      hardBlock: preEvaluation.hardBlock,
      score: null,
      scoreBreakdown: preEvaluation.scoreBreakdown,
      reasons: preEvaluation.hardBlock.reasons,
      profile: null,
      decision: "DECLINE",
    };
  }

  let score = preEvaluation.baseScore ?? 0;
  const scoreBreakdown = [...preEvaluation.scoreBreakdown];

  if (
    imeiResult?.reason === "IMEI_INVALID" ||
    imeiResult?.reason === "IMEI_FAIL" ||
    imeiResult?.reason === "IMEI_BRAND_MISMATCH"
  ) {
    score += imeiProblemScore;
    scoreBreakdown.push({
      rule: imeiResult.reason,
      points: imeiProblemScore,
    });
  }

  const profile = classifyProfileByScore(score ?? 0);
  const decision = profile === "C" ? "DECLINE" : "APPROVE";
  const reasons = scoreBreakdown.map((item) => item.rule);

  return {
    hardBlock: preEvaluation.hardBlock,
    score,
    scoreBreakdown,
    reasons,
    profile,
    decision,
  };
}

export function finalizeBlacklistEvaluation(
  preEvaluation: PreEvaluationResult,
  blacklistStatus: ImeiBlacklistStatus | null,
  imeiInvalidScore: number
): FinalEvaluationResult {
  if (preEvaluation.hardBlock.isHardBlock) {
    return finalizeEvaluation(preEvaluation, null, 0);
  }

  if (blacklistStatus === "INVALID") {
    return finalizeEvaluation(preEvaluation, {
      ok: false,
      provider: "imei_info",
      ms: 0,
      reason: "IMEI_INVALID",
      brandExpected: "UNKNOWN",
      brandReturned: null,
      serviceId: null,
      summary: null,
      raw: null,
    }, imeiInvalidScore);
  }

  const base = finalizeEvaluation(preEvaluation, null, 0);
  if (blacklistStatus !== "BLACKLISTED") return base;
  return {
    ...base,
    decision: "DECLINE",
    reasons: [...base.reasons, "IMEI_BLACKLISTED"],
  };
}
