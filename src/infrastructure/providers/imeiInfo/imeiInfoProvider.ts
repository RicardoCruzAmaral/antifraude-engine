import type { ImeiProvider } from "../../../application/ports";
import { imeiCheckReal } from "../../../providers/imei";

export const imeiInfoProvider: ImeiProvider = {
  check: imeiCheckReal,
};
