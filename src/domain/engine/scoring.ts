import type {
  EnrichmentResultForDecision,
  InputSummary,
  ScoreBreakdownItem,
  ScoreResult,
} from "../contracts";
import { hasReason, normEnum } from "./normalization";
import { resolveDecisionScoreConfig, type DecisionScoreConfig } from "./scoreConfig";

export function computeScoreLocal(
  enrichResult: EnrichmentResultForDecision,
  input: InputSummary,
  config: DecisionScoreConfig = resolveDecisionScoreConfig()
): ScoreResult {
  console.log("✅ DEBUG computeScoreLocal ENTER");

  const breakdown: ScoreBreakdownItem[] = [];
  const motivos: string[] = Array.isArray(enrichResult?.summary?.motivos)
    ? enrichResult.summary.motivos
    : [];

  console.log("motivos:", motivos);

  // Divergências cadastrais (motivos)
  const P_EMAIL = config.scoreEmailDivergente;
  const P_TEL = config.scoreTelefoneDivergente;
  const P_CEP = config.scoreCepDivergente;

  if (hasReason(motivos, "EMAIL DIVERGENTE"))
    breakdown.push({ rule: "EMAIL_DIVERGENTE", points: P_EMAIL });
  if (hasReason(motivos, "TELEFONE DIVERGENTE"))
    breakdown.push({ rule: "TELEFONE_DIVERGENTE", points: P_TEL });
  if (hasReason(motivos, "CEP DIVERGENTE"))
    breakdown.push({ rule: "CEP_DIVERGENTE", points: P_CEP });

  // riscoCredito
  const risco = normEnum(enrichResult?.summary?.riscoCredito);
  const riscoMap: Record<string, number> = {
    ALTISSIMO: config.scoreRiscoAltissimo,
    ALTO: config.scoreRiscoAlto,
    MEDIO: config.scoreRiscoMedio,
    BAIXO: config.scoreRiscoBaixo,
    BAIXISSIMO: config.scoreRiscoBaixissimo,
  };
  if (risco && riscoMap[risco] !== undefined)
    breakdown.push({ rule: `RISCO_${risco}`, points: riscoMap[risco] });

  // probabilidadePagamento (invertido) — valores vêm: ALTA / ALTÍSSIMA / MÉDIA / BAIXA / BAIXÍSSIMA
  const prob = normEnum(enrichResult?.summary?.probabilidadePagamento);

  const probMap: Record<string, number> = {
    ALTISSIMA: config.scoreProbAltissima,
    ALTA: config.scoreProbAlta,
    MEDIA: config.scoreProbMedia,
    BAIXA: config.scoreProbBaixa,
    BAIXISSIMA: config.scoreProbBaixissima,
  };

  if (prob && probMap[prob] !== undefined) {
    breakdown.push({ rule: `PROB_${prob}`, points: probMap[prob] });
  }

  // quantidadeProcessos
  const qpRaw = enrichResult?.summary?.quantidadeProcessos;
  const qp = Number.isFinite(Number(qpRaw)) ? Number(qpRaw) : 0;
  const P_PROC_4_5 = config.scoreProcessos4A5;
  const P_PROC_GT_5 = config.scoreProcessosMaiorQue5;

  if (qp > 3 && qp <= 5) {
    breakdown.push({ rule: "PROCESSOS_4_5", points: P_PROC_4_5 });
  } else if (qp > 5) {
    breakdown.push({ rule: "PROCESSOS_GT_5", points: P_PROC_GT_5 });
  }

  // valor_celular high value
  const highMin = config.valorCelularHighValueMin;
  const highPts = config.scoreValorCelularHighValue;

  if (
    typeof input.valor_celular === "number" &&
    input.valor_celular > highMin
  ) {
    breakdown.push({ rule: "VALOR_CELULAR_HIGH_VALUE", points: highPts });
  }

  const score = breakdown.reduce((acc, x) => acc + x.points, 0);
  return { score, breakdown };
}
