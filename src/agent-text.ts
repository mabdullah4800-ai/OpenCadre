import { maskAndCap } from "./secrets.js";

/** Text an agent wrote (a task title, a held reason, a decision's title), made safe to print into another agent's
 * context (review of #782, H1; its verification, H1-a). Before anything else:
 * - every run of whitespace, control characters (\p{Cc}: C0, DEL and the C1 range, so U+0085 NEL and U+009B CSI) and
 *   line or paragraph separators (\p{Zl}, \p{Zp}) becomes one space, so the text can't start a line of its own (a fake
 *   "Fleet protocol:");
 * - every format character (\p{Cf}: zero-width spaces and joiners, bidi overrides and isolates such as U+202E and
 *   U+2066, U+200F, U+061C, U+2060) is removed outright: it shows nothing to a reader but can reorder what they see, or
 *   split a key so masking misses it. Emoji ZWJ sequences lose their joiner and show as their separate emoji, which is
 *   acceptable for board text.
 * Only then is it masked and clipped (so a key split by a zero-width space is masked whole), and quoted with
 * JSON.stringify, so an embedded quote can't end the quoting either. */
export function asData(text: string | null | undefined, maxChars: number): string {
  const visible = (text ?? "").replace(/\p{Cf}/gu, "").replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return JSON.stringify(maskAndCap(visible, maxChars));
}
