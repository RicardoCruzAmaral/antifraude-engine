import type { EnrichmentSummary } from "../../domain/contracts";

export type EnrichmentMode = "off" | "mock" | "real";

export type EnrichmentProviderInput = {
  traceId: string;
  cpf: string;
  nome?: string | null;
  email?: string | null;
  telefone_contato?: string | null;
  valor_celular?: number | null;
  cep?: string | null;
  partnerCode?: string | null;
  salesChannel?: string | null;
  proposalId?: string | null;
  sessionId?: string | null;
};

export type EnrichmentProviderError = {
  msg: string;
  code?: string;
  detail?: unknown;
};

export type EnrichmentProviderResult = {
  ok: boolean;
  mode: EnrichmentMode;
  provider: "techtrail" | "mock";
  ms: number;
  httpStatus?: number | null;
  requestParams: Record<string, unknown>;
  raw?: unknown;
  summary?: EnrichmentSummary;
  error?: EnrichmentProviderError;
};

export interface EnrichmentProvider {
  enrich(input: EnrichmentProviderInput): Promise<EnrichmentProviderResult>;
}
