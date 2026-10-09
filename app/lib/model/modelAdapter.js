// Seam for swapping model backends without touching call sites (see notes.md /
// ROADMAP.md Phase 3 - a non-NIM provider is a future second implementation of
// this same contract:
// generate(messages, {model}) -> Promise<{text, usage, provider, model}>).
//
// Usage capture and cost attribution (see ROADMAP.md Phase 14) deliberately
// live at each call site, not here - this module only gates calls behind the
// circuit breaker, since that's genuinely provider-level state, not something
// tied to any one call site's session/repo context.
//
// Phase 22 added the `model` argument. It is required: every call site now
// passes the model stamped on the unit of work it is running, rather than the
// adapter reading one global MODEL env var for the whole process. Resolving the
// catalog row happens here rather than at each call site so all four stay a
// single generate() call, and so max_tokens travels with the model it belongs
// to instead of being a second thing every caller has to remember to look up.
const providerHealth = require('./providerHealth');
const providerRegistry = require('./providerRegistry');
const modelCatalog = require('./modelCatalog');

async function generate(messages, { model } = {}) {
  if (!model) {
    throw new Error(
      'modelAdapter.generate requires a model. Pass the model stamped on the session, ' +
        'pipeline run, or spec-doc job being executed (see db/schema.sql Phase 22).'
    );
  }

  // A deleted or renamed catalog row leaves a stamped model with no config to
  // look up. The call still goes through on the stamp itself - the provider,
  // not Apex, is the authority on whether a model id is valid - and the adapter
  // falls back to its own default max_tokens. Failing here instead would mean
  // deleting a model retroactively breaks every queued run that named it.
  const catalogRow = await modelCatalog.getByModelId(model);
  const provider = catalogRow?.provider || providerRegistry.DEFAULT_PROVIDER;

  // Dispatch comes from the same registry that validates the admin form, so the
  // provider a row claims is always the adapter that actually runs. Previously
  // this module hardcoded nvidiaNimAdapter regardless of the row's provider.
  const adapter = providerRegistry.getAdapter(provider);
  if (!adapter) {
    throw new Error(
      `Model "${model}" names provider "${provider}", which has no adapter registered ` +
        '(see app/lib/model/providerRegistry.js).'
    );
  }

  await providerHealth.assertHealthy(provider, model);

  try {
    const { text, usage } = await adapter.generate(messages, {
      model,
      maxTokens: catalogRow?.max_tokens,
    });
    // The catalog row's prices ride along so usageService doesn't have to look
    // the same immutable row up a second time per call (codegen makes up to
    // MAX_TURNS calls per run). Undefined for an orphaned stamp, which
    // pricing.js reads as "unknown model, no price".
    const price = catalogRow
      ? { inputPerMTok: Number(catalogRow.price_in_per_1m), outputPerMTok: Number(catalogRow.price_out_per_1m) }
      : null;
    return { text, usage, provider, model, price };
  } catch (err) {
    await providerHealth.recordFailure(provider, model, err);
    throw err;
  }
}

module.exports = { generate };
