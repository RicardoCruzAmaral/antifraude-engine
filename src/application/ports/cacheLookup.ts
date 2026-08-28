export type CacheLookup<T> =
  | { state: "HIT"; value: T; ageMs: number }
  | { state: "MISS" }
  | { state: "EXPIRED"; expiredAt: string }
  | { state: "INCOMPATIBLE"; reason: string }
  | { state: "BACKEND_ERROR"; errorCode: string };

export type EvidenceCompleteness = "COMPLETE" | "PARTIAL";

export type EvidenceVersions = {
  providerContractVersion: string;
  normalizerVersion: string;
  cacheSchemaVersion: string;
};
