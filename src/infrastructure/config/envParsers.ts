export class InvalidBooleanEnvironmentError extends Error {
  constructor(readonly variableName: string) {
    super(`${variableName} must be either true or false`);
    this.name = "InvalidBooleanEnvironmentError";
  }
}

export function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new InvalidBooleanEnvironmentError(name);
}

export type EnrichmentMode = "off" | "mock" | "real";

export function resolveEnrichmentMode(raw = process.env.ENRICHMENT_MODE): EnrichmentMode {
  if (raw === undefined || raw.trim() === "") return "mock";

  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "mock" || normalized === "real") {
    return normalized;
  }
  throw new Error("ENRICHMENT_MODE must be one of: off, mock, real");
}
