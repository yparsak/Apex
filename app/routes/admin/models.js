// Model catalog admin screen (see ROADMAP.md Phase 22). The only way a model
// enters the system: there is no MODEL env var any more and db/schema.sql
// seeds no rows, so on a fresh install this page is reached through the
// no-model lock banner and is the thing that clears it.
const express = require('express');
const modelCatalog = require('../../lib/model/modelCatalog');
const providerRegistry = require('../../lib/model/providerRegistry');
const appLock = require('../../lib/appLock');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

async function renderModels(req, res, error) {
  const models = await modelCatalog.listAll();
  res.render('admin/models', {
    user: req.session.user,
    models,
    providers: providerRegistry.listProviders(),
    error,
  });
}

// Shared by create and update. max_tokens and the prices are numeric inputs
// that arrive as strings, and an empty or non-numeric one must not silently
// become NaN in an INSERT - a model with a NaN max_tokens would fail every
// call it was ever selected for.
function parseForm(body) {
  const modelId = (body.model_id || '').trim();
  const displayName = (body.display_name || '').trim();
  const description = (body.description || '').trim();
  const provider = (body.provider || '').trim() || providerRegistry.DEFAULT_PROVIDER;
  const maxTokens = Number(body.max_tokens);
  const priceInPer1m = Number(body.price_in_per_1m || 0);
  const priceOutPer1m = Number(body.price_out_per_1m || 0);

  if (!modelId || !displayName) return { error: 'Model ID and display name are required.' };
  // Validated against the adapter registry, not accepted as free text: this
  // string is the circuit-breaker key and the usage-attribution key, so a value
  // with no adapter behind it would mislabel spend and move the breaker key
  // without changing which adapter actually runs.
  if (!providerRegistry.isKnownProvider(provider)) {
    return { error: `Unknown provider "${provider}". Known providers: ${providerRegistry.listProviders().join(', ')}.` };
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    return { error: 'Max tokens must be a positive whole number.' };
  }
  if (!Number.isFinite(priceInPer1m) || priceInPer1m < 0 || !Number.isFinite(priceOutPer1m) || priceOutPer1m < 0) {
    return { error: 'Prices must be zero or a positive number.' };
  }

  return { values: { modelId, displayName, description, provider, maxTokens, priceInPer1m, priceOutPer1m } };
}

router.get('/', async (req, res) => {
  await renderModels(req, res, null);
});

router.post('/', async (req, res) => {
  const { error, values } = parseForm(req.body);
  if (error) return renderModels(req, res, error);

  try {
    const id = await modelCatalog.create({ ...values, enabled: true });
    // First model added clears the no-model lock, but this process's appLock
    // cache would hold the old "locked" answer for up to its TTL - long enough
    // for the admin's own redirect to still show the banner and read as a
    // failed save.
    appLock.invalidate();
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'model.create',
      detail: { modelId: id, model: values.modelId },
    });
    res.redirect('/admin/models');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderModels(req, res, 'A model with that Model ID already exists.');
    throw err;
  }
});

router.post('/:id/update', async (req, res) => {
  const { error, values } = parseForm(req.body);
  if (error) return renderModels(req, res, error);

  const id = Number(req.params.id);
  const existing = await modelCatalog.getById(id);
  if (!existing) return renderModels(req, res, 'That model no longer exists.');

  // Renaming model_id orphans every stamped session/job that named the old
  // string - the same hazard /delete below refuses, so it has to be refused
  // here too. Left unguarded, a typo fix on a queued model silently drops
  // max_tokens to the adapter's 4096 default (truncating every reply on a
  // large-context model, which is a non-retryable failure) and writes $0 for
  // all its usage. Every other field is safe to edit in place; only the
  // identity is load-bearing.
  if (values.modelId !== existing.model_id) {
    const refs = await modelCatalog.countReferences(existing.model_id);
    if (refs.activeSessions > 0 || refs.activeDocJobs > 0) {
      return renderModels(
        req,
        res,
        `Cannot change the Model ID of "${existing.display_name}": ${refs.activeSessions} unfinished session(s) ` +
          `and ${refs.activeDocJobs} document job(s) are stamped with "${existing.model_id}" and would be ` +
          'orphaned. Add a new model instead, or wait for that work to finish.'
      );
    }
  }

  try {
    await modelCatalog.update(id, values);
    // provider and max_tokens are read per call, so an edit must not be served
    // from a stale cache.
    appLock.invalidate();
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'model.update',
      detail: { modelId: id, model: values.modelId, previousModel: existing.model_id },
    });
    res.redirect('/admin/models');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return renderModels(req, res, 'A model with that Model ID already exists.');
    throw err;
  }
});

// Enable/disable is the normal lifecycle operation; delete is the exception
// (see below). Disabling the last enabled model deliberately succeeds - it
// engages the no-model lock, which is a legitimate thing for an admin to want
// and is reversible by re-enabling. The view warns before it happens rather
// than the route refusing it.
router.post('/:id/enabled', async (req, res) => {
  const id = Number(req.params.id);
  const enabled = req.body.enabled === 'true';

  await modelCatalog.setEnabled(id, enabled);
  appLock.invalidate();
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: enabled ? 'model.enable' : 'model.disable',
    detail: { modelId: id },
  });
  res.redirect('/admin/models');
});

router.post('/:id/default', async (req, res) => {
  const id = Number(req.params.id);
  const model = await modelCatalog.getById(id);
  if (!model) return renderModels(req, res, 'That model no longer exists.');
  if (!model.enabled) return renderModels(req, res, 'Enable the model before making it the default.');

  await modelCatalog.setDefault(id);
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'model.set_default',
    detail: { modelId: id, model: model.model_id },
  });
  res.redirect('/admin/models');
});

// sessions.model / doc_jobs.model / usage_events.model are plain VARCHARs
// rather than FKs (so history survives a catalog change - see db/schema.sql),
// which means the database will not raise ER_ROW_IS_REFERENCED_2 on our behalf
// the way it does for every other admin delete here. This is the hand-rolled
// equivalent.
//
// In-flight work blocks the delete outright: a queued session whose model row
// vanished mid-flight would still carry the stamp, but nothing could look up
// its max_tokens or pricing. Completed history does not block it - that's what
// disable is for, and refusing forever would make the catalog unpruneable.
router.post('/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  const model = await modelCatalog.getById(id);
  if (!model) return res.redirect('/admin/models');

  const refs = await modelCatalog.countReferences(model.model_id);
  if (refs.activeSessions > 0 || refs.activeDocJobs > 0) {
    return renderModels(
      req,
      res,
      `Cannot delete "${model.display_name}": ${refs.activeSessions} unfinished session(s) and ` +
        `${refs.activeDocJobs} document job(s) are still using it. Disable it instead, or wait for them to finish.`
    );
  }

  await modelCatalog.remove(id);
  appLock.invalidate();
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'model.delete',
    detail: { modelId: id, model: model.model_id, historicalUsageEvents: refs.usageEvents },
  });
  res.redirect('/admin/models');
});

module.exports = router;
