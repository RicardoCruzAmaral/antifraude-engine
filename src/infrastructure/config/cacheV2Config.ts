export type CacheV2Config = {
  analysisReplayEnabled: boolean;
  writeEnabled: boolean;
  readTechTrailEnabled: boolean;
  readImeiEnabled: boolean;
  decisionCacheV1ReadEnabled: boolean;
  techTrailTtlDays: number;
  imeiTtlDays: number;
  replayTtlDays: number | null;
};

function envBool(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

function optionalPositiveInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function resolveCacheV2Config(): CacheV2Config {
  return {
    analysisReplayEnabled: envBool("ANALYSIS_REPLAY_ENABLED", false),
    writeEnabled: envBool("CACHE_V2_WRITE_ENABLED", false),
    readTechTrailEnabled: envBool("CACHE_V2_READ_TECHTRAIL_ENABLED", false),
    readImeiEnabled: envBool("CACHE_V2_READ_IMEI_ENABLED", false),
    decisionCacheV1ReadEnabled: envBool("DECISION_CACHE_V1_READ_ENABLED", true),
    techTrailTtlDays: optionalPositiveInt("TECHTRAIL_CACHE_TTL_DAYS") ?? 30,
    imeiTtlDays: optionalPositiveInt("IMEI_CACHE_TTL_DAYS") ?? 30,
    replayTtlDays: optionalPositiveInt("ANALYSIS_REPLAY_TTL_DAYS"),
  };
}

export function evidenceExpiresAt(fetchedAt: string, ttlDays: number): string {
  const date = new Date(fetchedAt);
  date.setUTCDate(date.getUTCDate() + ttlDays);
  return date.toISOString();
}
