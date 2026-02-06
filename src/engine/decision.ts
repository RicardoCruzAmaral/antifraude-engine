// src/engine/decision.ts
export type Decision = "APPROVE" | "DECLINE";
export type Profile = "A" | "B1" | "B2" | "C";

function envInt(name: string, fallback: number) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function envStr(name: string, fallback: string) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export type Flags = {
  hardBlock: boolean;
  softDivergence: boolean;
  altoValor: boolean;
  bemValidado: boolean;
};

export function computeFlags(args: {
  inputValorCelular: number | null;
  enrichmentOk: boolean;
  summary: any; // enrichResult.summary
  motivos: string[];
}) : Flags {
  const highValueMin = envInt("VALOR_CELULAR_HIGH_VALUE_MIN", 5000);
  const nomeMin = envInt("NOME_MIN_ASSERTIVIDADE", 50);

  const valor = args.inputValorCelular ?? 0;
  const altoValor = valor >= highValueMin;

  const percNome = Number(args.summary?.percentualAssertividadeNome ?? NaN);
  const nomeDivergenteHard = Number.isFinite(percNome) ? (percNome < nomeMin) : false;

  const mandadoPrisao = args.summary?.mandadoPrisao === true;

  const riscoCredito = String(args.summary?.riscoCredito ?? "").toUpperCase();
  const probPagto = String(args.summary?.probabilidadePagamento ?? "").toUpperCase();

  // regra 14 (versão simples):
  const riscoCreditoHard =
    (riscoCredito === "ALTO" || riscoCredito === "ALTISSIMO") &&
    (probPagto === "MEDIO" || probPagto === "BAIXO" || probPagto === "BAIXISSIMO");

  // divergências leves (não declinam) – vem como “motivos” do provider
  const motivosUpper = (args.motivos ?? []).map((m) => String(m).toUpperCase());
  const softDivergence =
    motivosUpper.some((m) => m.includes("EMAIL DIVERGENTE")) ||
    motivosUpper.some((m) => m.includes("CEP DIVERGENTE")) ||
    motivosUpper.some((m) => m.includes("TELEFONE DIVERGENTE"));

  const hardBlock = nomeDivergenteHard || mandadoPrisao || riscoCreditoHard;

  // bem_validado: enrichment ok + não hard block
  const bemValidado = args.enrichmentOk && !hardBlock;

  return { hardBlock, softDivergence, altoValor, bemValidado };
}

export function classifyProfile(args: {
  baseDecision: Decision; // decisão espelho (provider) ou preliminar
  flags: Flags;
}): Profile {
  if (args.flags.hardBlock) return "C";
  if (args.baseDecision === "DECLINE") return "C"; // V0: espelho simples

  // daqui pra baixo baseDecision é APPROVE
  if (args.flags.altoValor) return "B2";
  if (args.flags.softDivergence) return "B1";
  return "A";
}

export function shouldCallImei(args: {
  profile: Profile;
  flags: Flags;
}): boolean {
  const mode = envStr("IMEI_POLICY_MODE", "prod").toLowerCase();

  if (mode === "homolog") {
    // teste de fogo controlado: B1 e B2 passam pela API
    return args.profile === "B1" || args.profile === "B2";
  }

  // produção: só o “perfil caro/sensível” e bem validado
  return args.profile === "B2" && args.flags.altoValor && args.flags.bemValidado;
}