import type {
  EnrichmentProvider,
  EnrichmentProviderInput,
} from "../../../application/ports";
import {
  enrich,
  normalizeInput,
} from "../../../providers/enrichment";

export const techTrailEnrichmentProvider: EnrichmentProvider = {
  enrich,
};

export function normalizeEnrichmentInput(
  body: unknown
): EnrichmentProviderInput {
  return normalizeInput(body);
}
