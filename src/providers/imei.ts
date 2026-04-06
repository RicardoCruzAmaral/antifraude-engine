type SupportedBrand = "SAMSUNG" | "APPLE" | "XIAOMI" | "UNKNOWN";

export type ImeiSummary = {
  brand: string | null;
  model_name: string | null;
  model_code: string | null;
  serial_number: string | null;
  imei_checked: string | null;
  warranty_status: string | null;
  purchase_country: string | null;
  activation_status: string | null;
  carrier_status: string | null;
  lock_status: string | null;
  anti_theft_status: string | null;
};

export type ImeiCheckResult = {
  ok: boolean;
  provider: "imei_info";
  ms: number;
  httpStatus?: number | null;
  timedOut?: boolean;
  reason: "IMEI_OK" | "IMEI_INVALID" | "IMEI_FAIL" | "IMEI_BRAND_MISMATCH";
  brandExpected?: SupportedBrand;
  brandReturned?: string | null;
  serviceId?: number | null;
  summary?: ImeiSummary | null;
  raw?: any;
};

function normalizeText(s: any): string {
  if (!s) return "";
  return String(s)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function onlyDigits(s: any): string {
  return String(s || "").replace(/\D/g, "");
}

function inferBrand(modeloDeclarado: string | null | undefined): SupportedBrand {
  const m = normalizeText(modeloDeclarado);

  if (!m) return "UNKNOWN";
  if (m.includes("IPHONE") || m.includes("APPLE")) return "APPLE";
  if (m.includes("SAMSUNG") || m.includes("GALAXY")) return "SAMSUNG";
  if (m.includes("XIAOMI") || m.includes("REDMI") || m.includes("POCO")) return "XIAOMI";

  return "UNKNOWN";
}

function normalizeReturnedBrand(rawResult: any): string | null {
  const manufacturer = normalizeText(rawResult?.manufacturer);
  const fullName = normalizeText(rawResult?.full_name);
  const modelName = normalizeText(rawResult?.model_name);

  const appleModel = normalizeText(rawResult?.model_name);
  const appleDetails = normalizeText(rawResult?.model_details);

  const xiaomiModel = normalizeText(rawResult?.["Model Name"]);
  const xiaomiCode = normalizeText(rawResult?.["Model Code"]);

  if (
    manufacturer.includes("SAMSUNG") ||
    fullName.includes("SAMSUNG") ||
    modelName.includes("GALAXY")
  ) {
    return "SAMSUNG";
  }

  if (
    manufacturer.includes("APPLE") ||
    fullName.includes("IPHONE") ||
    modelName.includes("IPHONE") ||
    appleModel.includes("IPHONE") ||
    appleDetails.includes("IPHONE")
  ) {
    return "APPLE";
  }

  if (
    manufacturer.includes("XIAOMI") ||
    fullName.includes("XIAOMI") ||
    fullName.includes("REDMI") ||
    fullName.includes("POCO") ||
    modelName.includes("XIAOMI") ||
    modelName.includes("REDMI") ||
    modelName.includes("POCO") ||
    xiaomiModel.includes("XIAOMI") ||
    xiaomiModel.includes("REDMI") ||
    xiaomiModel.includes("POCO") ||
    xiaomiCode.includes("XIAOMI")
  ) {
    return "XIAOMI";
  }

  return null;
}

function isValidImei(imei: string): boolean {
  const clean = onlyDigits(imei);
  if (clean.length !== 15) return false;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let digit = Number(clean[i]);

    // Luhn para IMEI: dobra posições pares considerando índice 1-based
    if ((i + 1) % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === Number(clean[14]);
}

function getServiceIdByBrand(brand: SupportedBrand): number | null {
  const samsung = Number(process.env.IMEI_INFO_SERVICE_ID_SAMSUNG || 76);
  const apple = Number(process.env.IMEI_INFO_SERVICE_ID_APPLE || 19);
  const xiaomi = Number(process.env.IMEI_INFO_SERVICE_ID_XIAOMI || 84);

  if (brand === "SAMSUNG") return samsung || null;
  if (brand === "APPLE") return apple || null;
  if (brand === "XIAOMI") return xiaomi || null;

  return null;
}

function buildImeiSummary(rawResult: any, brandReturned: string | null): ImeiSummary | null {
  if (!rawResult || typeof rawResult !== "object") return null;

  if (brandReturned === "SAMSUNG") {
    return {
      brand: "SAMSUNG",
      model_name: rawResult?.model_name ?? null,
      model_code: rawResult?.model_number ?? null,
      serial_number: rawResult?.serial_number ?? null,
      imei_checked: rawResult?.imei1 ?? null,
      warranty_status: rawResult?.warranty_status ?? null,
      purchase_country: rawResult?.sold_by_country ?? null,
      activation_status: null,
      carrier_status: rawResult?.carrier ?? null,
      lock_status: null,
      anti_theft_status: rawResult?.knox_guard ?? null,
    };
  }

  if (brandReturned === "APPLE") {
    const unlocked =
      rawResult?.device_is_unlocked === true
        ? "UNLOCKED"
        : rawResult?.device_is_unlocked === false
        ? "LOCKED"
        : null;

    return {
      brand: "APPLE",
      model_name: rawResult?.model_name ?? null,
      model_code: rawResult?.model_details ?? null,
      serial_number: rawResult?.serial_number ?? null,
      imei_checked: rawResult?.imei_number ?? null,
      warranty_status: rawResult?.warranty_status ?? null,
      purchase_country: rawResult?.purchase_country ?? null,
      activation_status: rawResult?.activation_status ?? null,
      carrier_status: rawResult?.sim_lock_status ?? rawResult?.locked_carrier ?? null,
      lock_status: unlocked,
      anti_theft_status: rawResult?.icloud_lock ?? null,
    };
  }

  if (brandReturned === "XIAOMI") {
    return {
      brand: "XIAOMI",
      model_name: rawResult?.["Model Name"] ?? null,
      model_code: rawResult?.["Model Code"] ?? null,
      serial_number: rawResult?.["Serial Number"] ?? null,
      imei_checked: rawResult?.["IMEI Number"] ?? null,
      warranty_status: rawResult?.["Warranty Status"] ?? null,
      purchase_country: rawResult?.["Purchase Country"] ?? null,
      activation_status: rawResult?.["Activation Date"] ?? null,
      carrier_status: null,
      lock_status: null,
      anti_theft_status: rawResult?.["MI Activation Lock"] ?? null,
    };
  }

  // fallback genérico caso a marca não seja inferida com precisão
  return {
    brand: brandReturned,
    model_name:
      rawResult?.model_name ??
      rawResult?.["Model Name"] ??
      null,
    model_code:
      rawResult?.model_number ??
      rawResult?.model_details ??
      rawResult?.["Model Code"] ??
      null,
    serial_number:
      rawResult?.serial_number ??
      rawResult?.["Serial Number"] ??
      null,
    imei_checked:
      rawResult?.imei1 ??
      rawResult?.imei_number ??
      rawResult?.["IMEI Number"] ??
      null,
    warranty_status:
      rawResult?.warranty_status ??
      rawResult?.["Warranty Status"] ??
      null,
    purchase_country:
      rawResult?.sold_by_country ??
      rawResult?.purchase_country ??
      rawResult?.["Purchase Country"] ??
      null,
    activation_status:
      rawResult?.activation_status ??
      rawResult?.["Activation Date"] ??
      null,
    carrier_status:
      rawResult?.carrier ??
      rawResult?.sim_lock_status ??
      null,
    lock_status:
      rawResult?.device_is_unlocked === true
        ? "UNLOCKED"
        : rawResult?.device_is_unlocked === false
        ? "LOCKED"
        : null,
    anti_theft_status:
      rawResult?.knox_guard ??
      rawResult?.icloud_lock ??
      rawResult?.["MI Activation Lock"] ??
      null,
  };
}

export async function imeiCheckReal(input: {
  imeiCode: string;
  modeloDeclarado?: string | null;
  timeoutMs: number;
}): Promise<ImeiCheckResult> {
  const started = Date.now();
  const imei = onlyDigits(input.imeiCode);
  const brandExpected = inferBrand(input.modeloDeclarado);

  if (!imei || !isValidImei(imei)) {
    return {
      ok: false,
      provider: "imei_info",
      ms: Date.now() - started,
      reason: "IMEI_INVALID",
      brandExpected,
      brandReturned: null,
      serviceId: null,
      summary: null,
      raw: null,
    };
  }

  const serviceId = getServiceIdByBrand(brandExpected);
  if (!serviceId) {
    return {
      ok: false,
      provider: "imei_info",
      ms: Date.now() - started,
      reason: "IMEI_FAIL",
      brandExpected,
      brandReturned: null,
      serviceId: null,
      summary: null,
      raw: { error: "MISSING_SERVICE_ID_FOR_BRAND" },
    };
  }

  const apiKey = process.env.IMEI_INFO_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      provider: "imei_info",
      ms: Date.now() - started,
      reason: "IMEI_FAIL",
      brandExpected,
      brandReturned: null,
      serviceId,
      summary: null,
      raw: { error: "MISSING_IMEI_INFO_API_KEY" },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const url = new URL(`https://dash.imei.info/api-sync/check/${serviceId}`);
    url.searchParams.set("API_KEY", apiKey);
    url.searchParams.set("imei", imei);

    const resp = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
    });

    const json = await resp.json().catch(() => null);
    const status = json?.status;
    const result = json?.result;

    if (!resp.ok) {
      return {
        ok: false,
        provider: "imei_info",
        ms: Date.now() - started,
        httpStatus: resp.status,
        reason: "IMEI_FAIL",
        brandExpected,
        brandReturned: null,
        serviceId,
        summary: null,
        raw: json,
      };
    }

    if (status === "Rejected" || result === "Invalid IMEI") {
      return {
        ok: false,
        provider: "imei_info",
        ms: Date.now() - started,
        httpStatus: resp.status,
        reason: "IMEI_INVALID",
        brandExpected,
        brandReturned: null,
        serviceId,
        summary: null,
        raw: json,
      };
    }

    const rawResult = result ?? null;
    const brandReturned = normalizeReturnedBrand(rawResult);
    const summary = buildImeiSummary(rawResult, brandReturned);

    if (brandExpected !== "UNKNOWN" && brandReturned && brandExpected !== brandReturned) {
      return {
        ok: false,
        provider: "imei_info",
        ms: Date.now() - started,
        httpStatus: resp.status,
        reason: "IMEI_BRAND_MISMATCH",
        brandExpected,
        brandReturned,
        serviceId,
        summary,
        raw: json,
      };
    }

    return {
      ok: true,
      provider: "imei_info",
      ms: Date.now() - started,
      httpStatus: resp.status,
      reason: "IMEI_OK",
      brandExpected,
      brandReturned,
      serviceId,
      summary,
      raw: json,
    };
  } catch (err: any) {
    return {
      ok: false,
      provider: "imei_info",
      ms: Date.now() - started,
      timedOut: err?.name === "AbortError",
      reason: "IMEI_FAIL",
      brandExpected,
      brandReturned: null,
      serviceId,
      summary: null,
      raw: {
        error: err?.message ?? "IMEI_REQUEST_FAILED",
        errorName: err?.name ?? null,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}