// Usage/cost reporting store (see ROADMAP.md Phase 14): one append-only
// usage_events row per successful model call, written by each call site
// (overlapService.js, clarificationService.js, codegenService.js,
// specDocService.js) right after modelAdapter.generate() resolves, plus the
// query helpers behind the /admin/usage dashboard.
const db = require('../db');
const pricing = require('./pricing');

async function recordUsage({ callSite, sessionId = null, repoId = null, provider, model, usage = {} }) {
  const costUsd = pricing.computeCost(model, usage);
  await db.query(
    `INSERT INTO usage_events
      (call_site, session_id, repo_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      callSite,
      sessionId,
      repoId,
      provider,
      model,
      usage.inputTokens || 0,
      usage.outputTokens || 0,
      usage.cacheReadTokens || 0,
      usage.cacheWriteTokens || 0,
      costUsd,
    ]
  );
}

function dateRangeClause(from, to) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('ue.created_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('ue.created_at <= ?');
    params.push(to);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

async function getSummary({ from, to } = {}) {
  const { where, params } = dateRangeClause(from, to);
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS costUsd
     FROM usage_events ue ${where}`,
    params
  );
  const requests = Number(row.requests);
  const costUsd = Number(row.costUsd);
  return {
    requests,
    tokens: Number(row.tokens),
    costUsd,
    avgCostPerRequest: requests > 0 ? costUsd / requests : 0,
  };
}

// getBreakdownByRepoGroup(...) - which org/repo-group is costing the most.
// LEFT JOINs so a usage_events row with repo_id = NULL (spec_doc jobs always
// carry one, but the join stays defensive) still shows up, grouped as "—".
async function getBreakdownByRepoGroup({ from, to } = {}) {
  const { where, params } = dateRangeClause(from, to);
  const [rows] = await db.query(
    `SELECT o.name AS orgName, rg.name AS repoGroupName,
            COUNT(*) AS requests,
            COALESCE(SUM(ue.input_tokens + ue.output_tokens), 0) AS tokens,
            COALESCE(SUM(ue.cost_usd), 0) AS costUsd
     FROM usage_events ue
     LEFT JOIN repos r ON r.id = ue.repo_id
     LEFT JOIN repo_groups rg ON rg.id = r.repo_group_id
     LEFT JOIN orgs o ON o.id = rg.org_id
     ${where}
     GROUP BY o.name, rg.name
     ORDER BY costUsd DESC`,
    params
  );
  return rows;
}

async function getBreakdownByCallSite({ from, to } = {}) {
  const { where, params } = dateRangeClause(from, to);
  const [rows] = await db.query(
    `SELECT call_site AS callSite,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
            COALESCE(SUM(cost_usd), 0) AS costUsd
     FROM usage_events ue ${where}
     GROUP BY call_site
     ORDER BY costUsd DESC`,
    params
  );
  return rows;
}

async function getTrend({ from, to } = {}) {
  const { where, params } = dateRangeClause(from, to);
  const [rows] = await db.query(
    `SELECT DATE(ue.created_at) AS day,
            COUNT(*) AS requests,
            COALESCE(SUM(ue.input_tokens + ue.output_tokens), 0) AS tokens,
            COALESCE(SUM(ue.cost_usd), 0) AS costUsd
     FROM usage_events ue ${where}
     GROUP BY DATE(ue.created_at)
     ORDER BY day ASC`,
    params
  );
  return rows;
}

module.exports = { recordUsage, getSummary, getBreakdownByRepoGroup, getBreakdownByCallSite, getTrend };
