import type { ImeiBlacklistProvider } from "../../../application/ports";
import { imeiBlacklistCheckReal } from "../../../providers/imeiBlacklist";
import { isValidImei, normalizeImei } from "../../../providers/imei";

export function resolveBlacklistServiceId(value: string | undefined): number | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createImeiBlacklistProvider(serviceId: number | null): ImeiBlacklistProvider {
  const validatedServiceId = Number.isSafeInteger(serviceId) && Number(serviceId) > 0
    ? serviceId
    : null;
  return {
    provider: "imei_info",
    service: validatedServiceId === null ? null : `blacklist:${validatedServiceId}`,
    normalizeAndValidate(imeiCode) {
      const normalizedImei = normalizeImei(imeiCode);
      return { normalizedImei, valid: !!normalizedImei && isValidImei(normalizedImei) };
    },
    check(input) {
      return imeiBlacklistCheckReal({ ...input, serviceId: validatedServiceId });
    },
  };
}
