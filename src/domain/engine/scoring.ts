import type {
  EnrichmentResultForDecision,
  InputSummary,
  ScoreBreakdownItem,
  ScoreResult,
} from "../contracts";
import { hasReason, normEnum } from "./normalization";

function envInt(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export function computeScoreLocal(
  enrichResult: EnrichmentResultForDecision,
  input: InputSummary
): ScoreResult {
  console.log("✅ DEBUG computeScoreLocal ENTER");

  const breakdown: ScoreBreakdownItem[] = [];
  const motivos: string[] = Array.isArray(enrichResult?.summary?.motivos)
    ? enrichResult.summary.motivos
    : [];

  console.log("motivos:", motivos);

  // Divergências cadastrais (motivos)
  const P_EMAIL = envInt("SCORE_EMAIL_DIVERGENTE", 0);
  const P_TEL = envInt("SCORE_TELEFONE_DIVERGENTE", 0);
  const P_CEP = envInt("SCORE_CEP_DIVERGENTE", 5);

  if (hasReason(motivos, "EMAIL DIVERGENTE"))
    breakdown.push({ rule: "EMAIL_DIVERGENTE", points: P_EMAIL });
  if (hasReason(motivos, "TELEFONE DIVERGENTE"))
    breakdown.push({ rule: "TELEFONE_DIVERGENTE", points: P_TEL });
  if (hasReason(motivos, "CEP DIVERGENTE"))
    breakdown.push({ rule: "CEP_DIVERGENTE", points: P_CEP });

  // riscoCredito
  const risco = normEnum(enrichResult?.summary?.riscoCredito);
  const riscoMap: Record<string, number> = {
    ALTISSIMO: envInt("SCORE_RISCO_ALTISSIMO", 20),
    ALTO: envInt("SCORE_RISCO_ALTO", 15),
    MEDIO: envInt("SCORE_RISCO_MEDIO", 5),
    BAIXO: envInt("SCORE_RISCO_BAIXO", 0),
    BAIXISSIMO: envInt("SCORE_RISCO_BAIXISSIMO", 0),
  };
  if (risco && riscoMap[risco] !== undefined)
    breakdown.push({ rule: `RISCO_${risco}`, points: riscoMap[risco] });

  // probabilidadePagamento (invertido) — valores vêm: ALTA / ALTÍSSIMA / MÉDIA / BAIXA / BAIXÍSSIMA
  const prob = normEnum(enrichResult?.summary?.probabilidadePagamento);

  const probMap: Record<string, number> = {
    ALTISSIMA: envInt("SCORE_PROB_ALTISSIMA", 0),
    ALTA: envInt("SCORE_PROB_ALTA", 0),
    MEDIA: envInt("SCORE_PROB_MEDIA", 5),
    BAIXA: envInt("SCORE_PROB_BAIXA", 15),
    BAIXISSIMA: envInt("SCORE_PROB_BAIXISSIMA", 20),
  };

  if (prob && probMap[prob] !== undefined) {
    breakdown.push({ rule: `PROB_${prob}`, points: probMap[prob] });
  }

  // quantidadeProcessos
  const qpRaw = enrichResult?.summary?.quantidadeProcessos;
  const qp = Number.isFinite(Number(qpRaw)) ? Number(qpRaw) : 0;
  const P_PROC_4_5 = envInt("SCORE_PROC_4_5", 20);
  const P_PROC_GT_5 = envInt("SCORE_PROC_GT_5", 25);

  if (qp > 3 && qp <= 5) {
    breakdown.push({ rule: "PROCESSOS_4_5", points: P_PROC_4_5 });
  } else if (qp > 5) {
    breakdown.push({ rule: "PROCESSOS_GT_5", points: P_PROC_GT_5 });
  }

  // valor_celular high value
  const highMin = envInt("VALOR_CELULAR_HIGH_VALUE_MIN", 5000);
  const highPts = envInt("SCORE_VALOR_CELULAR_HIGH_VALUE", 5);

  if (
    typeof input.valor_celular === "number" &&
    input.valor_celular > highMin
  ) {
    breakdown.push({ rule: "VALOR_CELULAR_HIGH_VALUE", points: highPts });
  }

  const score = breakdown.reduce((acc, x) => acc + x.points, 0);
  return { score, breakdown };
}
