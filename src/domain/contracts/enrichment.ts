export type ProviderDecision = "ACEITO" | "DECLINADO";

export type EnrichmentSummary = {
  providerDecision?: ProviderDecision | null;
  motivos?: string[];
  riscoCredito?: string | null;
  probabilidadePagamento?: string | null;
  quantidadeProcessos?: number | null;
  mandadoPrisao?: boolean | null;
  pessoaExpostaPoliticamente?: string | null;
  percentualAssertividadeNome?: number | null;
  situacaoCpf?: string | null;
  [key: string]: unknown;
};

export type EnrichmentResultForDecision = {
  ok?: boolean;
  mode?: string;
  provider?: string;
  ms?: number;
  httpStatus?: number | null;
  requestParams?: Record<string, unknown> | null;
  raw?: unknown;
  summary?: EnrichmentSummary | null;
  error?: unknown;
  [key: string]: unknown;
};
