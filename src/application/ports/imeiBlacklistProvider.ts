import type { ImeiBlacklistEvidence } from "../../domain/contracts";

export type ImeiBlacklistValidation = {
  normalizedImei: string;
  valid: boolean;
};

export interface ImeiBlacklistProvider {
  readonly provider: "imei_info";
  readonly service: string | null;
  normalizeAndValidate(imeiCode: string): ImeiBlacklistValidation;
  check(input: { imeiCode: string; timeoutMs: number }): Promise<ImeiBlacklistEvidence>;
}
