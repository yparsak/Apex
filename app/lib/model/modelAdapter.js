// ModelAdapter interface (contract only — never instantiate directly).
//
// The agent's model backend must be swappable (NVIDIA NIM for prototyping,
// any other provider for production) without rewriting agent logic. Call
// sites depend only on this interface (obtained via `getModelAdapter()` in
// ./index.js), never on a concrete adapter class. Mirrors the AuthProvider
// pattern in app/lib/auth/.
//
// Kept intentionally minimal for Phase 1 — a single chat-completion call.
// Tool-calling / structured Q&A shape belongs to Phase 3+, not here.
class ModelAdapter {
  /**
   * @param {{ messages: Array<{role: string, content: string}> }} params
   *   `messages` uses the OpenAI-style chat message shape (role/content),
   *   since NIM and most providers speak that dialect.
   * @returns {Promise<{content: string}>}
   */
  async chat(_params) {
    throw new Error('ModelAdapter.chat() is not implemented');
  }
}

module.exports = ModelAdapter;
