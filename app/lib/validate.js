// Small shared validation helpers, reused across auth routes (and future
// routes) so required-field/length checks aren't duplicated per handler.

function isNonEmptyString(value, { maxLength } = {}) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (maxLength && trimmed.length > maxLength) return false;
  return true;
}

// Change Order number format, per roadmap.md: format-only validation, not
// checked against the actual change-control/QMS system (Accepted Risk #1).
const CO_NUMBER_PATTERN = /^C[0-9]{8}$/;

function isValidCoNumber(value) {
  return typeof value === 'string' && CO_NUMBER_PATTERN.test(value);
}

module.exports = { isNonEmptyString, isValidCoNumber, CO_NUMBER_PATTERN };
