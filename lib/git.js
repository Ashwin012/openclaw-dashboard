/**
 * Safe git command execution — avoids shell injection by using execFile
 * with argument arrays instead of string interpolation.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// All git commands use execFile (no shell) to prevent injection
async function git(args, cwd) {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return { stdout, stderr };
}

// Validate a branch name — reject anything that could be dangerous
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-\/]+$/;
function validateBranchName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 256) return false;
  if (!SAFE_BRANCH_RE.test(name)) return false;
  if (name.startsWith('-')) return false;
  if (name.includes('..')) return false;
  return true;
}

// Validate a git hash (full or short)
const SAFE_HASH_RE = /^[a-f0-9]{4,40}$/;
function validateHash(hash) {
  return hash && typeof hash === 'string' && SAFE_HASH_RE.test(hash);
}

module.exports = { git, validateBranchName, validateHash };
