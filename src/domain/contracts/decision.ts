export type Decision = "APPROVE" | "DECLINE";

export type Profile = "A" | "B1" | "B2" | "C";

export type ScoreBreakdownItem = {
  rule: string;
  points: number;
};

export type ScoreResult = {
  score: number;
  breakdown: ScoreBreakdownItem[];
};

export type HardBlockResult = {
  isHardBlock: boolean;
  reasons: string[];
};

export type TelemetryFlags = {
  nonMobile: boolean;
  emailDivergente: boolean;
  telefoneDivergente: boolean;
  cepDivergente: boolean;
  riscoCredito: string | null;
  probabilidadePagamento: string | null;
  quantidadeProcessos: number | null;
};
