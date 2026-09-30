// Shared parse/render for the requirements log's internal format (see
// ROADMAP.md Phase 8): one repo_documents row per repo, organized internally
// by a `## CO <number>` heading per CO. Used both by requirementsLogService.js
// (writing, on session completion) and documentsService.js (reading, for the
// CO-scoped cross-repo search).
function parseSections(content) {
  if (!content) return [];
  const parts = content.split(/^(## CO .+)$/m).filter((part) => part.length);
  const sections = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith('## CO ')) {
      sections.push({ co: parts[i].replace('## CO ', '').trim(), body: (parts[i + 1] || '').replace(/^\n+/, '') });
      i++;
    }
  }
  return sections;
}

function renderSections(sections) {
  return sections.map((s) => `## CO ${s.co}\n\n${s.body.trim()}\n`).join('\n');
}

module.exports = { parseSections, renderSections };
