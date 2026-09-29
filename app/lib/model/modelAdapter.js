// Seam for swapping model backends without touching call sites (see notes.md /
// ROADMAP.md Phase 3 - a non-NIM provider is a future second implementation of
// this same contract: generate(messages) -> Promise<string>).
module.exports = require('./nvidiaNimAdapter');
