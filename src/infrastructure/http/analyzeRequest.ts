import crypto from "crypto";

const ROOT_STRING_LIMITS = {
  cep: 16,
  nome: 200,
  email: 254,
  imeiCode: 32,
  sessionId: 128,
  proposalId: 128,
  partnerCode: 64,
  salesChannel: 64,
  modelo_declarado: 200,
  telefone_contato: 32,
} as const;

const DEVICE_STRING_LIMITS = {
  ip: 64,
  visitorId: 256,
  requestId: 256,
  os: 128,
  gpu: 512,
  osVersion: 128,
  browserName: 128,
  fingerprintProvider: 128,
  collectedAt: 64,
} as const;

const ROOT_FIELDS = new Set([
  "cep", "cpf", "nome", "email", "device", "imeiCode", "sessionId",
  "proposalId", "partnerCode", "salesChannel", "valor_celular",
  "modelo_declarado", "telefone_contato",
]);

const DEVICE_FIELDS = new Set([
  ...Object.keys(DEVICE_STRING_LIMITS),
  "cores", "isMobile", "incognito", "screenWidthPhysical", "screenHeightPhysical",
]);

export type AnalyzeRequestValidationDetail = {
  field: string;
  issue: string;
};

export type AnalyzeRequestValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; details: AnalyzeRequestValidationDetail[] };

export type AnalyzeAuthenticationResult =
  | { state: "AUTHORIZED" }
  | { state: "UNAUTHORIZED" }
  | { state: "SERVER_MISCONFIGURED" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function timingSafeSecretEqual(provided: string, expected: string) {
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (providedBytes.length !== expectedBytes.length) return false;
  return crypto.timingSafeEqual(providedBytes, expectedBytes);
}

export function authenticateAnalyzeRequest(
  authorizationHeader: string | string[] | undefined,
  configuredSecret: string | undefined
): AnalyzeAuthenticationResult {
  if (!configuredSecret || !configuredSecret.trim()) {
    return { state: "SERVER_MISCONFIGURED" };
  }
  if (typeof authorizationHeader !== "string") return { state: "UNAUTHORIZED" };
  const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader);
  if (!match || !timingSafeSecretEqual(match[1], configuredSecret)) {
    return { state: "UNAUTHORIZED" };
  }
  return { state: "AUTHORIZED" };
}

function addNullableString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  field: string,
  maxLength: number,
  details: AnalyzeRequestValidationDetail[],
  path = field
) {
  const value = source[field];
  if (value === undefined) return;
  if (value === null) {
    target[field] = null;
    return;
  }
  if (typeof value !== "string") {
    details.push({ field: path, issue: "must be a string or null" });
    return;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    details.push({ field: path, issue: `must contain at most ${maxLength} characters` });
    return;
  }
  target[field] = normalized || null;
}

function normalizeDevice(
  value: unknown,
  details: AnalyzeRequestValidationDetail[]
): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainObject(value)) {
    details.push({ field: "device", issue: "must be an object or null" });
    return undefined;
  }
  if (Object.keys(value).some((field) => !DEVICE_FIELDS.has(field))) {
    details.push({ field: "device", issue: "contains unsupported fields" });
  }

  const normalized: Record<string, unknown> = {};
  for (const [field, limit] of Object.entries(DEVICE_STRING_LIMITS)) {
    addNullableString(value, normalized, field, limit, details, `device.${field}`);
  }

  const cores = value.cores;
  if (cores !== undefined) {
    if (cores === null) normalized.cores = null;
    else if (typeof cores !== "number" || !Number.isFinite(cores) || !Number.isInteger(cores) || cores < 0) {
      details.push({ field: "device.cores", issue: "must be a non-negative finite integer or null" });
    } else normalized.cores = cores;
  }

  for (const field of ["isMobile", "incognito"] as const) {
    const booleanValue = value[field];
    if (booleanValue === undefined) continue;
    if (booleanValue === null || typeof booleanValue === "boolean") normalized[field] = booleanValue;
    else details.push({ field: `device.${field}`, issue: "must be a boolean or null" });
  }

  for (const field of ["screenWidthPhysical", "screenHeightPhysical"] as const) {
    const dimension = value[field];
    if (dimension === undefined) continue;
    if (dimension === null) normalized[field] = null;
    else if (typeof dimension !== "number" || !Number.isFinite(dimension) || dimension < 0) {
      details.push({ field: `device.${field}`, issue: "must be a non-negative finite number or null" });
    } else normalized[field] = dimension;
  }
  return normalized;
}

export function validateAnalyzeRequest(body: unknown): AnalyzeRequestValidationResult {
  const details: AnalyzeRequestValidationDetail[] = [];
  if (!isPlainObject(body)) {
    return { ok: false, details: [{ field: "body", issue: "must be a JSON object" }] };
  }
  if (Object.keys(body).some((field) => !ROOT_FIELDS.has(field))) {
    details.push({ field: "body", issue: "contains unsupported fields" });
  }

  const normalized: Record<string, unknown> = {};
  const cpf = body.cpf;
  if (typeof cpf !== "string") {
    details.push({ field: "cpf", issue: "is required and must be a string" });
  } else {
    const trimmedCpf = cpf.trim();
    if (!/^\d{11}$/.test(trimmedCpf) && !/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(trimmedCpf)) {
      details.push({ field: "cpf", issue: "must contain 11 digits, with optional standard punctuation" });
    } else {
      normalized.cpf = trimmedCpf.replace(/\D/g, "");
    }
  }

  for (const [field, limit] of Object.entries(ROOT_STRING_LIMITS)) {
    addNullableString(body, normalized, field, limit, details);
  }

  const amount = body.valor_celular;
  if (amount !== undefined) {
    if (amount === null) normalized.valor_celular = null;
    else if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      details.push({ field: "valor_celular", issue: "must be a non-negative finite number or null" });
    } else normalized.valor_celular = amount;
  }

  const device = normalizeDevice(body.device, details);
  if (device !== undefined) normalized.device = device;

  return details.length ? { ok: false, details } : { ok: true, value: normalized };
}
