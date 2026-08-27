export type ImeiReason =
  | "IMEI_OK"
  | "IMEI_INVALID"
  | "IMEI_FAIL"
  | "IMEI_BRAND_MISMATCH";

export type ImeiBrand = "SAMSUNG" | "APPLE" | "XIAOMI" | "UNKNOWN";

export type NormalizedImeiSummary = {
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

export type NormalizedImeiResult = {
  ok: boolean;
  provider: "imei_info";
  ms: number;
  httpStatus?: number | null;
  timedOut?: boolean;
  reason: ImeiReason;
  brandExpected?: ImeiBrand;
  brandReturned?: string | null;
  serviceId?: number | null;
  summary?: NormalizedImeiSummary | null;
  raw?: unknown;
};
