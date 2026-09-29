// NVIDIA NIM implementation of the modelAdapter contract (see modelAdapter.js).
// Config-only via MODEL / NVIDIA_BASE_URL / NVIDIA_API_KEY / MODEL_MAX_TOKENS.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls the chat-completions endpoint once and extracts reply text, falling
// back to reasoning_content when the model returns that field instead of
// content (observed with moonshotai/kimi-k3). Returns '' rather than
// throwing on a blank reply - blank-content and transport failures are both
// handled by the shared retry loop in generate() below.
async function callOnce(messages) {
  const response = await fetch(`${process.env.NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.MODEL,
      messages,
      max_tokens: Number(process.env.MODEL_MAX_TOKENS || 4096),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`NVIDIA NIM returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message || {};
  return (message.content || message.reasoning_content || '').trim();
}

// generate(messages) -> Promise<string>. Resolves with non-blank content or
// rejects - never resolves with a blank/null value. Transport failures
// (network errors, non-2xx status) and content failures (blank reply after
// exhausting the content/reasoning_content fallback) share the same
// MAX_ATTEMPTS retry budget with exponential backoff; whichever failure mode
// hit on the final attempt is what gets thrown, so a transport error is never
// misreported as "no usable content" or vice versa.
async function generate(messages) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const content = await callOnce(messages);
      if (content) return content;
      lastError = new Error(
        'NVIDIA NIM returned no usable content (both content and reasoning_content were blank)'
      );
    } catch (err) {
      lastError = err;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

module.exports = { generate };
