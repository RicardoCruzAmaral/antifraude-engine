import type {
  CacheV2ShadowTelemetry,
  ImeiEvidence,
  ImeiEvidenceCache,
  LookupTokenService,
} from "../ports";
import type {
  ImeiBlacklistEvidence,
  ImeiBlacklistProviderFields,
  ImeiBlacklistStatus,
} from "../../domain/contracts";
import { isConsistentImeiBlacklistFactualStatus } from "../../domain/engine";

export type ImeiBlacklistReadDependencies = {
  imeiEvidenceCache: ImeiEvidenceCache | null;
  lookupTokenService: LookupTokenService | null;
  telemetry: CacheV2ShadowTelemetry;
  provider: "imei_info";
  service: string | null;
  providerContractVersion: string;
  normalizerVersion: string;
  cacheSchemaVersion: string;
};

export type ImeiBlacklistReadResult =
  | { state: "HIT"; evidence: ImeiEvidence; result: ImeiBlacklistEvidence }
  | { state: "FALLBACK"; cacheState: string };

function record(dependencies: ImeiBlacklistReadDependencies, event: Parameters<CacheV2ShadowTelemetry["record"]>[0]) {
  try { dependencies.telemetry.record(event); }
  catch { console.error("[cache-v2-read] telemetry failed"); }
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function validOptionalString(value: unknown) {
  return value === null || value === undefined || typeof value === "string";
}

function fromNormalized(
  value: unknown,
  input: { imei: string; fetchedAt: string; rawReference?: string | null },
  dependencies: ImeiBlacklistReadDependencies
): ImeiBlacklistEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const statuses: ImeiBlacklistStatus[] = ["CLEAN", "BLACKLISTED", "UNKNOWN"];
  if (!statuses.includes(item.status as ImeiBlacklistStatus)) return null;
  for (const key of ["model", "modelName", "manufacturer", "blacklistStatusRaw", "generalListStatus", "providerCreatedAt"]) {
    if (!validOptionalString(item[key])) return null;
  }
  if (item.blacklistRecords !== null && item.blacklistRecords !== undefined &&
      (!Number.isInteger(item.blacklistRecords) || Number(item.blacklistRecords) < 0)) return null;
  if (item.deviceIsClean !== null && item.deviceIsClean !== undefined && typeof item.deviceIsClean !== "boolean") return null;
  const fields: ImeiBlacklistProviderFields = {
    model: optionalString(item.model),
    modelName: optionalString(item.modelName),
    manufacturer: optionalString(item.manufacturer),
    blacklistStatusRaw: optionalString(item.blacklistStatusRaw),
    generalListStatus: optionalString(item.generalListStatus),
    blacklistRecords: typeof item.blacklistRecords === "number" ? item.blacklistRecords : null,
    deviceIsClean: typeof item.deviceIsClean === "boolean" ? item.deviceIsClean : null,
    providerCreatedAt: optionalString(item.providerCreatedAt),
    imeiNumber: null,
  };
  if (!isConsistentImeiBlacklistFactualStatus(item.status as ImeiBlacklistStatus, fields)) return null;
  return {
    imei: input.imei,
    provider: dependencies.provider,
    service: dependencies.service,
    status: item.status as ImeiBlacklistStatus,
    model: fields.model,
    modelName: fields.modelName,
    manufacturer: fields.manufacturer,
    blacklistStatusRaw: fields.blacklistStatusRaw,
    generalListStatus: fields.generalListStatus,
    blacklistRecords: fields.blacklistRecords,
    deviceIsClean: fields.deviceIsClean,
    providerCreatedAt: fields.providerCreatedAt,
    fetchedAt: input.fetchedAt,
    rawReference: input.rawReference ?? null,
    httpStatus: null,
    latencyMs: 0,
    technicalReason: null,
    raw: null,
  };
}

function compatible(evidence: ImeiEvidence, dependencies: ImeiBlacklistReadDependencies) {
  const fetchedAt = Date.parse(evidence.fetchedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  return evidence.completeness === "COMPLETE" &&
    evidence.provider === dependencies.provider && evidence.service === dependencies.service &&
    evidence.providerContractVersion === dependencies.providerContractVersion &&
    evidence.normalizerVersion === dependencies.normalizerVersion &&
    evidence.cacheSchemaVersion === dependencies.cacheSchemaVersion &&
    Number.isFinite(fetchedAt) && Number.isFinite(expiresAt) &&
    fetchedAt <= Date.now() && expiresAt > fetchedAt && expiresAt > Date.now();
}

export async function readImeiBlacklistEvidence(
  dependencies: ImeiBlacklistReadDependencies,
  input: { traceId: string; imeiCode: string }
): Promise<ImeiBlacklistReadResult> {
  if (!dependencies.service || !dependencies.lookupTokenService || !dependencies.imeiEvidenceCache) {
    record(dependencies, { name: "IMEI_BLACKLIST_CACHE_MISS", traceId: input.traceId, reason: "DEPENDENCY_UNAVAILABLE", details: { state: "BYPASS" } });
    return { state: "FALLBACK", cacheState: "BYPASS" };
  }
  try {
    const lookup = await dependencies.imeiEvidenceCache.get({
      lookupToken: dependencies.lookupTokenService.tokenizeImei(input.imeiCode),
      provider: dependencies.provider,
      service: dependencies.service,
      providerContractVersion: dependencies.providerContractVersion,
      normalizerVersion: dependencies.normalizerVersion,
      cacheSchemaVersion: dependencies.cacheSchemaVersion,
    });
    if (lookup.state === "HIT") {
      const result = compatible(lookup.value, dependencies)
        ? fromNormalized(lookup.value.normalizedEvidence, { imei: input.imeiCode, fetchedAt: lookup.value.fetchedAt, rawReference: lookup.value.rawReference }, dependencies)
        : null;
      if (!result) {
        record(dependencies, { name: "IMEI_BLACKLIST_CACHE_MISS", traceId: input.traceId, reason: "HIT_VALIDATION_FAILED", details: { state: "INCOMPATIBLE" } });
        return { state: "FALLBACK", cacheState: "INCOMPATIBLE" };
      }
      record(dependencies, {
        name: "IMEI_BLACKLIST_CACHE_HIT", traceId: input.traceId,
        details: { ageMs: lookup.ageMs, fetchedAt: lookup.value.fetchedAt, rawReference: lookup.value.rawReference ?? null, provider: lookup.value.provider, service: lookup.value.service },
      });
      return { state: "HIT", evidence: lookup.value, result };
    }
    record(dependencies, {
      name: "IMEI_BLACKLIST_CACHE_MISS", traceId: input.traceId,
      reason: lookup.state === "INCOMPATIBLE" ? lookup.reason : lookup.state === "BACKEND_ERROR" ? lookup.errorCode : lookup.state,
      details: { state: lookup.state },
    });
    return { state: "FALLBACK", cacheState: lookup.state };
  } catch {
    console.error("[cache-v2-read] IMEI Blacklist lookup failed", { traceId: input.traceId, reason: "LOOKUP_FAILED" });
    record(dependencies, { name: "IMEI_BLACKLIST_CACHE_MISS", traceId: input.traceId, reason: "LOOKUP_FAILED", details: { state: "BACKEND_ERROR" } });
    return { state: "FALLBACK", cacheState: "BACKEND_ERROR" };
  }
}
