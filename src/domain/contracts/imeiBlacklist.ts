export type ImeiBlacklistStatus =
  | "CLEAN"
  | "BLACKLISTED"
  | "UNKNOWN"
  | "UNAVAILABLE"
  | "INVALID";

export type ImeiBlacklistEvidence = {
  imei: string;
  provider: "imei_info";
  service: string | null;
  status: ImeiBlacklistStatus;
  model: string | null;
  modelName: string | null;
  manufacturer: string | null;
  blacklistStatusRaw: string | null;
  generalListStatus: string | null;
  blacklistRecords: number | null;
  deviceIsClean: boolean | null;
  providerCreatedAt: string | null;
  fetchedAt: string;
  rawReference: string | null;
  httpStatus: number | null;
  latencyMs: number;
  technicalReason?: string | null;
  raw?: unknown;
};

export type ImeiBlacklistProviderFields = Pick<
  ImeiBlacklistEvidence,
  | "model"
  | "modelName"
  | "manufacturer"
  | "blacklistStatusRaw"
  | "generalListStatus"
  | "blacklistRecords"
  | "deviceIsClean"
  | "providerCreatedAt"
> & { imeiNumber: string | null };
