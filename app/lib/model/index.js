// Model adapter factory — the one place call sites go to get a
// ModelAdapter. Agent logic must require this module, never a concrete
// adapter class directly, so that adding a provider later is a matter of
// implementing ModelAdapter and adding a case here (plus flipping
// MODEL_PROVIDER) — no call-site changes. Mirrors app/lib/auth/index.js.
//
// Swaps *within* the NIM catalog (e.g. a different Llama size) are
// config-only — just change MODEL. Swapping to a different API shape
// (Anthropic, OpenAI direct, self-hosted) requires a new adapter file
// implementing the same contract — that's by design, not a gap.

const NvidiaNimAdapter = require('./nvidiaNimAdapter');

let instance;

function getModelAdapter() {
  if (!instance) {
    const providerName = process.env.MODEL_PROVIDER || 'nvidia-nim';

    switch (providerName) {
      case 'nvidia-nim':
        instance = new NvidiaNimAdapter();
        break;
      // case 'anthropic':
      //   instance = new AnthropicAdapter();
      //   break;
      default:
        throw new Error(`Unknown MODEL_PROVIDER "${providerName}"`);
    }
  }

  return instance;
}

module.exports = { getModelAdapter };
