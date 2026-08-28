import type {
  AnalysisReplayEntry,
  AnalysisReplayRepository,
  AnalysisReplayResult,
  CacheV2ShadowEvent,
  CacheV2ShadowTelemetry,
  LookupTokenService,
} from "../ports";
import type { InputSummary } from "../../domain/contracts";
import { buildReplayInput } from "./replayInput";

export type AnalysisPolicyVersion =
  | "score-v1|imei-legacy-v1"
  | "score-v1|imei-blacklist-v1";

export type AnalysisReplayReadDependencies = {
  analysisReplayRepository: AnalysisReplayRepository | null;
  lookupTokenService: LookupTokenService | null;
  telemetry: CacheV2ShadowTelemetry;
  cacheSchemaVersion: string;
};

export type AnalysisReplayReadResult =
  | { state: "HIT"; entry: AnalysisReplayEntry; result: AnalysisReplayResult }
  | { state: "FALLBACK"; cacheState: string };

export function resolveAnalysisPolicyVersion(
  imeiBlacklistV1Enabled: boolean
): AnalysisPolicyVersion {
  return imeiBlacklistV1Enabled
    ? "score-v1|imei-blacklist-v1"
    : "score-v1|imei-legacy-v1";
}

function record(
  dependencies: AnalysisReplayReadDependencies,
  event: CacheV2ShadowEvent
) {
  try {
    dependencies.telemetry.record(event);
  } catch (error) {
    console.error("[analysis-replay-read] telemetry failed", error);
  }
}

function validHit(
  entry: AnalysisReplayEntry,
  expected: {
    proposalId: string | null;
    inputHash: string;
    analysisPolicyVersion: AnalysisPolicyVersion;
    cacheSchemaVersion: string;
  }
) {
  const createdAt = Date.parse(entry.createdAt);
  const expiresAt = Date.parse(entry.expiresAt);
  const statusCode = entry.result?.statusCode;
  return entry.proposalId === expected.proposalId &&
    entry.inputHash === expected.inputHash &&
    entry.analysisPolicyVersion === expected.analysisPolicyVersion &&
    entry.cacheSchemaVersion === expected.cacheSchemaVersion &&
    Number.isFinite(createdAt) &&
    Number.isFinite(expiresAt) &&
    createdAt <= Date.now() &&
    expiresAt > createdAt &&
    expiresAt > Date.now() &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599;
}

export async function readAnalysisReplay(
  dependencies: AnalysisReplayReadDependencies,
  input: {
    traceId: string;
    inputSummary: InputSummary;
    analysisPolicyVersion: AnalysisPolicyVersion;
  }
): Promise<AnalysisReplayReadResult> {
  if (!dependencies.lookupTokenService || !dependencies.analysisReplayRepository) {
    record(dependencies, {
      name: "cache_v2_replay_read_bypass",
      traceId: input.traceId,
      reason: "DEPENDENCY_UNAVAILABLE",
    });
    return { state: "FALLBACK", cacheState: "BYPASS" };
  }

  try {
    const inputHash = dependencies.lookupTokenService.hashRelevantInput(
      buildReplayInput(input.inputSummary)
    );
    const key = {
      proposalId: input.inputSummary.proposalId,
      inputHash,
      analysisPolicyVersion: input.analysisPolicyVersion,
      cacheSchemaVersion: dependencies.cacheSchemaVersion,
    };
    const lookup = await dependencies.analysisReplayRepository.get(key);
    if (lookup.state === "HIT") {
      if (!validHit(lookup.value, key)) {
        record(dependencies, {
          name: "cache_v2_replay_read_incompatible",
          traceId: input.traceId,
          reason: "HIT_VALIDATION_FAILED",
        });
        return { state: "FALLBACK", cacheState: "INCOMPATIBLE" };
      }
      record(dependencies, {
        name: "cache_v2_replay_read_hit",
        traceId: input.traceId,
        details: {
          ageMs: lookup.ageMs,
          proposalIdPresent: input.inputSummary.proposalId !== null,
          analysisPolicyVersion: input.analysisPolicyVersion,
        },
      });
      return { state: "HIT", entry: lookup.value, result: lookup.value.result };
    }

    const eventNames: Record<"MISS" | "EXPIRED" | "INCOMPATIBLE" | "BACKEND_ERROR", CacheV2ShadowEvent["name"]> = {
      MISS: "cache_v2_replay_read_miss",
      EXPIRED: "cache_v2_replay_read_expired",
      INCOMPATIBLE: "cache_v2_replay_read_incompatible",
      BACKEND_ERROR: "cache_v2_replay_read_backend_error",
    };
    const eventName = eventNames[lookup.state];
    record(dependencies, {
      name: eventName,
      traceId: input.traceId,
      reason: lookup.state === "INCOMPATIBLE"
        ? lookup.reason
        : lookup.state === "BACKEND_ERROR"
          ? lookup.errorCode
          : lookup.state,
    });
    return { state: "FALLBACK", cacheState: lookup.state };
  } catch (error) {
    console.error("[analysis-replay-read] lookup failed", error);
    record(dependencies, {
      name: "cache_v2_replay_read_backend_error",
      traceId: input.traceId,
      reason: "LOOKUP_FAILED",
    });
    return { state: "FALLBACK", cacheState: "BACKEND_ERROR" };
  }
}
