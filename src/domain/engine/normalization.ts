export function normEnum(s: any): string {
  if (!s) return "";
  return String(s)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

export function hasReason(reasons: string[], target: string): boolean {
  const t = normEnum(target);
  return reasons.some((r) => normEnum(r) === t);
}
