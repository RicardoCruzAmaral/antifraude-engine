import type {
  ImeiBlacklistEvidence,
  ImeiBlacklistProviderFields,
  ImeiBlacklistStatus,
} from "../domain/contracts";
import { classifyImeiBlacklistStatus } from "../domain/engine";
import { isValidImei, normalizeImei } from "./imei";

export type SupportedBlacklistResult = ImeiBlacklistProviderFields;

const POLL_INTERVAL_MS = 250;

const FINAL_STATUSES = new Set(["DONE", "SUCCESSFUL", "SUCCESS", "COMPLETE", "COMPLETED"]);
const PENDING_STATUSES = new Set(["IN_PROGRESS", "INPROGRESS", "PROCESSING", "PENDING", "QUEUED", "ACCEPTED"]);

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

function normalizedEnvelopeStatus(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toUpperCase().replace(/[\s-]+/g, "_")
    : "";
}

function searchIdFromEnvelope(raw: any): string | null {
  for (const value of [raw?.history_id, raw?.id, raw?.ulid]) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed;
    }
  }
  return null;
}

function searchRawReference(searchId: string | null): string | null {
  return searchId ? `imei-info-search:${searchId}` : null;
}

function abortError(): Error {
  return Object.assign(new Error("IMEI_BLACKLIST_ABORTED"), { name: "AbortError" });
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, POLL_INTERVAL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  rawReference?: string | null;
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
    rawReference: input.rawReference ?? null,
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
  let searchId: string | null = null;
  let pendingSeen = false;
  let phase: "SUBMIT" | "POLL" = "SUBMIT";
  let lastRaw: unknown = null;
  try {
    while (true) {
      const url = phase === "SUBMIT"
        ? new URL(`https://dash.imei.info/api-sync/check/${validServiceId}`)
        : new URL(`https://dash.imei.info/api/search_history/${encodeURIComponent(searchId!)}/`);
      url.searchParams.set("API_KEY", apiKey);
      if (phase === "SUBMIT") url.searchParams.set("imei", imei);

      const response = await fetch(url.toString(), { method: "GET", signal: controller.signal });
      let json: any;
      try {
        json = await response.json();
      } catch (error: any) {
        if (error?.name === "AbortError") throw error;
        return evidence({
          imei, service, status: "UNAVAILABLE", fetchedAt,
          latencyMs: Date.now() - started, httpStatus: response.status,
          technicalReason: "INVALID_JSON", rawReference: searchRawReference(searchId),
        });
      }
      lastRaw = json;
      if (!response.ok) {
        return evidence({
          imei, service, status: "UNAVAILABLE", fetchedAt,
          latencyMs: Date.now() - started, httpStatus: response.status,
          technicalReason: "HTTP_ERROR", rawReference: searchRawReference(searchId), raw: json,
        });
      }
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        return evidence({
          imei, service, status: "UNAVAILABLE", fetchedAt,
          latencyMs: Date.now() - started, httpStatus: response.status,
          technicalReason: "INVALID_JSON", rawReference: searchRawReference(searchId), raw: json,
        });
      }

      searchId = searchId ?? searchIdFromEnvelope(json);
      const rawReference = searchRawReference(searchId);
      if (json.result === "Invalid IMEI") {
        return evidence({
          imei, service, status: "INVALID", fetchedAt,
          latencyMs: Date.now() - started, httpStatus: response.status,
          rawReference, raw: json,
        });
      }

      const envelopeStatus = normalizedEnvelopeStatus(json.status);
      if (envelopeStatus === "REJECTED") {
        return evidence({
          imei, service, status: "UNAVAILABLE", fetchedAt,
          latencyMs: Date.now() - started, httpStatus: response.status,
          technicalReason: "PROVIDER_REJECTED", rawReference, raw: json,
        });
      }
      if (envelopeStatus === "REFUNDED") {
        return evidence({
          imei, service, status: "UNAVAILABLE", fetchedAt,
          latencyMs: Date.now() - started, httpStatus: response.status,
          technicalReason: "PROVIDER_REFUNDED", rawReference, raw: json,
        });
      }

      const resultIsObject = !!json.result && typeof json.result === "object" && !Array.isArray(json.result);
      const pending = response.status === 202 || PENDING_STATUSES.has(envelopeStatus);
      const final = FINAL_STATUSES.has(envelopeStatus) || (!envelopeStatus && response.status === 200 && resultIsObject);

      if (final) {
        if (!resultIsObject) {
          return evidence({
            imei, service, status: "UNAVAILABLE", fetchedAt,
            latencyMs: Date.now() - started, httpStatus: response.status,
            technicalReason: "INVALID_PROVIDER_ENVELOPE", rawReference, raw: json,
          });
        }
        const fields = normalizeBlacklistFields(json.result);
        const returnedImei = normalizeImei(fields.imeiNumber ?? "");
        const returnedImeiProvided = Object.prototype.hasOwnProperty.call(json.result, "imei_number") &&
          json.result.imei_number !== null && json.result.imei_number !== undefined && json.result.imei_number !== "";
        if (returnedImeiProvided && returnedImei !== imei) {
          return evidence({
            imei, service, status: "UNAVAILABLE", fetchedAt,
            latencyMs: Date.now() - started, httpStatus: response.status,
            technicalReason: "RETURNED_IMEI_MISMATCH", rawReference, fields, raw: json,
          });
        }
        return evidence({
          imei, service, status: classifyBlacklistStatus(fields), fetchedAt,
          latencyMs: Date.now() - started, httpStatus: response.status,
          rawReference, fields, raw: json,
        });
      }

      if (!pending) {
        return evidence({
          imei, service, status: "UNAVAILABLE", fetchedAt,
          latencyMs: Date.now() - started, httpStatus: response.status,
          technicalReason: "INVALID_PROVIDER_ENVELOPE", rawReference, raw: json,
        });
      }
      if (!searchId) {
        return evidence({
          imei, service, status: "UNAVAILABLE", fetchedAt,
          latencyMs: Date.now() - started, httpStatus: response.status,
          technicalReason: "PENDING_WITHOUT_SEARCH_ID", raw: json,
        });
      }

      pendingSeen = true;
      phase = "POLL";
      await waitForNextPoll(controller.signal);
    }
  } catch (error: any) {
    return evidence({
      imei, service, status: "UNAVAILABLE", fetchedAt, latencyMs: Date.now() - started,
      technicalReason: error?.name === "AbortError"
        ? pendingSeen ? "PENDING_TIMEOUT" : "TIMEOUT"
        : phase === "POLL" ? "POLL_REQUEST_FAILED" : "REQUEST_FAILED",
      rawReference: searchRawReference(searchId),
      raw: pendingSeen
        ? lastRaw
        : { error: error?.message ?? "IMEI_BLACKLIST_REQUEST_FAILED", errorName: error?.name ?? null },
    });
  } finally {
    clearTimeout(timeout);
  }
}
