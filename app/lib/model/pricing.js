// Small per-model pricing table (see ROADMAP.md Phase 14): model -> $/million
// tokens, looked up at usage_events write time so historical rows stay
// accurate if pricing changes later - cost is never recomputed retroactively.
// Keyed by the same string MODEL_NAME the active adapter reports, so adding a
// priced model (or a second, non-NIM adapter) is a data-only change here.
const PRICING = {
  // No entries yet - every model in use today resolves to DEFAULT_PRICE
  // below. Self-hosted/free NIM models are genuinely $0, which keeps the
  // schema and dashboard provider-agnostic ahead of ever adding a paid
  // provider (see "Non-NIM model provider" in undecided_topics.md) rather
  // than needing a schema change once one exists.
};

const DEFAULT_PRICE = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };

function computeCost(model, usage = {}) {
  const price = PRICING[model] || DEFAULT_PRICE;
  const cost =
    ((usage.inputTokens || 0) / 1e6) * price.inputPerMTok +
    ((usage.outputTokens || 0) / 1e6) * price.outputPerMTok +
    ((usage.cacheReadTokens || 0) / 1e6) * (price.cacheReadPerMTok || 0) +
    ((usage.cacheWriteTokens || 0) / 1e6) * (price.cacheWritePerMTok || 0);
  return Math.round(cost * 1e6) / 1e6;
}

module.exports = { computeCost, PRICING };
