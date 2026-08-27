import type { NormalizedImeiResult } from "../../domain/contracts";

export type ImeiProviderInput = {
  imeiCode: string;
  modeloDeclarado?: string | null;
  timeoutMs: number;
};

export interface ImeiProvider {
  check(input: ImeiProviderInput): Promise<NormalizedImeiResult>;
}
