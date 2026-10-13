// Document admin screen (see ROADMAP.md Phase 24). Since this phase it is not
// a settings page over a code registry - it IS the registry. Creating a
// document here is the only way one comes into existence; there are no
// built-in types and nothing is seeded.
//
// Deliberately its own page rather than another section on /admin/models. That
// page is the model *catalog* - what models exist and what they cost. Which
// documents get written, and by which model, is a different question that keeps
// growing (per-document cadence, per-document scope, eventually per-repo
// overrides).
//
// Phase 26 split the one page in two: a list that answers "what exists and
// which are on", and a form page per document. This is the only router in
// /admin with more than one GET, and that is the point - `model_prompt` is the
// first admin-editable field too big for a table cell, so it is the one field
// that had to move off the list. Nothing about the data model, the validation
// or the audit rows changed with it; the only behavior change is that a
// rejected update now keeps what was typed (see below).
const express = require('express');
const modelCatalog = require('../../lib/model/modelCatalog');
const docDefinitions = require('../../lib/documents/docDefinitions');
const { logAdminAction } = require('../../lib/adminAudit');

const router = express.Router();

// Advisory only. There is no reliable check for "this prompt will produce
// Markdown", and the real defense is the prefilled starter text on the create
// form - but a prompt that never says the word at all is worth one line of
// doubt, because the failure mode (a document that renders as a wall of prose
// or, worse, as a chat reply) is silent until someone opens the repo's
// Documents page. Flagged on the list row, explained on the form.
function missingMarkdownHint(prompt) {
  return !/markdown/i.test(prompt || '');
}

async function renderList(req, res, error) {
  const [models, definitions] = await Promise.all([modelCatalog.listAll(), docDefinitions.listAll()]);

  // Resolved per definition rather than once, because each has its own model
  // and its own fallback story to tell. Sequential: this is a handful of rows
  // and each resolve is two small indexed reads.
  const rows = [];
  for (const d of definitions) {
    const { model, usedFallback } = await modelCatalog.resolveForDocDefinition(d);
    rows.push({
      id: d.id,
      docKey: d.doc_key,
      title: d.title,
      isActive: !!d.is_active,
      // What is configured vs. what is actually in effect - they differ when
      // the configured model has since been disabled or deleted, and the
      // screen has to say so rather than showing the fallback as if it were
      // the choice. A document quietly generating under a model nobody picked
      // is exactly what an admin needs to spot while scanning the list, so the
      // marker is on the row; the paragraph explaining it is on the form.
      effectiveModel: model,
      usedFallback,
      documentCount: await docDefinitions.countDocuments(d.doc_key),
      missingMarkdownHint: missingMarkdownHint(d.model_prompt),
    });
  }

  res.render('admin/documents', {
    user: req.session.user,
    definitions: rows,
    // Only to decide whether to show the "nothing can be generated" error. The
    // list renders no model picker - that is on the form.
    hasEnabledModel: models.some((m) => m.enabled),
    error,
  });
}

// The create and edit pages are one view with one shape: a definition or null,
// and the values to put in the fields. Keeping them a single template is what
// stops the two forms drifting apart - the prose beside each field is the only
// place the system explains its own contract to whoever is writing a prompt,
// and it has to say the same thing in both places.
async function renderForm(req, res, { definition, error, body }) {
  const models = await modelCatalog.listAll();

  // Submitted values win over stored ones so a rejected submit echoes back
  // what was typed instead of silently reverting to the database row. On the
  // create form with nothing submitted the prompt opens prefilled, not blank
  // (see docDefinitions.STARTER_PROMPT).
  let form;
  if (body) {
    form = {
      title: body.title || '',
      description: body.description || '',
      model_prompt: body.model_prompt || '',
      model_id: body.model_id || '',
      is_active: body.is_active === '1',
    };
  } else if (definition) {
    form = {
      title: definition.title,
      description: definition.description || '',
      model_prompt: definition.model_prompt,
      model_id: definition.model_id || '',
      is_active: !!definition.is_active,
    };
  } else {
    // Checked by default: someone about to write a prompt wants it to run.
    form = { title: '', description: '', model_prompt: docDefinitions.STARTER_PROMPT, model_id: '', is_active: true };
  }

  let effectiveModel = null;
  let usedFallback = false;
  let documentCount = 0;
  if (definition) {
    ({ model: effectiveModel, usedFallback } = await modelCatalog.resolveForDocDefinition(definition));
    // Feeds the delete confirmation: "this hides a document 30 repos have" is
    // a materially different decision from deleting one nothing ever ran.
    documentCount = await docDefinitions.countDocuments(definition.doc_key);
  }

  res.render('admin/document-form', {
    user: req.session.user,
    definition: definition || null,
    form,
    // The picker offers enabled models only. A definition pointing at a
    // disabled model therefore shows no selection - which is honest, because
    // that is a choice that is no longer in effect, and the fallback notice
    // above the field says so.
    enabledModels: models.filter((m) => m.enabled),
    effectiveModel,
    usedFallback,
    documentCount,
    // Computed from what is actually in the textarea, not from the stored row:
    // after a rejected submit the advisory has to describe the text the admin
    // is looking at.
    missingMarkdownHint: missingMarkdownHint(form.model_prompt),
    starterPrompt: docDefinitions.STARTER_PROMPT,
    maxTitleLength: docDefinitions.MAX_TITLE_LENGTH,
    minPromptLength: docDefinitions.MIN_PROMPT_LENGTH,
    error,
  });
}

// Shared by create and update. Validation here is thin but real: it refuses the
// two things that produce a silently broken document (no prompt, a prompt too
// short to be one) and the one that produces an ambiguous admin list (a
// duplicate title). It deliberately does NOT try to judge whether a prompt is
// good - that is not checkable, and pretending otherwise would just be a
// hurdle that teaches admins to work around validation.
async function parseForm(body, exceptId = null) {
  const title = (body.title || '').trim();
  const description = (body.description || '').trim();
  const modelPrompt = (body.model_prompt || '').trim();
  const rawModel = (body.model_id || '').trim();

  if (!title) return { error: 'Title is required.' };
  if (title.length > docDefinitions.MAX_TITLE_LENGTH) {
    return { error: `Title must be ${docDefinitions.MAX_TITLE_LENGTH} characters or fewer.` };
  }
  if (await docDefinitions.titleTaken(title, exceptId)) {
    return { error: `A document called "${title}" already exists.` };
  }
  if (modelPrompt.length < docDefinitions.MIN_PROMPT_LENGTH) {
    return {
      error:
        `The model prompt is what gets sent to the model, and must be at least ` +
        `${docDefinitions.MIN_PROMPT_LENGTH} characters. A one-line prompt produces a worthless ` +
        'document, and nothing fails - you just find out the next morning.',
    };
  }

  // Empty means "follow the catalog default" - a real choice, not a blank
  // submission, so it is accepted rather than validated against the catalog.
  let modelId = null;
  if (rawModel) {
    const model = await modelCatalog.getById(Number(rawModel));
    if (!model) return { error: 'That model no longer exists.' };
    if (!model.enabled) return { error: 'Enable the model before using it for documents.' };
    modelId = model.id;
  }

  return { values: { title, description, modelPrompt, modelId } };
}

router.get('/', async (req, res) => {
  await renderList(req, res, null);
});

router.get('/new', async (req, res) => {
  await renderForm(req, res, { definition: null });
});

// An id that no longer resolves lands on the list with the explanation rather
// than on a form with nothing in it - there is nothing to edit and no reason
// to offer the fields.
router.get('/:id/edit', async (req, res) => {
  const definition = await docDefinitions.getById(Number(req.params.id));
  if (!definition || definition.archived_at) return renderList(req, res, 'That document no longer exists.');
  await renderForm(req, res, { definition });
});

router.post('/', async (req, res) => {
  const { error, values } = await parseForm(req.body);
  if (error) return renderForm(req, res, { definition: null, error, body: req.body });

  // The form's Active box is checked by default: an admin who just wrote a
  // prompt wants it to run. Phase 23's "new types are opt-in" default existed
  // because types arrived with a deploy nobody asked for; a document someone
  // typed on this page is the opposite situation. An unchecked box posts
  // nothing, hence the plain truthiness test.
  const { id, docKey } = await docDefinitions.create({
    ...values,
    isActive: req.body.is_active === '1',
    createdBy: req.session.user.id,
  });

  // The prompt goes in the audit detail in full, here and on every update.
  // With no document versioning (see ROADMAP.md Phase 24's open questions),
  // this log is the ONLY record of what a definition's prompt said at a given
  // time, and so the only way to correlate a generated document with the
  // prompt that produced it.
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'doc_definition.create',
    detail: { id, docKey, title: values.title, modelId: values.modelId, modelPrompt: values.modelPrompt },
  });
  res.redirect('/admin/documents');
});

router.post('/:id/update', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await docDefinitions.getById(id);
  if (!existing || existing.archived_at) return renderList(req, res, 'That document no longer exists.');

  const { error, values } = await parseForm(req.body, id);
  // Re-renders the edit form with what was submitted. Before Phase 26 this
  // passed no body, so a rejected update redrew every field from the database
  // row and a long prompt someone had just rewritten was gone.
  if (error) return renderForm(req, res, { definition: existing, error, body: req.body });

  // doc_key is not in the form at all. The title is editable and the key is
  // not: it is already copied into doc_jobs, repo_doc_sync and repo_documents
  // rows that cannot be updated in step (see db/schema.sql).
  const { promptChanged } = await docDefinitions.update(id, { ...values, existing });

  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'doc_definition.update',
    detail: {
      id,
      docKey: existing.doc_key,
      title: values.title,
      previousTitle: existing.title,
      modelId: values.modelId,
      promptChanged,
      // Both sides, only when it changed: "what did this prompt say before
      // someone edited it" has no other answer anywhere in the system.
      previousModelPrompt: promptChanged ? existing.model_prompt : undefined,
      modelPrompt: promptChanged ? values.modelPrompt : undefined,
    },
  });
  res.redirect('/admin/documents');
});

router.post('/:id/active', async (req, res) => {
  const id = Number(req.params.id);
  const definition = await docDefinitions.getById(id);
  if (!definition || definition.archived_at) return renderList(req, res, 'That document no longer exists.');

  const active = req.body.active === 'true';
  await docDefinitions.setActive(id, active);
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: active ? 'doc_definition.activate' : 'doc_definition.deactivate',
    detail: { id, docKey: definition.doc_key, title: definition.title },
  });
  res.redirect('/admin/documents');
});

// Delete archives (see docDefinitions.archive). Nothing already generated is
// removed, and the key stays reserved so a later document cannot inherit this
// one's content. The button lives on the edit page, not in every list row: it
// is irreversible from the UI, and a danger button sitting beside a button
// people press often is a misclick waiting to happen.
router.post('/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  const definition = await docDefinitions.getById(id);
  if (!definition) return res.redirect('/admin/documents');

  const documentCount = await docDefinitions.countDocuments(definition.doc_key);
  await docDefinitions.archive(id);
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'doc_definition.delete',
    detail: {
      id,
      docKey: definition.doc_key,
      title: definition.title,
      // What was orphaned, counted at the moment it was orphaned - the rows
      // stay in repo_documents with nothing listing them any more.
      orphanedDocuments: documentCount,
      modelPrompt: definition.model_prompt,
    },
  });
  res.redirect('/admin/documents');
});

module.exports = router;
