import type {
  EnrichmentResultForDecision,
  HardBlockResult,
} from "../contracts";
import { hasReason, normEnum } from "./normalization";

export function detectHardBlock(
  enrichResult: EnrichmentResultForDecision
): HardBlockResult {
  const motivos: string[] = Array.isArray(enrichResult?.summary?.motivos)
    ? enrichResult.summary.motivos
    : [];

  const hardMotivos = [
    "NOME DIVERGENTE",
    "CPF INVÁLIDO",
    "CPF COM SITUAÇÃO IRREGULAR",
    "CPF NÃO ENCONTRADO",
    "CPF CONSTA OBITO",
    "CPF SOCIO DE CNAE IMPEDIDO",
    "CONSTA MANDADO DE PRISAO",
    "CONSTAM 5 AÇÕES CIVEIS COMO AUTOR",
    "POSSUI ACAO CRIMINAL",
    // se a TechTrail mandar com variação mínima, o normEnum segura bem
  ];

  const hitHard = hardMotivos.filter((m) => hasReason(motivos, m));
  const risco = normEnum(enrichResult?.summary?.riscoCredito);
  const prob = normEnum(enrichResult?.summary?.probabilidadePagamento);

  const comboHard =
    risco === "ALTISSIMO" && (prob === "BAIXA" || prob === "BAIXISSIMA");
  const comboReasons = comboHard ? ["HARD_BLOCK_RISCO_PROB"] : [];

  const finalReasons = [...hitHard, ...comboReasons];
  return { isHardBlock: finalReasons.length > 0, reasons: finalReasons };
}
