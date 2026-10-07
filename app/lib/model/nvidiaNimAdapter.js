// NVIDIA NIM implementation of the modelAdapter contract (see modelAdapter.js).
// Config-only via MODEL / NVIDIA_BASE_URL / NVIDIA_API_KEY / MODEL_MAX_TOKENS.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

const PROVIDER_NAME = 'nvidia_nim';
const MODEL_NAME = process.env.MODEL;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls the chat-completions endpoint once and extracts reply text, falling
// back to reasoning_content when the model returns that field instead of
// content (observed with moonshotai/kimi-k3), plus token usage - NIM's
// OpenAI-compatible response already includes this, it was just discarded
// before ROADMAP.md Phase 14. Returns { text: '', usage } rather than
// throwing on a blank reply - blank-content and transport failures are both
// handled by the shared retry loop in generate() below. A non-2xx response's
// thrown error carries httpStatus so the circuit breaker (providerHealth.js)
// can classify it without re-parsing the message text.
//
// `finish_reason` is checked (see ROADMAP.md Phase 19): a completion that
// stopped on `length` was cut off by max_tokens mid-output, and before this it
// was indistinguishable from a complete one - so codegen would write a file
// body ending mid-function verbatim over the real file. A cut-off reply is a
// failed turn, never a result.
async function callOnce(messages) {
  const maxTokens = Number(process.env.MODEL_MAX_TOKENS || 4096);
  const response = await fetch(`${process.env.NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.MODEL,
      messages,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // A 400 whose body names the context window is the one request-shaped
    // failure a caller can act on, and it is neither quota-locking (see
    // providerHealth.js, which classifies only 429/402) nor retryable - so it
    // has to name its own cause here or it surfaces as a bare HTTP 400.
    const overflow = response.status === 400 && /context|max.?token|too (?:long|large)|length/i.test(body);
    const err = new Error(
      `NVIDIA NIM returned HTTP ${response.status}${overflow ? ' - the request exceeded the model\'s context window' : ''}: ${body.slice(0, 300)}`
    );
    err.httpStatus = response.status;
    if (overflow) err.contextOverflow = true;
    throw err;
  }

  const data = await response.json();
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const text = (message.content || message.reasoning_content || '').trim();
  const usage = {
    inputTokens: data?.usage?.prompt_tokens || 0,
    outputTokens: data?.usage?.completion_tokens || 0,
  };

  if (choice.finish_reason === 'length') {
    const err = new Error(
      `NVIDIA NIM stopped generating at the max_tokens limit (MODEL_MAX_TOKENS=${maxTokens}, ${usage.outputTokens} output tokens) - the reply was cut off mid-output and has been discarded rather than used. Raise MODEL_MAX_TOKENS if the work legitimately needs a longer reply.`
    );
    err.finishReason = 'length';
    throw err;
  }

  return { text, usage };
}

// Retry is for failures that are plausibly transient (see ROADMAP.md
// Phase 19). Before this, all three attempts were made against identical,
// unmodified `messages`, so a deterministic request-shaped failure - a 400
// context overflow, a `length` cutoff - was retried twice for nothing, burning
// two more full requests and ~1.5s of backoff before being reported. Nothing
// about the request changes between attempts, so only a failure whose cause
// lives outside the request is worth repeating.
function isRetryable(err) {
  if (err.finishReason === 'length') return false; // identical request, identical cutoff
  if (err.httpStatus === undefined) return true; // network/transport error, no response
  if (err.httpStatus === 408) return true; // server-side timeout
  return err.httpStatus >= 500; // every other 4xx is the request's own fault
}

// generate(messages) -> Promise<{text, usage}>. Resolves with non-blank text
// or rejects - never resolves with a blank/null value, and never with a reply
// the provider cut short. Transient transport failures (network errors, 5xx,
// 408) and content failures (blank reply after exhausting the
// content/reasoning_content fallback) share the MAX_ATTEMPTS retry budget with
// exponential backoff; a request-shaped failure (any other 4xx, or a
// max_tokens cutoff) fails fast on the first attempt, since retrying the same
// `messages` can only reproduce it. Whichever failure mode ended the loop is
// what gets thrown, so a transport error is never misreported as "no usable
// content" or vice versa.
async function generate(messages) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await callOnce(messages);
      if (result.text) return result;
      // No httpStatus, so isRetryable() treats this as transient - a blank
      // reply from a healthy endpoint genuinely can differ next attempt.
      lastError = new Error(
        'NVIDIA NIM returned no usable content (both content and reasoning_content were blank)'
      );
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

module.exports = { generate, PROVIDER_NAME, MODEL_NAME };
