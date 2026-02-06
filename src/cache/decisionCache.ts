import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Decisão final do motor
 * (expandimos depois pra REVIEW, etc.)
 */
export type Decision = "APPROVE" | "DECLINE";

/**
 * Resultado válido vindo do cache
 */
export type CacheHit = {
  cpf: string;
  decision: Decision;
  score: number | null;
  reasons: string[];
  rule_version: string;
  expires_at: string;
};

/**
 * Busca cache válido por CPF
 */
export async function cacheGet(
  supabase: SupabaseClient,
  cpf: string
): Promise<CacheHit | null> {
  const { data, error } = await supabase
    .from("decision_cache")
    .select("cpf, decision, score, reasons, rule_version, expires_at")
    .eq("cpf", cpf)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) {
    console.error("[cacheGet] failed", error);
    return null;
  }

  return data ?? null;
}

/**
 * Escreve / atualiza cache (UPSERT)
 */
export async function cacheUpsert(
  supabase: SupabaseClient,
  input: {
    cpf: string;
    decision: Decision;
    score: number | null;
    reasons: string[];
    ruleVersion: string;
    ttlDays: number;
  }
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + input.ttlDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const { error } = await supabase.from("decision_cache").upsert(
    {
      cpf: input.cpf,
      decision: input.decision,
      score: input.score,
      reasons: input.reasons,
      rule_version: input.ruleVersion,
      expires_at: expiresAt,
      updated_at: now.toISOString(),
    },
    {
      onConflict: "cpf",
    }
  );

  if (error) {
    console.error("[cacheUpsert] failed", error);
    throw error;
  }
}