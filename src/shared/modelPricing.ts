/**
 * Best-effort model pricing used to estimate run cost when an agent reports
 * token usage without a costUsd. All figures are USD per million tokens and
 * are estimates — providers change prices; users can override or extend the
 * table via the `gridflow.modelPricing` setting (merged over these defaults).
 */
export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const DEFAULT_MODEL_PRICING: Record<string, ModelRate> = {
  // Anthropic
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  // OpenAI (estimates)
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2 },
  'gpt-5': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gpt-4.1': { inputPerMTok: 2, outputPerMTok: 8 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'o3': { inputPerMTok: 2, outputPerMTok: 8 },
  // Google (estimates)
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
};

/**
 * Longest-prefix match so versioned/dated ids ("claude-opus-4-8-20260301",
 * "gpt-5-2026-01") resolve to their family rate.
 */
export function rateForModel(
  model: string | undefined,
  overrides?: Record<string, ModelRate>,
): ModelRate | undefined {
  if (!model) return undefined;
  const table = { ...DEFAULT_MODEL_PRICING, ...(overrides ?? {}) };
  const id = model.trim().toLowerCase();
  let best: ModelRate | undefined;
  let bestLen = 0;
  for (const [prefix, rate] of Object.entries(table)) {
    const p = prefix.toLowerCase();
    if (id.startsWith(p) && p.length > bestLen) {
      best = rate;
      bestLen = p.length;
    }
  }
  return best;
}

/**
 * Estimate USD cost from reported tokens. Prefers separate input/output
 * counts; falls back to a blended rate on totalTokens. Returns undefined when
 * the model is unknown or no token counts were reported.
 */
export function estimateCostUsd(
  model: string | undefined,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
  overrides?: Record<string, ModelRate>,
): number | undefined {
  if (!usage) return undefined;
  const rate = rateForModel(model, overrides);
  if (!rate) return undefined;
  const { inputTokens, outputTokens, totalTokens } = usage;
  if (inputTokens != null || outputTokens != null) {
    const cost =
      ((inputTokens ?? 0) * rate.inputPerMTok + (outputTokens ?? 0) * rate.outputPerMTok) / 1_000_000;
    return cost > 0 ? round6(cost) : undefined;
  }
  if (totalTokens != null && totalTokens > 0) {
    const blended = (rate.inputPerMTok + rate.outputPerMTok) / 2;
    return round6((totalTokens * blended) / 1_000_000);
  }
  return undefined;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
