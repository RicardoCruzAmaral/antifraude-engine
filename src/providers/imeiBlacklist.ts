import type {
  ImeiBlacklistEvidence,
  ImeiBlacklistProviderFields,
  ImeiBlacklistStatus,
} from "../domain/contracts";
import { classifyImeiBlacklistStatus } from "../domain/engine";
import { isValidImei, normalizeImei } from "./imei";

export type SupportedBlacklistResult = ImeiBlacklistProviderFields;

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeBlacklistFields(raw: any): SupportedBlacklistResult {
  return {
    model: textOrNull(raw?.model),
    modelName: textOrNull(raw?.model_name),
    manufacturer: textOrNull(raw?.manufacturer),
    imeiNumber: textOrNull(raw?.imei_number),
    blacklistStatusRaw: textOrNull(raw?.blacklist_status),
    generalListStatus: textOrNull(raw?.general_list_status),
    blacklistRecords: intOrNull(raw?.blacklist_records),
    deviceIsClean: typeof raw?.device_is_clean === "boolean" ? raw.device_is_clean : null,
    providerCreatedAt: textOrNull(raw?.created_at),
  };
}

export function classifyBlacklistStatus(fields: SupportedBlacklistResult): ImeiBlacklistStatus {
  return classifyImeiBlacklistStatus(fields);
}

function evidence(input: {
  imei: string;
  service: string | null;
  status: ImeiBlacklistStatus;
  fetchedAt: string;
  latencyMs: number;
  httpStatus?: number | null;
  technicalReason?: string | null;
  raw?: unknown;
  fields?: SupportedBlacklistResult;
}): ImeiBlacklistEvidence {
  const fields = input.fields;
  return {
    imei: input.imei,
    provider: "imei_info",
    service: input.service,
    status: input.status,
    model: fields?.model ?? null,
    modelName: fields?.modelName ?? null,
    manufacturer: fields?.manufacturer ?? null,
    blacklistStatusRaw: fields?.blacklistStatusRaw ?? null,
    generalListStatus: fields?.generalListStatus ?? null,
    blacklistRecords: fields?.blacklistRecords ?? null,
    deviceIsClean: fields?.deviceIsClean ?? null,
    providerCreatedAt: fields?.providerCreatedAt ?? null,
    fetchedAt: input.fetchedAt,
    rawReference: null,
    httpStatus: input.httpStatus ?? null,
    latencyMs: input.latencyMs,
    technicalReason: input.technicalReason ?? null,
    raw: input.raw ?? null,
  };
}

export async function imeiBlacklistCheckReal(input: {
  imeiCode: string;
  timeoutMs: number;
  serviceId: number | null;
}): Promise<ImeiBlacklistEvidence> {
  const started = Date.now();
  const fetchedAt = new Date(started).toISOString();
  const imei = normalizeImei(input.imeiCode);
  const validServiceId = Number.isSafeInteger(input.serviceId) && Number(input.serviceId) > 0
    ? input.serviceId
    : null;
  const service = validServiceId === null ? null : `blacklist:${validServiceId}`;

  if (!imei || !isValidImei(imei)) {
    return evidence({ imei, service, status: "INVALID", fetchedAt, latencyMs: Date.now() - started });
  }
  if (validServiceId === null) {
    return evidence({ imei, service, status: "UNAVAILABLE", fetchedAt, latencyMs: Date.now() - started, technicalReason: "MISSING_BLACKLIST_SERVICE_ID" });
  }
  const apiKey = process.env.IMEI_INFO_API_KEY?.trim();
  if (!apiKey) {
    return evidence({ imei, service, status: "UNAVAILABLE", fetchedAt, latencyMs: Date.now() - started, technicalReason: "MISSING_IMEI_INFO_API_KEY" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const url = new URL(`https://dash.imei.info/api-sync/check/${validServiceId}`);
    url.searchParams.set("API_KEY", apiKey);
    url.searchParams.set("imei", imei);
    const response = await fetch(url.toString(), { method: "GET", signal: controller.signal });
    let json: any;
    try {
      json = await response.json();
    } catch (error: any) {
      if (error?.name === "AbortError") throw error;
      return evidence({ imei, service, status: "UNAVAILABLE", fetchedAt, latencyMs: Date.now() - started, httpStatus: response.status, technicalReason: "INVALID_JSON" });
    }
    if (!response.ok) {
      return evidence({ imei, service, status: "UNAVAILABLE", fetchedAt, latencyMs: Date.now() - started, httpStatus: response.status, technicalReason: "HTTP_ERROR", raw: json });
    }
    if (!json || typeof json !== "object") {
      return evidence({ imei, service, status: "UNAVAILABLE", fetchedAt, latencyMs: Date.now() - started, httpStatus: response.status, technicalReason: "INVALID_JSON", raw: json });
    }
    if (json?.result === "Invalid IMEI") {
      return evidence({ imei, service, status: "INVALID", fetchedAt, latencyMs: Date.now() - started, httpStatus: response.status, raw: json });
    }
    const envelopeStatus = typeof json?.status === "string" ? json.status.trim().toUpperCase() : "";
    if (envelopeStatus && envelopeStatus !== "SUCCESSFUL") {
      return evidence({ imei, service, status: "UNAVAILABLE", fetchedAt, latencyMs: Date.now() - started, httpStatus: response.status, technicalReason: "PROVIDER_REJECTED", raw: json });
    }
    if (!json?.result || typeof json.result !== "object" || Array.isArray(json.result)) {
      return evidence({
        imei, service, status: "UNAVAILABLE", fetchedAt,
        latencyMs: Date.now() - started, httpStatus: response.status,
        technicalReason: json?.status === "Rejected" ? "PROVIDER_REJECTED" : "INVALID_PROVIDER_ENVELOPE",
        raw: json,
      });
    }
    const fields = normalizeBlacklistFields(json.result);
    const returnedImei = normalizeImei(fields.imeiNumber ?? "");
    const returnedImeiProvided = Object.prototype.hasOwnProperty.call(json.result, "imei_number") &&
      json.result.imei_number !== null && json.result.imei_number !== undefined && json.result.imei_number !== "";
    if (returnedImeiProvided && returnedImei !== imei) {
      return evidence({ imei, service, status: "UNAVAILABLE", fetchedAt, latencyMs: Date.now() - started, httpStatus: response.status, technicalReason: "RETURNED_IMEI_MISMATCH", fields, raw: json });
    }
    return evidence({ imei, service, status: classifyBlacklistStatus(fields), fetchedAt, latencyMs: Date.now() - started, httpStatus: response.status, fields, raw: json });
  } catch (error: any) {
    return evidence({
      imei, service, status: "UNAVAILABLE", fetchedAt, latencyMs: Date.now() - started,
      technicalReason: error?.name === "AbortError" ? "TIMEOUT" : "REQUEST_FAILED",
      raw: { error: error?.message ?? "IMEI_BLACKLIST_REQUEST_FAILED", errorName: error?.name ?? null },
    });
  } finally {
    clearTimeout(timeout);
  }
}
