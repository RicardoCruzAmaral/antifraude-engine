import type { Profile } from "../contracts";

export function classifyProfileByScore(score: number): Profile {
  if (score <= 10) return "A";
  if (score <= 25) return "B1";
  if (score <= 45) return "B2";
  return "C";
}
