// Seam for swapping model backends without touching call sites (see notes.md /
// ROADMAP.md Phase 3 - a non-NIM provider is a future second implementation of
// this same contract: generate(messages) -> Promise<{text, usage, provider, model}>).
//
// Usage capture and cost attribution (see ROADMAP.md Phase 14) deliberately
// live at each call site, not here - this module only gates calls behind the
// provider circuit breaker, since that's genuinely provider-level state, not
// something tied to any one call site's session/repo context.
const activeAdapter = require('./nvidiaNimAdapter');
const providerHealth = require('./providerHealth');

async function generate(messages) {
  await providerHealth.assertHealthy(activeAdapter.PROVIDER_NAME);

  try {
    const { text, usage } = await activeAdapter.generate(messages);
    return { text, usage, provider: activeAdapter.PROVIDER_NAME, model: activeAdapter.MODEL_NAME };
  } catch (err) {
    await providerHealth.recordFailure(activeAdapter.PROVIDER_NAME, err);
    throw err;
  }
}

module.exports = { generate };
