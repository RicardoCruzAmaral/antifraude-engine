export function computeFingerprintScore(
  device: any,
  modeloDeclarado: string | null
) {
  let points = 0;
  const reasons: string[] = [];
  const breakdown: { rule: string; points: number }[] = [];

  if (!device || !modeloDeclarado) {
    return { points, reasons, breakdown };
  }

  const declared = modeloDeclarado.toLowerCase();
  const os = (device.os || "").toLowerCase();

  // iPhone declarado, Android detectado
  if (
    declared.includes("iphone") &&
    os === "android"
  ) {
    points += 25;
    reasons.push("DISCREPANCIA_SISTEMA_OPERACIONAL");
    breakdown.push({ rule: "OS_DIVERGENTE_IPHONE", points: 25 });
  }

  // Android declarado, iOS detectado
  if (
    (declared.includes("samsung") ||
      declared.includes("xiaomi") ||
      declared.includes("motorola") ||
      declared.includes("android")) &&
    os === "ios"
  ) {
    points += 25;
    reasons.push("DISCREPANCIA_SISTEMA_OPERACIONAL");
    breakdown.push({ rule: "OS_DIVERGENTE_ANDROID", points: 25 });
  }

  if (device.incognito === true) {
    points += 10;
    reasons.push("MODO_INCOGNITO");
    breakdown.push({ rule: "INCOGNITO", points: 10 });
  }


  return { points, reasons, breakdown };
}
