export type DecisionScoreConfig = {
  scoreEmailDivergente: number;
  scoreTelefoneDivergente: number;
  scoreCepDivergente: number;
  scoreRiscoAltissimo: number;
  scoreRiscoAlto: number;
  scoreRiscoMedio: number;
  scoreRiscoBaixo: number;
  scoreRiscoBaixissimo: number;
  scoreProbAltissima: number;
  scoreProbAlta: number;
  scoreProbMedia: number;
  scoreProbBaixa: number;
  scoreProbBaixissima: number;
  scoreProcessos4A5: number;
  scoreProcessosMaiorQue5: number;
  valorCelularHighValueMin: number;
  scoreValorCelularHighValue: number;
};

function resolvedNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function resolveDecisionScoreConfig(): DecisionScoreConfig {
  return {
    scoreEmailDivergente: resolvedNumber("SCORE_EMAIL_DIVERGENTE", 0),
    scoreTelefoneDivergente: resolvedNumber("SCORE_TELEFONE_DIVERGENTE", 0),
    scoreCepDivergente: resolvedNumber("SCORE_CEP_DIVERGENTE", 5),
    scoreRiscoAltissimo: resolvedNumber("SCORE_RISCO_ALTISSIMO", 20),
    scoreRiscoAlto: resolvedNumber("SCORE_RISCO_ALTO", 15),
    scoreRiscoMedio: resolvedNumber("SCORE_RISCO_MEDIO", 5),
    scoreRiscoBaixo: resolvedNumber("SCORE_RISCO_BAIXO", 0),
    scoreRiscoBaixissimo: resolvedNumber("SCORE_RISCO_BAIXISSIMO", 0),
    scoreProbAltissima: resolvedNumber("SCORE_PROB_ALTISSIMA", 0),
    scoreProbAlta: resolvedNumber("SCORE_PROB_ALTA", 0),
    scoreProbMedia: resolvedNumber("SCORE_PROB_MEDIA", 5),
    scoreProbBaixa: resolvedNumber("SCORE_PROB_BAIXA", 15),
    scoreProbBaixissima: resolvedNumber("SCORE_PROB_BAIXISSIMA", 20),
    scoreProcessos4A5: resolvedNumber("SCORE_PROC_4_5", 20),
    scoreProcessosMaiorQue5: resolvedNumber("SCORE_PROC_GT_5", 25),
    valorCelularHighValueMin: resolvedNumber("VALOR_CELULAR_HIGH_VALUE_MIN", 5000),
    scoreValorCelularHighValue: resolvedNumber("SCORE_VALOR_CELULAR_HIGH_VALUE", 5),
  };
}
