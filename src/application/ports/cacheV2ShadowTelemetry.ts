export type CacheV2ShadowEvent = {
  name:
    | "cache_v2_techtrail_write_success"
    | "cache_v2_techtrail_write_error"
    | "cache_v2_techtrail_write_skipped"
    | "cache_v2_imei_write_success"
    | "cache_v2_imei_write_error"
    | "cache_v2_imei_write_skipped"
    | "cache_v2_replay_write_success"
    | "cache_v2_replay_write_error"
    | "cache_v2_replay_write_skipped"
    | "cache_v2_replay_write_skipped_technical_failure"
    | "cache_v2_replay_read_hit"
    | "cache_v2_replay_read_miss"
    | "cache_v2_replay_read_expired"
    | "cache_v2_replay_read_incompatible"
    | "cache_v2_replay_read_backend_error"
    | "cache_v2_replay_read_bypass"
    | "cache_v2_techtrail_read_hit"
    | "cache_v2_techtrail_read_miss"
    | "cache_v2_techtrail_read_expired"
    | "cache_v2_techtrail_read_incompatible"
    | "cache_v2_techtrail_read_backend_error"
    | "cache_v2_techtrail_read_bypass"
    | "cache_v2_imei_read_hit"
    | "cache_v2_imei_read_miss"
    | "cache_v2_imei_read_expired"
    | "cache_v2_imei_read_incompatible"
    | "cache_v2_imei_read_backend_error"
    | "cache_v2_imei_read_bypass"
    | "IMEI_BLACKLIST_CACHE_HIT"
    | "IMEI_BLACKLIST_CACHE_MISS"
    | "IMEI_BLACKLIST_CLEAN"
    | "IMEI_BLACKLISTED"
    | "IMEI_BLACKLIST_UNKNOWN"
    | "IMEI_BLACKLIST_UNAVAILABLE"
    | "IMEI_BLACKLIST_INVALID"
    | "IMEI_BLACKLIST_SKIPPED_PROFILE_A"
    | "IMEI_BLACKLIST_SKIPPED_PROFILE_C"
    | "IMEI_BLACKLIST_SKIPPED_HARD_BLOCK"
    | "IMEI_BLACKLIST_SKIPPED_NO_IMEI"
    | "cache_v2_configuration_error";
  traceId: string;
  reason?: string;
  details?: Record<string, unknown>;
};

export interface CacheV2ShadowTelemetry {
  record(event: CacheV2ShadowEvent): void;
}
