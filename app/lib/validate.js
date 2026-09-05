// Small shared validation helpers, reused across auth routes (and future
// routes) so required-field/length checks aren't duplicated per handler.

function isNonEmptyString(value, { maxLength } = {}) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (maxLength && trimmed.length > maxLength) return false;
  return true;
}

module.exports = { isNonEmptyString };
