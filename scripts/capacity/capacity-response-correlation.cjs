// The caller supplies only the allowlisted x-vercel-id response header.
// Invalid values are never returned or persisted with diagnostic output.
function readVercelCorrelation(value) {
  if (value === null || value === undefined) return { status: 'missing' };
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || !/^[\x20-\x7e]+$/.test(value))
    return { status: 'invalid' };
  return { status: 'present', value };
}
module.exports = { readVercelCorrelation };
