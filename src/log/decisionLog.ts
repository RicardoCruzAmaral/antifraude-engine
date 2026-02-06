import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabase = createClient(url, key, { auth: { persistSession: false } });

export async function insertDecisionLog(entry: {
  traceId: string;
  cpf: string;
  inputJson: any;
  decision: 'APPROVE' | 'DENY';
  score: number | null;
  reasons: string[];
  ruleVersion: string;
  source: 'cache' | 'engine' | 'error';
  timingsMs: Record<string, number>;
}) {
  const { error } = await supabase.from('decision_log').insert({
    trace_id: entry.traceId,
    cpf: entry.cpf,
    input_json: entry.inputJson,
    decision: entry.decision,
    score: entry.score,
    reasons: entry.reasons,
    rule_version: entry.ruleVersion,
    source: entry.source,
    timings_ms: entry.timingsMs,
  });

  if (error) throw error;
}