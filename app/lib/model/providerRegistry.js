// The set of model providers Apex can actually call (see ROADMAP.md Phase 22).
//
// This exists because `models.provider` is not a label - modelAdapter derives
// the circuit-breaker key and usage_events.provider from it. Left as free text
// on the admin form, a typo ('nvidia-nim') would file spend and health under a
// provider that never served a call, and editing it on a locked model would
// move the breaker key, silently releasing a live quota lock while /admin/usage
// kept displaying the stale locked row.
//
// One map, two consumers: it populates the admin form's provider <select> and
// it resolves the adapter to dispatch to. That's what keeps "the provider this
// row claims" and "the adapter that actually ran" from drifting apart - a
// second adapter (see "Non-NIM model provider" in undecided_topics.md) is a new
// entry here plus its module, with no change to any call site.
const nvidiaNimAdapter = require('./nvidiaNimAdapter');

const ADAPTERS = {
  [nvidiaNimAdapter.PROVIDER_NAME]: nvidiaNimAdapter,
};

const DEFAULT_PROVIDER = nvidiaNimAdapter.PROVIDER_NAME;

function listProviders() {
  return Object.keys(ADAPTERS);
}

function isKnownProvider(provider) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, provider);
}

function getAdapter(provider) {
  return ADAPTERS[provider] || null;
}

module.exports = { listProviders, isKnownProvider, getAdapter, DEFAULT_PROVIDER };
