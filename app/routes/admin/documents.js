// Document-type admin screen (see ROADMAP.md Phase 23): which generated
// documents the nightly worker writes, and which model writes each one.
//
// Deliberately its own page rather than another section on /admin/models.
// That page is the model *catalog* - what models exist and what they cost.
// Which documents get written, and by which model, is a different question
// that will keep growing (per-type cadence, per-type scope, eventually per-repo
// overrides), and the per-type model select came here from there rather than
// being duplicated.
const express = require('express');
const modelCatalog = require('../../lib/model/modelCatalog');
const docTypes = require('../../lib/documents/docTypes');
const docSettings = require('../../lib/documents/docSettings');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

async function renderDocuments(req, res, error) {
  const [models, enabledKeys] = await Promise.all([modelCatalog.listAll(), docSettings.getEnabledKeys()]);

  // Resolved per type rather than once, because each type has its own setting
  // and its own fallback story to tell. Sequential: the list is a handful of
  // entries and each resolve is two small indexed reads.
  const types = [];
  for (const t of docTypes.list()) {
    const configuredModelId = await modelCatalog.getDocModelSetting(t.key);
    const { model, usedFallback } = await modelCatalog.resolveForDocType(t.key);
    types.push({
      ...t,
      enabled: enabledKeys.includes(t.key),
      configuredModelId,
      // What is configured vs. what is actually in effect - they differ when
      // the configured model has since been disabled or deleted, and the screen
      // has to say so rather than showing the fallback as if it were the choice.
      effectiveModel: model,
      usedFallback,
    });
  }

  // A key an admin enabled whose registry entry has since been removed. The
  // scan ignores these (see docSettings.listEnabled), but silently: this is the
  // one place that can actually explain why a document an admin remembers
  // enabling is no longer being written.
  const knownKeys = docTypes.list().map((t) => t.key);
  const orphanedKeys = enabledKeys.filter((k) => !knownKeys.includes(k));

  res.render('admin/documents', {
    user: req.session.user,
    types,
    orphanedKeys,
    models,
    error,
  });
}

router.get('/', async (req, res) => {
  await renderDocuments(req, res, null);
});

// One submit for the whole checkbox set, not one toggle per row: unchecked
// boxes aren't posted at all, so the form body IS the complete new state and a
// per-row POST would need a hidden "off" field to say the same thing.
router.post('/enabled', async (req, res) => {
  // A single checkbox arrives as a string, several as an array.
  const raw = req.body.doc_type_key;
  const keys = raw === undefined ? [] : [].concat(raw);

  const previous = await docSettings.getEnabledKeys();
  await docSettings.setEnabledKeys(keys, req.session.user.id);
  const current = await docSettings.getEnabledKeys();

  // "The docs stopped regenerating in March" has to be answerable, so the audit
  // record carries the delta, not just the new list.
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'doc_type.set_enabled',
    detail: {
      enabled: current,
      turnedOn: current.filter((k) => !previous.includes(k)),
      turnedOff: previous.filter((k) => !current.includes(k)),
    },
  });
  res.redirect('/admin/documents');
});

router.post('/:key/model', async (req, res) => {
  const docType = docTypes.get(req.params.key);
  if (!docType) return renderDocuments(req, res, 'That document type no longer exists.');

  const raw = (req.body.model_id || '').trim();

  // Empty means "follow the catalog default" - a real choice, not a blank
  // submission, so it is accepted rather than validated against the catalog.
  if (!raw) {
    await modelCatalog.setDocModel(docType.key, null, req.session.user.id);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'doc_type.set_model',
      detail: { docType: docType.key, modelId: null },
    });
    return res.redirect('/admin/documents');
  }

  const model = await modelCatalog.getById(Number(raw));
  if (!model) return renderDocuments(req, res, 'That model no longer exists.');
  if (!model.enabled) return renderDocuments(req, res, 'Enable the model before using it for documents.');

  await modelCatalog.setDocModel(docType.key, model.id, req.session.user.id);
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'doc_type.set_model',
    detail: { docType: docType.key, modelId: model.id, model: model.model_id },
  });
  res.redirect('/admin/documents');
});

module.exports = router;
