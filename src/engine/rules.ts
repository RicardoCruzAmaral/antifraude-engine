// src/engine/rules.ts
export type Decision = "APPROVE" | "DECLINE";
export type Bucket = "A" | "B1" | "B2" | "C";

type EnrichmentSummary = {
  // vindo do seu enrichment.ts (summary)
  riscoCredito?: string | null;
  probabilidadePagamento?: string | null;
  quantidadeProcessos?: number | null;

  // quando vocês tiverem isso no retorno real:
  mandadoPrisao?: boolean | null;
  situacaoCpf?: string | null; // "REGULAR" / "IRREGULAR" etc
  obito?: boolean | null;

  // divergências (você pode calcular comparando base vs informado)
  divergenciaCep?: boolean;
  divergenciaEmail?: boolean;
  divergenciaTelefone?: boolean;

  // nome assertividade
  percentualAssertividadeNome?: number | null;

  // processos criminais etc (quando existir)
  acaoCriminalComoReu?: boolean | null;

  // CNAE impedido (quando existir)
  cnaeImpedido?: boolean | null;
};

type InputSummary = {
  valor_celular: number | null;
};

function envInt(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function envStr(name: string, fallback: string) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export function hardBlocks(summary: EnrichmentSummary) {
  const motivos: string[] = [];

  const nomePct = summary.percentualAssertividadeNome ?? null;
  if (nomePct !== null && nomePct < 50) motivos.push("NOME_DIVERGENTE_<50");

  // Se você já tiver situacaoCpf/obito etc no retorno real:
  if (summary.situacaoCpf && summary.situacaoCpf !== "REGULAR") motivos.push("CPF_SITUACAO_IRREGULAR");
  if (summary.obito) motivos.push("CPF_CONSTA_OBITO");
  if (summary.mandadoPrisao) motivos.push("CONSTA_MANDADO_PRISAO");
  if (summary.acaoCriminalComoReu) motivos.push("POSSUI_ACAO_CRIMINAL");
  if (summary.cnaeImpedido) motivos.push("CPF_SOCIO_CNAE_IMPEDIDO");

  const processosMin = envInt("PROCESSOS_HARD_BLOCK_MIN", 5);
  const qtdProc = summary.quantidadeProcessos ?? 0;
  if (qtdProc >= processosMin) motivos.push(`PROCESSOS_TOTAL>=${processosMin}`);

  return { blocked: motivos.length > 0, motivos };
}

function scoreRiscoCredito(risco: string | null | undefined) {
  // Ajuste fino depois, mas já funciona:
  const r = (risco ?? "").toUpperCase();
  if (r.includes("ALTISS")) return 1.0;
  if (r.includes("ALTO")) return 0.8;
  if (r.includes("MED")) return 0.4;
  if (r.includes("BAIX")) return 0.1;
  return 0.3; // desconhecido = meio termo
}

function scoreProbPagamento(pp: string | null | undefined) {
  const p = (pp ?? "").toUpperCase();
  if (p.includes("BAIXISS")) return 1.0;
  if (p.includes("BAIXO")) return 0.8;
  if (p.includes("MED")) return 0.5;
  if (p.includes("ALTO")) return 0.2;
  return 0.5;
}

function scoreQtdProcessos(qtd: number | null | undefined) {
  const n = qtd ?? 0;
  if (n === 0) return 0.0;
  if (n <= 2) return 0.3;
  if (n <= 4) return 0.6;
  return 0.9;
}

function scoreDivergencias(summary: EnrichmentSummary) {
  const flags = [
    !!summary.divergenciaCep,
    !!summary.divergenciaEmail,
    !!summary.divergenciaTelefone,
  ];
  const count = flags.filter(Boolean).length;
  if (count === 0) return { s: 0.0, count };
  if (count === 1) return { s: 0.4, count };
  if (count === 2) return { s: 0.7, count };
  return { s: 1.0, count };
}

function scoreValorCelular(valor: number | null | undefined) {
  const highMin = envInt("VALOR_CELULAR_HIGH_VALUE_MIN", 5000);
  const v = valor ?? 0;
  if (!v) return 0.0;
  if (v >= highMin) return 1.0;
  if (v >= highMin * 0.7) return 0.6;
  return 0.2;
}

export function computeScore(input: InputSummary, summary: EnrichmentSummary) {
  const wCredito = envInt("W_RISCO_CREDITO", 20);
  const wPP = envInt("W_PROB_PAGAMENTO", 15);
  const wProc = envInt("W_QTD_PROCESSOS", 15);
  const wDiv = envInt("W_DIVERGENCIAS", 10);
  const wValor = envInt("W_VALOR_CELULAR", 10);

  const sCredito = scoreRiscoCredito(summary.riscoCredito) * wCredito;
  const sPP = scoreProbPagamento(summary.probabilidadePagamento) * wPP;
  const sProc = scoreQtdProcessos(summary.quantidadeProcessos) * wProc;

  const div = scoreDivergencias(summary);
  const sDiv = div.s * wDiv;

  const sValor = scoreValorCelular(input.valor_celular) * wValor;

  const total = Math.round(sCredito + sPP + sProc + sDiv + sValor);

  return {
    total,
    breakdown: {
      risco_credito: Math.round(sCredito),
      prob_pagamento: Math.round(sPP),
      qtd_processos: Math.round(sProc),
      divergencias: Math.round(sDiv),
      valor_celular: Math.round(sValor),
      divergencias_count: div.count,
    },
  };
}

export function bucketize(scoreTotal: number): Bucket {
  const aMax = envInt("SCORE_A_MAX", 19);
  const b1Max = envInt("SCORE_B1_MAX", 34);
  const b2Max = envInt("SCORE_B2_MAX", 49);

  if (scoreTotal <= aMax) return "A";
  if (scoreTotal <= b1Max) return "B1";
  if (scoreTotal <= b2Max) return "B2";
  return "C";
}

export function isBemValidado(summary: EnrichmentSummary) {
  const maxDiv = envInt("BEM_VALIDADO_MAX_DIVERGENCIAS", 1);
  const divCount =
    (summary.divergenciaCep ? 1 : 0) +
    (summary.divergenciaEmail ? 1 : 0) +
    (summary.divergenciaTelefone ? 1 : 0);
  return divCount <= maxDiv;
}

export function shouldCallImei(bucket: Bucket, bemValidado: boolean) {
  const policy = envStr("IMEI_POLICY", "b2_only");

  // "none" | "b2_only" | "b1_b2" | "all_nonA"
  if (policy === "none") return false;
  if (policy === "b2_only") return bucket === "B2";
  if (policy === "b1_b2") return bucket === "B1" || bucket === "B2";
  if (policy === "all_nonA") return bucket !== "A";

  // fallback
  return bucket === "B2";
}

export function finalDecisionFromBucket(bucket: Bucket) : Decision {
  // sem IMEI por enquanto:
  if (bucket === "C") return "DECLINE";
  return "APPROVE";
}
