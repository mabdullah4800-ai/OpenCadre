// OpenCadre secret masking for client helpers (the approval gate). Zero dependencies.
//
// The client-side copy of src/secrets.ts: text that leaves this machine (an approval request, a post-execution report,
// a notify record) has its secret-shaped substrings masked first, keeping a short prefix (agt_***, Bearer ***,
// GITHUB_TOKEN=***). Rule matching still runs on the original command. Keep in step with src/secrets.ts;
// tests/secrets.test.ts runs both over the same cases.

export const MASK = "***";

const TOKEN_RULES = [
  [/\b(Bearer)\s+(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, `eyJ${MASK}`],
  [/(agt|org|dev)_[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])/g, `$1_${MASK}`],
  [/\b(ocd|oc)_[A-Za-z0-9]{10}(?![A-Za-z0-9_-])/g, `$1_${MASK}`],
  [/\boci_[A-Za-z0-9_-]{20,}/g, `oci_${MASK}`],
  [/\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{8,}/g, `$1${MASK}`],
  [/\brk_[A-Za-z0-9]{16,}/g, `rk_${MASK}`],
  [/\b(pdl_(?:live|sdbx)_apikey_|pdl_ntfset_)[A-Za-z0-9_]{8,}/g, `$1${MASK}`],
  [/\bsk-[A-Za-z0-9_-]+/g, (match) => (/[A-Za-z0-9]{20}/.test(match) ? `sk-${MASK}` : match)],
  [/\b(gh[pousr])_[A-Za-z0-9]{20,}/g, `$1_${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, `github_pat_${MASK}`],
  [/\b(xox[abpr])-[A-Za-z0-9-]{10,}/g, `$1-${MASK}`],
  [/\bAKIA[0-9A-Z]{16}(?![0-9A-Za-z])/g, `AKIA${MASK}`],
  [/\bAIza[0-9A-Za-z_-]{35}/g, `AIza${MASK}`],
  [/\bnpm_[A-Za-z0-9]{20,}/g, `npm_${MASK}`],
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  [/(?<![\w-])(--(?:password|passwd|token|secret|api-key|api_key|apikey))\s+(?!-)("[^"]*"|'[^']*'|["'][^]*|[^\s;&|<>()`]+)/gi, `$1 ${MASK}`],
];

const ASSIGNMENT = /(?<![A-Za-z0-9_/])([A-Za-z][A-Za-z0-9_-]{0,63})(["']?)(\s*[=:]\s*)/g;
// An unterminated quoted value runs to the end of the text (newlines included) and is masked. See src/secrets.ts.
const VALUE = /"[^"]*"|'[^']*'|["'][^]*|[^\s;&|<>()`"']+/y;
const AUTH_SCHEME = /^[A-Za-z][A-Za-z-]*$/;
const AUTH_CREDENTIAL = /[ \t]+([^\s;&|<>()`"']+)/y;

const isAuthorizationName = (name) => name.toUpperCase().includes("AUTHORIZATION");

// Exactly KEY counts only outside a flag (sort --key=2 stays; KEY=x and --build-arg KEY=x mask). See src/secrets.ts.
function isSecretName(name, isFlag) {
  const n = name.toUpperCase().replace(/-/g, "_");
  return /PASSWORD|PASSWD|SECRET|CREDENTIAL|AUTHORIZATION|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/.test(n)
    || (n === "KEY" && !isFlag)
    || /(^|_)(AUTH|TOKEN)(_|$)/.test(n)
    || /TOKEN$/.test(n);
}

function maskAssignments(text) {
  let out = "";
  let last = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) {
    if (!isSecretName(m[1], text[m.index - 1] === "-")) continue;
    const end = m.index + m[0].length;
    VALUE.lastIndex = end;
    const value = VALUE.exec(text);
    if (!value) continue;
    let start = end;
    let stop = end + value[0].length;
    // "Authorization: Basic dXNlcjpwYXNz": keep the scheme, mask the credential after it.
    if (isAuthorizationName(m[1]) && AUTH_SCHEME.test(value[0])) {
      AUTH_CREDENTIAL.lastIndex = stop;
      const credential = AUTH_CREDENTIAL.exec(text);
      if (credential) {
        start = stop + credential[0].length - credential[1].length;
        stop += credential[0].length;
      }
    }
    const token = text.slice(start, stop);
    const quote = start === end && (token[0] === '"' || token[0] === "'") ? token[0] : "";
    const closed = quote && token.length > 1 && token.endsWith(quote) ? quote : "";
    out += text.slice(last, start) + quote + MASK + closed;
    last = stop;
    ASSIGNMENT.lastIndex = last;
  }
  return out + text.slice(last);
}

/** The text with every secret-shaped substring masked. */
export function maskSecrets(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [pattern, replacement] of TOKEN_RULES) out = out.replace(pattern, replacement);
  return maskAssignments(out);
}
