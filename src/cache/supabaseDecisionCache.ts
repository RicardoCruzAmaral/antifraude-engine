import { supabase } from '../supabase/client';

export type Decision = 'APPROVE' | 'DENY';

export async function getCachedDecision(cpf: string) {
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from('decision_cache') // view public
    .select('cpf, decision, score, reasons, rule_version, expires_at')
    .eq('cpf', cpf)
    .gt('expires_at', nowIso)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    cpf: data.cpf as string,
    decision: data.decision as Decision,
    score: (data.score ?? null) as number | null,
    reasons: (Array.isArray(data.reasons) ? data.reasons : []) as string[],
    ruleVersion: data.rule_version as string,
    expiresAt: data.expires_at as string,
  };
}

export async function upsertCachedDecision(input: {
  cpf: string;
  decision: Decision;
  score: number | null;
  reasons: string[];
  ruleVersion: string;
  ttlDays: number;
}) {
  const expiresAt = new Date(Date.now() + input.ttlDays * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('decision_cache') // view public
    .upsert({
      cpf: input.cpf,
      decision: input.decision,
      score: input.score,
      reasons: input.reasons,
      rule_version: input.ruleVersion,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });

  if (error) throw error;
  return expiresAt;
}