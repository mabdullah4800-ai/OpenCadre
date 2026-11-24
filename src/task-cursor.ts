import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The task list's paging cursor (docs/superpowers/plans/2026-09-30-task-paging.md §0 item 3).
 *
 * A cursor is `c1.<position>.<mac>`: the position is base64url JSON `{ k, r }` (the last row's sort key and seq), and
 * the MAC is HMAC-SHA256 under a server-held key over the version, the workspace, the viewer, the list's ordering, its
 * normalised filters and the position. So a cursor is only ever accepted for the exact list it was issued for, by the
 * viewer it was issued to, and cannot be edited. The MAC is checked BEFORE the position is decoded, and the position is
 * then bounded (length, character set, integer range) anyway.
 *
 * A cursor is a place in a list, never a permission: the caller re-applies the viewer's current scope before LIMIT on
 * every page (src/tasks.ts listTaskPage), so a cursor issued before a scope change reads nothing the viewer can no
 * longer see.
 *
 * The key follows the pattern of OPENCADRE_OAUTH_SECRET (src/oauth-authorize.ts): OPENCADRE_CURSOR_SECRET when it is 32+
 * characters, else a random key per process. The fallback costs only this: a restart (or a hop between processes, if
 * there is ever more than one) refuses cursors issued before it, with a 400 the console answers by starting that column
 * again from its first page. It never leaves the process and is never logged. */

const VERSION = "c1";
const SECRET_MIN_CHARS = 32;
/** A whole cursor, as the query string carries it. Real ones are ~130 characters. */
export const MAX_CURSOR_CHARS = 400;
const MAX_KEY_CHARS = 40;
/** The characters a sort key may use: timestamps as SQLite (`2026-09-30 10:00:00`) or JS (`...T...Z`) write them. */
const SORT_KEY = /^[0-9TZ:. -]*$/;

export interface CursorBinding {
  orgId: string;
  viewerId: string;
  /** The list's ordering, e.g. "created_asc" or "completed_desc". */
  order: string;
  /** The list's normalised filters, as one canonical string. */
  filters: string;
}
export interface CursorPosition {
  /** The last row's sort key (created_at, or completed_at for Done). */
  k: string;
  /** The last row's seq (tasks.seq, migration 54): the unique, never-reused tie-breaker. */
  r: number;
}

export class TaskCursorError extends Error {
  constructor() {
    super("That cursor isn't valid for this list. Start again from the first page.");
  }
}

/** The cursor key from the environment, and the problem to warn about at startup, if any. A configured value shorter than
 * SECRET_MIN_CHARS is NOT used (a weak key would be worse than a random one). */
export function cursorSecretFrom(env: NodeJS.ProcessEnv): { key: Buffer; problem: string | null } {
  const configured = env.OPENCADRE_CURSOR_SECRET ?? "";
  if (configured.length >= SECRET_MIN_CHARS) return { key: Buffer.from(configured, "utf8"), problem: null };
  return {
    key: randomBytes(32),
    problem: configured
      ? `OPENCADRE_CURSOR_SECRET is shorter than ${SECRET_MIN_CHARS} characters, so it is not used: task list cursors use a per-process key and restart from the first page after a restart`
      : null,
  };
}

let processKey: Buffer | undefined;
const serverKey = (): Buffer => (processKey ??= cursorSecretFrom(process.env).key);

function mac(binding: CursorBinding, position: string, key: Buffer): Buffer {
  // Newline-separated, and none of the parts can contain a newline that matters: ids are uuids, `order` is a constant,
  // `filters` is JSON (newlines inside strings are escaped), `position` is base64url.
  return createHmac("sha256", key)
    .update(["opencadre-task-cursor", VERSION, binding.orgId, binding.viewerId, binding.order, binding.filters, position].join("\n"))
    .digest();
}

export function signTaskCursor(binding: CursorBinding, position: CursorPosition, key: Buffer = serverKey()): string {
  const encoded = Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
  return `${VERSION}.${encoded}.${mac(binding, encoded, key).toString("base64url")}`;
}

/** The position a cursor names, or TaskCursorError when it is malformed, forged, or issued for another list or viewer. */
export function readTaskCursor(raw: string, binding: CursorBinding, key: Buffer = serverKey()): CursorPosition {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_CHARS) throw new TaskCursorError();
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new TaskCursorError();
  const [, encoded, presented] = parts;
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(presented)) throw new TaskCursorError();
  const expected = mac(binding, encoded, key);
  const given = Buffer.from(presented, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new TaskCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new TaskCursorError();
  }
  const { k, r } = (parsed ?? {}) as { k?: unknown; r?: unknown };
  if (typeof k !== "string" || k.length > MAX_KEY_CHARS || !SORT_KEY.test(k)) throw new TaskCursorError();
  if (typeof r !== "number" || !Number.isSafeInteger(r) || r < 1) throw new TaskCursorError();
  return { k, r };
}
