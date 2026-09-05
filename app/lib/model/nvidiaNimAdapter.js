// NVIDIA NIM implementation of ModelAdapter — calls NIM's OpenAI-compatible
// chat completions endpoint. `NVIDIA_API_KEY` is read directly from env
// (not via the secrets provider — that indirection is reserved for the
// GitHub App private key per roadmap.md, not scoped out to every credential).

const ModelAdapter = require('./modelAdapter');

class NvidiaNimAdapter extends ModelAdapter {
  async chat({ messages }) {
    const response = await fetch(`${process.env.NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: process.env.MODEL, messages }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`NVIDIA NIM chat request failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    return { content: data.choices[0].message.content };
  }
}

module.exports = NvidiaNimAdapter;
