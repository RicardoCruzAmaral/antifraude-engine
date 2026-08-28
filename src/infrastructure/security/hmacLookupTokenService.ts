import crypto from "crypto";
import type { LookupTokenService } from "../../application/ports";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

function normalizeDigits(value: string) {
  return String(value ?? "").replace(/\D/g, "");
}

export function createHmacLookupTokenService(secret: string): LookupTokenService {
  if (!secret) throw new Error("Missing EVIDENCE_LOOKUP_HMAC_KEY");

  const token = (namespace: string, value: string) =>
    crypto.createHmac("sha256", secret).update(`${namespace}:${value}`).digest("hex");

  return {
    tokenizeCpf: (cpf) => token("cpf", normalizeDigits(cpf)),
    tokenizeImei: (imei) => token("imei", normalizeDigits(imei)),
    hashRelevantInput: (input) => token("analysis-input", canonicalize(input)),
  };
}

export function createHmacLookupTokenServiceFromEnv(): LookupTokenService {
  return createHmacLookupTokenService(process.env.EVIDENCE_LOOKUP_HMAC_KEY ?? "");
}
