import type { CacheV2ShadowTelemetry } from "../../application/ports";

export const consoleCacheV2ShadowTelemetry: CacheV2ShadowTelemetry = {
  record(event) {
    console.log("[cache-v2-shadow]", event);
  },
};
