// Per-model pricing (see ROADMAP.md Phase 14 / Phase 22): $/million tokens,
// looked up at usage_events write time so historical rows stay accurate if
// pricing changes later - cost is never recomputed retroactively.
//
// Rates were a hardcoded PRICING map here, which was never populated, so
// computeCost() returned 0 for every call and every cost_usd ever written was
// $0 - including on the /admin/usage dashboard. They now live on the model's
// catalog row (models.price_in_per_1m / price_out_per_1m), editable on
// /admin/models, which is also the only way a per-deployment price could ever
// have been correct: the same NIM model is free self-hosted and metered
// elsewhere.
const modelCatalog = require('./modelCatalog');

// Used for a model with no catalog row - a stamped model whose row has since
// been deleted. $0 rather than a guess: a wrong number on a cost dashboard is
// worse than a visibly absent one, and self-hosted NIM models genuinely are
// free (see "Non-NIM model provider" in undecided_topics.md).
const DEFAULT_PRICE = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };

// Async since Phase 22 - the rates live in the DB now, not in a module
// constant. Called from usageService.recordUsage, which is already async and
// already fire-and-forgotten by its four call sites.
//
// `knownPrice` is the rate modelAdapter.generate already read off the catalog
// row for this very call; when present no query is issued at all. That matters
// because codegen makes up to MAX_TURNS calls per run, and without it each one
// would re-SELECT the same immutable row the adapter just read - two reads per
// call instead of one. The row cannot change mid-call by construction, so the
// passed-through value is not a staleness trade-off. The lookup remains as the
// fallback for any caller that doesn't have it (and for a model whose catalog
// row is gone, which correctly prices at $0).
async function computeCost(model, usage = {}, knownPrice = null) {
  let price = DEFAULT_PRICE;
  if (knownPrice) {
    price = knownPrice;
  } else {
    const row = await modelCatalog.getByModelId(model);
    if (row) {
      price = { inputPerMTok: Number(row.price_in_per_1m), outputPerMTok: Number(row.price_out_per_1m) };
    }
  }

  const cost =
    ((usage.inputTokens || 0) / 1e6) * price.inputPerMTok +
    ((usage.outputTokens || 0) / 1e6) * price.outputPerMTok +
    ((usage.cacheReadTokens || 0) / 1e6) * (price.cacheReadPerMTok || 0) +
    ((usage.cacheWriteTokens || 0) / 1e6) * (price.cacheWritePerMTok || 0);
  return Math.round(cost * 1e6) / 1e6;
}

module.exports = { computeCost, DEFAULT_PRICE };
