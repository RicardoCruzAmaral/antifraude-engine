import type { NormalizedImeiResult } from "../../domain/contracts";

export type EnrichmentRaw = {
  traceId: string;
  cpf: string;
  provider: string;
  ok: boolean;
  mode: string;
  httpStatus: number | null;
  latencyMs: number | null;
  requestParams: any;
  responseJson: any;
  error: any;
};

export type ImeiRaw = {
  traceId: string;
  cpf: string;
  imeiCode: string | null;
  modeloDeclarado: string | null;
  result: NormalizedImeiResult;
};

export interface ProviderRawRepository {
  saveEnrichment(enrichment: EnrichmentRaw): Promise<void>;
  saveImei(imei: ImeiRaw): Promise<void>;
}
