// Manual test script for the model adapter. Run:
//   node scripts/test-model-adapter.js
// Requires MODEL_PROVIDER, NVIDIA_BASE_URL, MODEL, and NVIDIA_API_KEY set
// in .env. Prints the model's reply content.

require('dotenv').config();

const { getModelAdapter } = require('../app/lib/model');

async function main() {
  const adapter = getModelAdapter();
  const { content } = await adapter.chat({
    messages: [{ role: 'user', content: 'Reply with exactly the words: Apex phase one works.' }],
  });
  console.log('Model response:', content);
}

main().catch((err) => {
  console.error('Model adapter call failed:', err.message);
  process.exit(1);
});
