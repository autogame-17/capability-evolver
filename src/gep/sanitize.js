// Pre-publish payload sanitization.
// Removes sensitive tokens, local paths, emails, and env references
// from capsule payloads before broadcasting to the hub.

// Patterns to redact (replaced with placeholder)
const REDACT_PATTERNS = [
  // API keys & tokens (generic)
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /token[=:]\s*["']?[A-Za-z0-9\-._~+\/]{16,}["']?/gi,
  /api[_-]?key[=:]\s*["']?[A-Za-z0-9\-._~+\/]{16,}["']?/gi,
  /secret[=:]\s*["']?[A-Za-z0-9\-._~+\/]{16,}["']?/gi,
  /password[=:]\s*["']?[^\s"',;)}\]]{6,}["']?/gi,
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, github_pat_)
  /ghp_[A-Za-z0-9]{36,}/g,
  /gho_[A-Za-z0-9]{36,}/g,
  /ghu_[A-Za-z0-9]{36,}/g,
  /ghs_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  // AWS access keys
  /AKIA[0-9A-Z]{16}/g,
  // OpenAI / Anthropic tokens
  /sk-proj-[A-Za-z0-9\-_]{20,}/g,
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  // npm tokens
  /npm_[A-Za-z0-9]{36,}/g,
  // Slack tokens (bot/user/app/refresh/verification)
  /xox[baprsv]-[A-Za-z0-9-]{10,}/g,
  // JSON Web Tokens (header.payload.signature)
  /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]{20,}/g,
  // Azure storage connection strings (redact the key field only)
  /AccountKey=[^;\s]+/gi,
  // Discord bot tokens. Three base64url segments:
  //   1. 24+ chars starting with [MNO] (user-id snowflake, base64-encoded)
  //   2. exactly 6 chars (timestamp)
  //   3. 27+ chars (HMAC signature)
  // Requiring an uppercase leading char avoids false-matching dotted
  // lowercase identifiers (Python module paths, hostnames, etc.).
  /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
  // Private keys
  /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
  // Basic auth in URLs (redact only credentials, keep :// and @)
  /(?<=:\/\/)[^@\s]+:[^@\s]+(?=@)/g,
  // Local filesystem paths
  /\/home\/[^\s"',;)}\]]+/g,
  /\/Users\/[^\s"',;)}\]]+/g,
  /[A-Z]:\\[^\s"',;)}\]]+/g,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // .env file references
  /\.env(?:\.[a-zA-Z]+)?/g,
];

const REDACTED = '[REDACTED]';

function redactString(str) {
  if (typeof str !== 'string') return str;
  let result = str;
  for (const pattern of REDACT_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Deep-clone and sanitize a capsule payload.
 * Returns a new object with sensitive values redacted.
 * Does NOT modify the original.
 */
function sanitizePayload(capsule) {
  if (!capsule || typeof capsule !== 'object') return capsule;
  return JSON.parse(JSON.stringify(capsule), (_key, value) => {
    if (typeof value === 'string') return redactString(value);
    return value;
  });
}

// --- Leak scanning (detection without destructive replacement) ---

const LEAK_SCANNERS = [
  // API keys & tokens
  { type: 'api_key', pattern: /sk-[A-Za-z0-9]{20,}/g, suggest: 'process.env.OPENAI_API_KEY' },
  { type: 'api_key', pattern: /sk-proj-[A-Za-z0-9\-_]{20,}/g, suggest: 'process.env.OPENAI_API_KEY' },
  { type: 'api_key', pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/g, suggest: 'process.env.ANTHROPIC_API_KEY' },
  { type: 'api_key', pattern: /AKIA[0-9A-Z]{16}/g, suggest: 'process.env.AWS_ACCESS_KEY_ID' },
  { type: 'github_token', pattern: /ghp_[A-Za-z0-9]{36,}/g, suggest: 'process.env.GITHUB_TOKEN' },
  { type: 'github_token', pattern: /github_pat_[A-Za-z0-9_]{22,}/g, suggest: 'process.env.GITHUB_TOKEN' },
  { type: 'npm_token', pattern: /npm_[A-Za-z0-9]{36,}/g, suggest: 'process.env.NPM_TOKEN' },
  { type: 'slack_token', pattern: /xox[baprsv]-[A-Za-z0-9-]{10,}/g, suggest: 'process.env.SLACK_TOKEN' },
  { type: 'jwt', pattern: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]{20,}/g, suggest: 'process.env.JWT' },
  { type: 'azure_key', pattern: /AccountKey=[^;\s]+/gi, suggest: 'process.env.AZURE_STORAGE_KEY' },
  { type: 'discord_token', pattern: /\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, suggest: 'process.env.DISCORD_TOKEN' },
  { type: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9\-._~+\/]{20,}=*/g, suggest: 'process.env.AUTH_TOKEN' },
  { type: 'private_key', pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g, suggest: 'process.env.PRIVATE_KEY_PATH' },
  // Database connection strings with credentials
  { type: 'db_url', pattern: /(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s"',;)}\]]{10,}/gi, suggest: 'process.env.DATABASE_URL' },
  // Local filesystem paths with usernames
  { type: 'local_path', pattern: /\/home\/[a-zA-Z0-9_.-]+\//g, suggest: 'process.env.HOME' },
  { type: 'local_path', pattern: /\/Users\/[a-zA-Z0-9_.-]+\//g, suggest: 'process.env.HOME' },
  { type: 'local_path', pattern: /[A-Z]:\\Users\\[a-zA-Z0-9_.-]+\\/g, suggest: 'process.env.USERPROFILE' },
  // Internal IP addresses
  { type: 'internal_ip', pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?::\d{2,5})?\b/g, suggest: 'process.env.SERVICE_HOST' },
  // SSH connection strings
  { type: 'ssh_target', pattern: /[a-zA-Z0-9_.-]+@(?:(?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, suggest: 'process.env.SSH_HOST' },
  // Generic password/secret assignments
  { type: 'password', pattern: /password[=:]\s*["']?[^\s"',;)}\]]{6,}["']?/gi, suggest: 'process.env.PASSWORD' },
  { type: 'secret', pattern: /secret[=:]\s*["']?[A-Za-z0-9\-._~+\/]{16,}["']?/gi, suggest: 'process.env.SECRET' },
  // Basic auth in URLs
  { type: 'basic_auth', pattern: /:\/\/[^@\s:]+:[^@\s]+@/g, suggest: 'process.env.SERVICE_URL' },
];

const ENV_SCAN_SKIP_KEYS = new Set([
  'PATH', 'HOME', 'SHELL', 'TERM', 'LANG', 'USER', 'LOGNAME',
  'PWD', 'OLDPWD', 'SHLVL', 'HOSTNAME', 'DISPLAY', 'EDITOR',
  'PAGER', 'LESS', 'LS_COLORS', 'COLORTERM', 'TERM_PROGRAM',
  'XDG_SESSION_ID', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', '_',
]);

/**
 * Scan content for potential sensitive information leaks.
 * Returns structured results with suggested env var replacements.
 * Does NOT modify the content.
 */
function scanForLeaks(content) {
  if (typeof content !== 'string' || !content) return { found: false, leaks: [] };
  const leaks = [];
  const seen = new Set();
  for (const scanner of LEAK_SCANNERS) {
    scanner.pattern.lastIndex = 0;
    let match;
    while ((match = scanner.pattern.exec(content)) !== null) {
      const val = match[0];
      const key = scanner.type + ':' + val;
      if (seen.has(key)) continue;
      seen.add(key);
      leaks.push({ type: scanner.type, value: val.length > 60 ? val.slice(0, 57) + '...' : val, suggestion: scanner.suggest });
    }
  }
  return { found: leaks.length > 0, leaks };
}

/**
 * Reverse-detect: check if any current process.env values (length >= 8)
 * appear verbatim in the content. If so, the env var's actual value
 * has been hardcoded -- it should be replaced with the env var reference.
 */
function detectEnvValueLeaks(content) {
  if (typeof content !== 'string' || !content) return [];
  const leaks = [];
  for (const [key, val] of Object.entries(process.env)) {
    if (!val || val.length < 8) continue;
    if (ENV_SCAN_SKIP_KEYS.has(key)) continue;
    if (content.includes(val)) {
      leaks.push({ type: 'env_value_leak', envKey: key, value: val.length > 60 ? val.slice(0, 57) + '...' : val, suggestion: 'process.env.' + key });
    }
  }
  return leaks;
}

/**
 * Full leak check: pattern-based scan + env value reverse detection.
 * Returns combined results.
 */
function fullLeakCheck(content) {
  const scan = scanForLeaks(content);
  const envLeaks = detectEnvValueLeaks(content);
  const allLeaks = scan.leaks.concat(envLeaks);
  return { found: allLeaks.length > 0, leaks: allLeaks };
}

module.exports = { sanitizePayload, redactString, scanForLeaks, detectEnvValueLeaks, fullLeakCheck };
