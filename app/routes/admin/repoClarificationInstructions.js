const express = require('express');
const db = require('../../lib/db');
const { logAdminAction } = require('../../lib/adminAudit');
const { MAX_INSTRUCTIONS_LENGTH } = require('../../lib/repoClarificationInstructions');

const router = express.Router();

async function renderInstructions(req, res, error) {
  const [repos] = await db.query(
    `SELECT r.id, r.name, rg.name AS repo_group_name, o.name AS org_name, rci.instructions
     FROM repos r
     JOIN repo_groups rg ON rg.id = r.repo_group_id
     JOIN orgs o ON o.id = rg.org_id
     LEFT JOIN repo_clarification_instructions rci ON rci.repo_id = r.id
     ORDER BY o.name, rg.name, r.name`
  );
  res.render('admin/repo-clarification-instructions', {
    user: req.session.user,
    repos,
    maxLength: MAX_INSTRUCTIONS_LENGTH,
    error,
  });
}

router.get('/', async (req, res) => {
  await renderInstructions(req, res, null);
});

router.post('/:repoId', async (req, res) => {
  const repoId = Number(req.params.repoId);
  const instructions = (req.body.instructions || '').trim();

  if (!instructions) {
    return renderInstructions(req, res, 'Instructions cannot be empty. Use Delete to remove existing instructions.');
  }
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    return renderInstructions(
      req,
      res,
      `Instructions must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer (got ${instructions.length}).`
    );
  }

  const [existing] = await db.query('SELECT id FROM repo_clarification_instructions WHERE repo_id = ?', [repoId]);
  if (existing.length) {
    await db.query('UPDATE repo_clarification_instructions SET instructions = ? WHERE repo_id = ?', [instructions, repoId]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo_clarification_instructions.update',
      detail: { repoId },
    });
  } else {
    await db.query('INSERT INTO repo_clarification_instructions (repo_id, instructions) VALUES (?, ?)', [repoId, instructions]);
    await logAdminAction({
      adminUserId: req.session.user.id,
      action: 'repo_clarification_instructions.create',
      detail: { repoId },
    });
  }
  res.redirect('/admin/repo-clarification-instructions');
});

router.post('/:repoId/delete', async (req, res) => {
  const repoId = Number(req.params.repoId);
  await db.query('DELETE FROM repo_clarification_instructions WHERE repo_id = ?', [repoId]);
  await logAdminAction({
    adminUserId: req.session.user.id,
    action: 'repo_clarification_instructions.delete',
    detail: { repoId },
  });
  res.redirect('/admin/repo-clarification-instructions');
});

module.exports = router;
