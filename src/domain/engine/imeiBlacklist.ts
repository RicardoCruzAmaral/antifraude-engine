import type {
  ImeiBlacklistProviderFields,
  ImeiBlacklistStatus,
} from "../contracts";

function normalized(value: string | null) {
  return value?.trim().toUpperCase() ?? "";
}

export function classifyImeiBlacklistStatus(
  fields: ImeiBlacklistProviderFields
): Extract<ImeiBlacklistStatus, "CLEAN" | "BLACKLISTED" | "UNKNOWN"> {
  const status = normalized(fields.blacklistStatusRaw);
  const general = normalized(fields.generalListStatus);
  const clean = status === "CLEAN" &&
    fields.blacklistRecords === 0 &&
    fields.deviceIsClean === true &&
    general === "NO";
  const explicitBlack = status === "BLACKLISTED" ||
    status === "BLACKLIST" ||
    (fields.blacklistRecords !== null && fields.blacklistRecords > 0) ||
    general === "YES";
  const contradictoryCleanSignal = status === "CLEAN" ||
    fields.blacklistRecords === 0 ||
    fields.deviceIsClean === true ||
    general === "NO";

  if (clean && !explicitBlack) return "CLEAN";
  if (explicitBlack && !contradictoryCleanSignal) return "BLACKLISTED";
  return "UNKNOWN";
}

export function isConsistentImeiBlacklistFactualStatus(
  status: ImeiBlacklistStatus,
  fields: ImeiBlacklistProviderFields
) {
  return (status === "CLEAN" || status === "BLACKLISTED" || status === "UNKNOWN") &&
    classifyImeiBlacklistStatus(fields) === status;
}
