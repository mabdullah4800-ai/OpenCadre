// Agent names and operator-owned profiles (sessions PR1; Codex-OpenCadre-049a's rulings of 2026-09-30).
//
// A PROFILE is the stable name a person gives: "Atlas". It is unique in its workspace (ignoring case) and is display
// metadata only. It is never an identity, a key, a mailbox or an authority. Each chat stays its own immutable session
// row. Once a person names it into a profile, the session's ADDRESS is "<profile> #<n>": n comes from the profile's
// counter, and no number is ever handed out twice. So two concurrent chats are "Atlas #1" and "Atlas #2", with two ids,
// two mailboxes and two sets of claims, and a late message to an ended session's address can never reach a newer one.
//
// An ADDRESS (agents.name) is never reassigned (ruling of 2026-09-30): a name any agent in the workspace holds or ever held,
// removed agents included, is refused. agent_addresses records them, and its primary key, written by triggers on every
// insert and rename of an agent (migration 55), makes that a database guarantee rather than a service convention.
import { randomInt } from "node:crypto";
import { db } from "./db.js";
import { confusablePrototypes, smallCapitalLetters } from "./confusables.js";

/** Short, neutral, pronounceable words for a session nobody has named yet. A fixed list rather than a syllable
 * generator, so no combination can come out offensive. Each is a plain English word, capitalised, 3 to 7 letters. */
export const NAME_WORDS: readonly string[] = [
  "Acorn", "Adler", "Alder", "Amber", "Anchor", "Apex", "Arbor", "Arch", "Aspen", "Atlas", "Aurora", "Badger", "Basil", "Beacon",
  "Birch", "Bison", "Blaze", "Bolt", "Bramble", "Brook", "Cabin", "Cairn", "Canyon", "Cedar", "Chalk", "Cinder", "Clay",
  "Clover", "Cobalt", "Comet", "Copper", "Coral", "Cove", "Crane", "Crest", "Cypress", "Dawn", "Delta", "Drift", "Dune",
  "Eagle", "Ember", "Falcon", "Fern", "Fjord", "Flint", "Forge", "Fox", "Frost", "Gale", "Garnet", "Glade", "Granite",
  "Grove", "Harbor", "Hawk", "Hazel", "Heath", "Heron", "Hollow", "Indigo", "Iris", "Island", "Ivy", "Jade", "Jasper",
  "Juniper", "Kestrel", "Kite", "Lagoon", "Lark", "Laurel", "Ledge", "Linden", "Lotus", "Lumen", "Lynx", "Maple", "Marble",
  "Marsh", "Meadow", "Mesa", "Mica", "Mint", "Moss", "Nectar", "Nimbus", "Noble", "Nova", "Oak", "Oasis", "Ochre", "Olive",
  "Onyx", "Opal", "Orbit", "Osprey", "Otter", "Pebble", "Pepper", "Pilot", "Pine", "Pixel", "Plume", "Polar", "Poplar",
  "Prism", "Quail", "Quartz", "Quill", "Rain", "Raven", "Reed", "Ridge", "River", "Robin", "Rowan", "Ruby", "Rune", "Saffron",
  "Sage", "Sequoia", "Shale", "Sierra", "Slate", "Sorrel", "Sparrow", "Spruce", "Star", "Stone", "Summit", "Swift",
  "Tamarin", "Tansy", "Teal", "Thistle", "Thorn", "Tide", "Timber", "Topaz", "Trail", "Tundra", "Umber", "Vale", "Vega",
  "Velvet", "Violet", "Vista", "Walnut", "Wave", "Willow", "Wren", "Yarrow", "Zenith", "Zephyr",
];

/** A random word from NAME_WORDS. Injectable in tests. */
export const randomWord = (): string => NAME_WORDS[randomInt(NAME_WORDS.length)];

/** A session name nobody chose: "<ClientLabel>-<Project>-<4 hex>", the shape every session had before names. Sessions
 * whose name still has this shape get the one-time naming prompt; a keyed agent never does (ruling Q5). */
export const LEGACY_SESSION_NAME = /^[A-Za-z]+-.+-[0-9a-f]{4}$/;

/** Profile names are what a person types, so they get the agent-name rules plus one more: no "#", which the address
 * uses to number sessions. Shorter than an agent name, to leave room for " #<n>". */
export const MAX_PROFILE_NAME_CHARS = 60;

export class ProfileNameError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

/** How names compare: surrounding space ignored, case folded (Unicode-aware, in JS). Stored as name_key. */
export const nameKey = (name: string) => name.trim().toLowerCase();

/** The session address for the n-th session a profile has had. */
export const profileAddress = (profileName: string, n: number) => `${profileName} #${n}`;

/** Whether a name (ignoring case and surrounding space) is an address another agent holds or ever held, removed agents
 * included. `selfId`, when given, is the agent being renamed: its own current and past addresses stay its own. Compared
 * in JS, not with SQLite's lower(), which folds ASCII only: "Ärger" and "ärger" are the same name. */
export function addressHeld(orgId: string, name: string, selfId?: string): boolean {
  const key = nameKey(name);
  const holders = db.prepare(
    `SELECT name FROM agent_addresses WHERE org_id = ? AND agent_id IS NOT ?
     UNION ALL SELECT name FROM agents WHERE org_id = ? AND id IS NOT ?`,
  ).pluck().all(orgId, selfId ?? null, orgId, selfId ?? null) as string[];
  return holders.some((n) => nameKey(n) === key);
}

// --- Names that can't pass for another agent (slice 2; round 3 S1-S3; round 4: UTS #39 and ROBIN's corpus) -------------
// A name comes from a person, a client's display name or an app's client_name, so any could imitate a trusted agent.
// ONE validator (nameProblem + lookalikeHeld) judges every name being set: checkAgentName (create, rename, connect codes,
// seeds, member agents, sessions, OAuth) and a profile's name (checkProfileNameShape + src/devices.ts nameSession). A
// name is refused when it:
//  - holds a code point that is unassigned, private-use, a lone surrogate, a line or paragraph separator (unusable);
//  - holds a character nobody sees: a format or default-ignorable code point, the braille blank (invisible); a ZWNJ is
//    allowed only between letters of the scripts that need it (Arabic and the Indic scripts);
//  - holds a blank other than an ordinary space (blank);
//  - holds an emoji (operator decision, 2026-10-31: no emoji in names; digits, # and * alone are fine);
//  - starts with a combining mark, stacks more than three, or repeats one on the same letter (mark);
//  - mixes scripts beyond UTS #39 "Highly Restrictive" (mixed);
//  - looks like a name held now or before, a profile's, or a reserved one (lookalikeHeld, three keys below).
// A DERIVED name (a member agent's from a display name, an OAuth default from client_name) is made safe instead
// (safeNameBase), then suffixed if it still collides: sign-up and connecting an app never fail on a name.
// The skeleton data is Unicode's confusables.txt (src/confusables.ts, scripts/build-confusables.mjs). Exact routing
// by name (src/service.ts, name = ?) cannot be fooled either: a lookalike of a held name is never created.
// Length is counted in UTF-16 units (MAX_AGENT_NAME_CHARS), as the database and every client count it.

const UNUSABLE = /[\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const UNUSABLE_ALL = /[\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;
/** Every character that is never seen in a name: format characters (\p{Cf}: the soft hyphen, zero-width and bidi
 * controls, tag characters...), default-ignorable code points (variation selectors, the combining grapheme joiner, the
 * Hangul fillers U+115F, U+1160, U+3164 and U+FFA0...), and three that are neither but show as nothing: the braille
 * blank U+2800, the Tifinagh consonant joiner U+2D7F and the Khitan filler U+16FE4. Written as escapes: the source never
 * holds one of them. */
export const INVISIBLE_CHARS = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\u2d7f\u{16fe4}]/u;
const INVISIBLE_CHARS_ALL = new RegExp(INVISIBLE_CHARS.source, "gu");
const ZWNJ = "\u200c";
const ZWJ = "\u200d";
/** Scripts whose spelling needs a zero-width non-joiner between letters (Persian, Urdu, the Indic scripts). */
const ZWNJ_CONTEXT = /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]$/u;
/** Scripts whose spelling needs a zero-width joiner between letters (the Indic scripts and Sinhala: conjuncts, chillus). */
const ZWJ_CONTEXT = /^[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]$/u;
/** A blank that is not an ordinary space (no-break, ideographic, ogham, the en and em spaces...). */
const ODD_BLANK = /(?! )\p{Zs}/u;
/** Emoji: pictographs, emoji-presentation characters (regional indicators and skin tones among them), and the keycap
 * mark. A digit, # or * on its own is not one. */
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u20e3]/u;
const EMOJI_ALL = new RegExp(EMOJI.source, "gu");
/** The copyright, registered and trade mark signs: pictographic by property, but shown as text by default (with VS16
 * they would be emoji, and VS16 is refused as invisible). */
const TEXT_SYMBOLS = new Set([0xa9, 0xae, 0x2122]);
const isEmoji = (ch: string) => EMOJI.test(ch) && !TEXT_SYMBOLS.has(ch.codePointAt(0)!);
const hasEmoji = (name: string) => [...name].some(isEmoji);
const LEADING_MARK = /^\p{M}/u;
const MAX_MARKS_IN_A_ROW = 3;
const TOO_MANY_MARKS = new RegExp(`\\p{M}{${MAX_MARKS_IN_A_ROW + 1}}`, "u");
const REPEATED_MARK = /(\p{M})\1/u;

/** The viramas of the scripts in ZWJ_CONTEXT (Devanagari to Malayalam, and the Sinhala al-lakuna). */
const VIRAMAS = new Set([0x94d, 0x9cd, 0xa4d, 0xacd, 0xb4d, 0xbcd, 0xc4d, 0xccd, 0xd4d, 0xdca].map((c) => String.fromCodePoint(c)));

/** Each invisible character is refused, except a ZWNJ or ZWJ between two letters (or marks) of a script that uses it,
 * and a ZWJ after a virama at the end of a word: a chillu written the way Malayalam wrote it before Unicode 5.1. */
function invisibleOutsideContext(name: string): boolean {
  const points = [...name];
  const between = (i: number, context: RegExp) => i > 0 && i < points.length - 1 && context.test(points[i - 1]) && context.test(points[i + 1]);
  const chillu = (i: number) => i > 0 && VIRAMAS.has(points[i - 1]) && (i === points.length - 1 || !/^[\p{L}\p{M}\p{Cf}]$/u.test(points[i + 1]));
  return points.some((ch, i) => INVISIBLE_CHARS.test(ch) && !(ch === ZWNJ && between(i, ZWNJ_CONTEXT)) && !(ch === ZWJ && (between(i, ZWJ_CONTEXT) || chillu(i))));
}

/** A combining mark that belongs to a script (a Thai vowel sign, a Hebrew accent) on a letter of another script, or on
 * no letter: it changes nothing a reader sees in that script, so it only makes a name look like another. Marks of no
 * script of their own (accents, the Japanese voicing marks) are judged by the other rules. */
function foreignMark(decomposed: string): boolean {
  let base: string | null = null;
  for (const ch of decomposed) {
    if (!/^\p{M}$/u.test(ch)) {
      base = ch;
      continue;
    }
    const markScript = scriptOfAny(ch);
    if (markScript && (base === null || scriptOfAny(base) !== markScript)) return true;
  }
  return false;
}

export type NameProblem = "unusable" | "invisible" | "blank" | "emoji" | "mark" | "mixed" | "noletter";
/** Why a name being set can't be accepted as written, or null. Ask it only after the length check: every test here is
 * linear in the name. */
export function nameProblem(name: string): NameProblem | null {
  if (UNUSABLE.test(name)) return "unusable";
  if (invisibleOutsideContext(name)) return "invisible";
  if (ODD_BLANK.test(name)) return "blank";
  if (hasEmoji(name)) return "emoji";
  const decomposed = name.trim().normalize("NFD");
  if (LEADING_MARK.test(decomposed) || TOO_MANY_MARKS.test(decomposed) || REPEATED_MARK.test(decomposed) || foreignMark(decomposed)) return "mark";
  if (mixesScripts(name)) return "mixed";
  // Punctuation or symbols only ("+++", "!!"): nothing to read or to compare (its key without separators is empty).
  if (!/[\p{L}\p{N}]/u.test(name)) return "noletter";
  return null;
}
/** Kept for callers that only ask about the characters (not the scripts). */
export function unreadableChar(name: string): NameProblem | null {
  const problem = nameProblem(name);
  return problem === "mixed" ? null : problem;
}

/** The vertical presentation forms of the em and en dash: NFKC turns them into dashes, though they show as a vertical
 * line. The em dash's has a UTS #39 prototype (l), which it becomes; the en dash's has none, so it is dropped. */
const VERTICAL_DASHES = /[\ufe31\ufe32]/gu;
const fromVerticalDashes = (s: string) => s.replace(VERTICAL_DASHES, (ch) => (ch === "\ufe31" ? confusablePrototypes().get(0xfe31) ?? "" : ""));

/** A display name made safe to offer and to compare: the vertical dashes read as what they show, NFKC, invisible and
 * unusable characters removed, control characters and line breaks as spaces, runs of space as one, and no combining
 * mark left at its start. */
export function cleanName(raw: string): string {
  return fromVerticalDashes(raw).normalize("NFKC").replace(INVISIBLE_CHARS_ALL, "").replace(UNUSABLE_ALL, " ").replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ").trim().replace(/^\p{M}+/u, "").trim();
}

/** Letters a reader takes for others, before comparing: sharp s, the dotted capital I and the dotless small i (as code
 * points: the source holds no lookalike character). Long s needs nothing here: NFKC reads it as s, its UTS #39
 * prototype is f, and both readings are keys (nameKeys). */
const FOLD_SPECIALS = new Map<number, string>([[0xdf, "ss"], [0x1e9e, "SS"], [0x130, "I"], [0x131, "i"]]);
const foldSpecials = (s: string) => [...s].map((ch) => FOLD_SPECIALS.get(ch.codePointAt(0)!) ?? ch).join("");

const BACKSLASH = String.fromCharCode(92);
/** Letter groups read as one letter that confusables.txt cannot list (its sources are single code points): two slash
 * pairs or "vv" for w, one slash pair for v. ("rn" for m needs nothing: the data maps m to rn.) "cl" for d and "nn" for
 * m are left out, as UTS #39 leaves them: they would make Clay and Day, Anna and Arna one name. The trade-off is a
 * known gap, accepted (re-review of 1459a120, R3): "Coclex" is not refused as a lookalike of a held Codex. Against the
 * reserved words only, both folds apply (NameKeys.reserved: "Aclmin" is Admin). */
const PAIR_FOLDS: ReadonlyArray<readonly [string, string]> = [
  [`${BACKSLASH}/${BACKSLASH}/`, "w"], [`${BACKSLASH}/`, "v"], ["vv", "w"], ["VV", "W"],
];
const foldPairs = (s: string) => PAIR_FOLDS.reduce((t, [from, to]) => t.split(from).join(to), s);
/** Scripts whose combining marks a comparison drops: an accent on a Latin, Greek or Cyrillic letter is the same letter
 * to a reader (José is Jose), and a mark of another script on one is refused anyway (foreignMark). Elsewhere a mark is
 * part of the spelling (the Devanagari vowel sign that tells Kiran from Karan, the kana voicing mark that tells gaku from
 * kaku): kept. A mark
 * on no letter, or on a Common or Inherited one (a digit, a sign), is dropped too. */
const MARKS_DROPPED_ON = new Set(["Latin", "Greek", "Cyrillic"]);
function dropAccents(s: string): string {
  let out = "";
  let dropping = true;
  for (const ch of s.normalize("NFD")) {
    if (/^\p{M}$/u.test(ch)) {
      if (!dropping) out += ch;
      continue;
    }
    const script = scriptOfAny(ch);
    dropping = script === null || MARKS_DROPPED_ON.has(script);
    out += ch;
  }
  return out;
}
/** What a comparison key leaves out: blanks, every punctuation mark and symbol (so "Grok:Bot", "Atlas™" and "Support!"
 * are "GrokBot", "Atlas" and "Support"), and the modifier-letter apostrophes U+02BC and U+02BB. The signs ©, ® and ™
 * stay allowed in a name to show; they never make it another name. */
const SEPARATORS = /[\s\p{P}\p{S}\u02bc\u02bb]/gu;

/** UTS #39 section 4: NFD, each code point to its prototype (confusables.txt), NFD again. */
export function skeleton(s: string): string {
  const prototypes = confusablePrototypes();
  return [...s.normalize("NFD")].map((ch) => prototypes.get(ch.codePointAt(0)!) ?? ch).join("").normalize("NFD");
}

/** Latin small capitals to their capital letters (UnicodeData names): confusables.txt leaves them as lookalikes of other
 * letters (small capital M to a turned w). */
const fromSmallCapitals = (s: string) => {
  const capitals = smallCapitalLetters();
  return [...s].map((ch) => capitals.get(ch.codePointAt(0)!) ?? ch).join("");
};
/** One step of the comparison form: accents off (before the prototypes, since some marks map to letters), small
 * capitals to their letters, the skeleton, accents off again, letter groups folded; and, for a folded key, lower-cased
 * last, after the skeleton has read a capital I as l (so "ELI" folds to "ell", but "Eli" to "eli"). */
const canonStep = (s: string, fold: boolean) => {
  const t = foldPairs(dropAccents(skeleton(fromSmallCapitals(dropAccents(s)))));
  return fold ? t.toLowerCase() : t;
};
/** canonStep until it no longer changes (a folded group, or lower-casing, can make a new confusable), then the small m
 * as rn: the data maps m to rn, and a fold can make a new m. */
function canon(s: string, fold = false): string {
  let current = s;
  for (let i = 0; i < 6; i++) {
    const next = canonStep(current, fold);
    if (next === current) break;
    current = next;
  }
  return current.replace(/m/g, "rn");
}

/** The name's text, read two ways: after NFKC (fullwidth forms, ligatures, math letters fold) and without it, since NFKC
 * can turn a character into one whose prototype differs (a lunate sigma into a plain sigma, long s into s, the trade
 * mark sign into "TM"). */
function cleanRaw(raw: string): string {
  return raw.normalize("NFD").replace(INVISIBLE_CHARS_ALL, "").replace(UNUSABLE_ALL, " ").replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ").trim().replace(/^\p{M}+/u, "").trim();
}
function readings(name: string): string[] {
  const nfkc = foldSpecials(cleanName(name));
  const raw = foldSpecials(cleanRaw(name));
  return nfkc === raw ? [nfkc] : [nfkc, raw];
}

export interface NameKeys {
  /** The cleaned, lower-cased name. */
  fold: string;
  /** Every comparison form, each also without separators, in two kinds that are compared only with their own kind:
   *  - "c:" CASED: each reading as written, lower-cased and upper-cased, through canon, case kept as UTS #39 keeps it;
   *    and its skeleton upper-cased. The case variants find "ADMlN" in ADMIN and "OLlVE" in OLIVE.
   *  - "f:" FOLDED: each reading as written, lower-cased after the skeleton. It finds a whole-script copy written in
   *    mixed case (a Cyrillic "ATlas" is atlas).
   * In both kinds i and l are one letter (S2). Two names collide when their sets share any key. */
  keys: ReadonlySet<string>;
  /** `keys`, and each folded key again with "cl" as d and "nn" as m ("l:"): compared with the reserved names only, so
   * "Aclmin" and "Adnnin" are Admin while Clay and Day, Anna and Arna stay two names. */
  reserved: ReadonlySet<string>;
}
/** How many times nameKeys worked a name's keys out rather than finding them kept: for the tests (a held name's keys
 * are worked out once, not on every call). */
export const nameKeyStats = { computed: 0 };
/** Keys already worked out, least recently used first (a Map keeps insertion order; a hit moves its entry to the end).
 * Bounded: past the bound, the least recently used entry goes, one at a time, never the whole cache. */
export const MAX_KEPT_NAME_KEYS = 200_000;
const keyCache = new Map<string, NameKeys>();
/** The forms a name is compared in (see NameKeys). Names never change, so their keys are kept (see keyCache). */
export function nameKeys(name: string): NameKeys {
  const cached = keyCache.get(name);
  if (cached) {
    keyCache.delete(name);
    keyCache.set(name, cached);
    return cached;
  }
  nameKeyStats.computed++;
  const keys = new Set<string>();
  const reserved = new Set<string>();
  const add = (set: Set<string>, kind: string, body: string) => {
    set.add(`${kind}:${body}`);
    set.add(`${kind}:${body.replace(SEPARATORS, "")}`);
  };
  // i and l are one letter in every key (S2, the operator's "no lookalike residuals"): Eli and Ell, Mila and Mlla are one
  // name, an accepted over-refusal whose 409 names the other agent. (A capital I is already l in the skeleton.)
  const addHeld = (kind: string, body: string) => add(keys, kind, body.replace(/i/g, "l"));
  for (const text of readings(name)) {
    for (const variant of [text, text.toLowerCase(), text.toUpperCase()]) addHeld("c", canon(variant));
    // The skeleton upper-cased: a lookalike whose prototype is a small letter (an APL iota is i, a script m is m) next
    // to capitals ("ROBIN" written with one) compares with the name in capitals (S1).
    addHeld("c", canon(skeleton(fromSmallCapitals(text)).toUpperCase()));
    const folded = canon(text, true);
    addHeld("f", folded);
    add(reserved, "l", folded.replace(/cl/g, "d").replace(/nn/g, "rn").replace(/i/g, "l"));
  }
  for (const key of keys) reserved.add(key);
  const result: NameKeys = { fold: foldSpecials(cleanName(name)).toLowerCase(), keys, reserved };
  if (keyCache.size >= MAX_KEPT_NAME_KEYS) keyCache.delete(keyCache.keys().next().value!);
  keyCache.set(name, result);
  return result;
}
const overlaps = (a: NameKeys, b: NameKeys) => [...a.keys].some((k) => b.keys.has(k));
/** Overlap as a reserved name is compared: with i read as l in the folded keys too. */
const overlapsReserved = (a: NameKeys, b: NameKeys) => [...a.reserved].some((k) => b.reserved.has(k));
/** Whether a key of `token` starts with, ends with (or ends with its plural) or contains a key of `word` of the same
 * kind (reserved keys). */
function keyHolds(token: NameKeys, word: NameKeys, how: "starts" | "ends" | "contains"): boolean {
  for (const k of token.reserved) {
    const kind = k.slice(0, 2);
    const body = k.slice(2);
    for (const w of word.reserved) {
      if (!w.startsWith(kind)) continue;
      const part = w.slice(2);
      if (!part) continue;
      // At the end, a plural counts too ("sysadmins", as "sysadmin").
      const ends = () => body.endsWith(part) || body.endsWith(`${part}s`) || body.endsWith(`${part}S`);
      if (how === "starts" ? body.startsWith(part) : how === "ends" ? ends() : body.includes(part)) return true;
    }
  }
  return false;
}
/** Kept for callers that compare one form only: the cleaned, lower-cased name. */
export const foldName = (name: string) => nameKeys(name).fold;

/** Names nobody may take, nor any lookalike of: the hub's own words, and the role and support words a person could
 * mistake for the hub's. The hub mints "Operator" itself (src/waitlist.ts), through registerAgent's `system` option. */
export const RESERVED_NAMES: readonly string[] = [
  "Operator", "OpenCadre", "Admin", "Administrator", "System", "Root", "Hub", "Support", "Security", "Owner",
];
/** The hub's own name, refused anywhere in a name, glued to other words or not ("MyOpenCadre", "OpenCadreBot"). */
const CONTAINED_WORD = "OpenCadre";
/** The hub's role words, refused as any word of a name, and at the start or end of one ("AdminTeam", "SysAdmin",
 * "OperatorBot", "Admins"), except in the ordinary words below. The common words (Root, Hub, Support, Security, Owner)
 * are refused only as the whole name (punctuation and signs aside: "Support!"), so "Support Team" and "Hubert" stay. */
const AFFIX_WORDS: readonly string[] = ["Administrator", "Operator", "Admin", "System"];
/** Ordinary words that start or end with a role word, judged as a whole word (camelCase and hyphens joined first:
 * "EcoSystem", "Co-operator"). The coordinator's list, and what a check of the 30,000 most common English Wikipedia
 * words (zxcvbn's english_wikipedia.txt) added: administratively, administrated, systematics, microsystem(s),
 * filesystem(s). */
const ORDINARY_WORDS: readonly string[] = [
  "administer", "administers", "administered", "administering", "administration", "administrations", "administrative",
  "administratively", "administrated", "systems", "systematic", "systematically", "systematics", "systemic",
  "systemically", "ecosystem", "ecosystems", "subsystem", "subsystems", "microsystem", "microsystems", "filesystem",
  "filesystems", "operators", "cooperator", "cooperators", "co-operator", "co-operators",
  // Tools named after the words.
  "systemd", "systemctl", "adminer",
];
/** The plurals among the ordinary words, which on their own (or with one generic word: "Operators Team") read as the
 * role word they are the plural of. With any other word they are ordinary ("Operators Guild", "Systems Lab"). */
const PLURAL_ROLES: ReadonlyArray<readonly [string, string]> = [["Operators", "Operator"], ["Systems", "System"]];
const GENERIC_WORDS: readonly string[] = ["Team", "Bot", "Desk", "Staff", "Group", "Crew", "Agent", "Agents"];
const keysOfAll = (words: readonly string[]) => new Set(words.flatMap((w) => [...nameKeys(w).keys]));
let ordinaryKeys: ReadonlySet<string> | null = null;
const isOrdinary = (token: NameKeys) => [...token.keys].some((k) => (ordinaryKeys ??= keysOfAll(ORDINARY_WORDS)).has(k));
/** The role word (longest first) a word starts with (or, `atEnd`, ends with), or null. */
function affixWord(token: NameKeys, atEnd: boolean): string | null {
  return AFFIX_WORDS.find((word) => keyHolds(token, nameKeys(word), atEnd ? "ends" : "starts")) ?? null;
}
/** A number added to a name: " 2", " (2)", " #2". */
const NUMBER_SUFFIX = /\s*(?:\(\d+\)|#\d+|\d+)$/u;
const WORD_BREAK = /[\s\p{P}\p{S}\u02bc\u02bb]+/u;
/** WORD_BREAK but for hyphens: the pieces an ordinary word is looked for in ("Co-operator"). */
const CHUNK_BREAK = /(?:(?![-\u2010\u2011])[\s\p{P}\p{S}\u02bc\u02bb])+/u;
const HYPHENS = /[-\u2010\u2011]/gu;
const NOT_A_LETTER = /[^\p{L}\p{M}]+/u;
/** A lower-case letter then a capital: where "SysAdmin" and "OperatorBot" split. */
const CAMEL_BREAK = /(?<=\p{Ll})(?=\p{Lu})/u;
/** Four or more one-letter words in a row ("A d m i n Bot") are read as one word. */
const MIN_SPELLED_OUT = 4;
const isOneLetter = (w: string) => [...w.replace(/\p{M}/gu, "")].length === 1;
function joinSpelledOut(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let j = i;
    while (j < words.length && isOneLetter(words[j])) j++;
    if (j - i >= MIN_SPELLED_OUT) {
      out.push(words.slice(i, j).join(""));
      i = j;
    } else {
      out.push(words[i]);
      i++;
    }
  }
  return out;
}
/** The ways a name splits into words: at spaces and punctuation (digits kept, the skeleton reads 0 as O), and at anything
 * not a letter (digits dropped: "Operator2"); each also at camelCase boundaries, and with spelled-out letters joined. */
function wordings(text: string): string[][] {
  const splits = [text.split(WORD_BREAK), text.split(NOT_A_LETTER)].map((w) => w.filter(Boolean));
  const camel = splits.map((words) => words.flatMap((w) => w.split(CAMEL_BREAK)).filter(Boolean));
  return [...splits, ...camel].map(joinSpelledOut);
}
/** A plural role word alone, or with one generic or reserved word ("Operators", "Operators Team", "Systems Support"): its
 * role word. */
function pluralRole(text: string): string | null {
  const words = text.split(WORD_BREAK).filter(Boolean);
  if (words.length === 0 || words.length > 2) return null;
  for (const [plural, role] of PLURAL_ROLES) {
    const at = words.findIndex((w) => overlapsReserved(nameKeys(w), nameKeys(plural)));
    if (at < 0) continue;
    const other = words.length === 2 ? words[1 - at] : undefined;
    // A generic word, or a reserved one ("Operators Hub", "Systems Support"; S4).
    const generic = (w: string) => GENERIC_WORDS.some((g) => overlaps(nameKeys(w), nameKeys(g))) || RESERVED_NAMES.some((r) => overlapsReserved(nameKeys(w), nameKeys(r)));
    if (other === undefined || generic(other)) return role;
  }
  return null;
}

/** The reserved name a name is, or holds as one of its words (or two or three in a row, run together), or starts or ends
 * a word with (AFFIX_WORDS), or holds anywhere (CONTAINED_WORD), or is the plural of alone (pluralRole); null when none.
 * Compared with i read as l as well (NameKeys.reserved). */
export function reservedWordIn(name: string): string | null {
  const contained = nameKeys(CONTAINED_WORD);
  for (const text of readings(name)) {
    const bare = text.replace(NUMBER_SUFFIX, "").trim() || text;
    const whole = nameKeys(bare);
    const exact = RESERVED_NAMES.find((r) => overlapsReserved(whole, nameKeys(r)));
    if (exact) return exact;
    if (keyHolds(whole, contained, "contains")) return CONTAINED_WORD;
    const plural = pluralRole(bare);
    if (plural) return plural;
    // Ordinary words are set aside whole, camelCase and hyphens included ("EcoSystem", "Co-operator"), before the rest
    // is split into words.
    const rest = bare.split(CHUNK_BREAK).filter((chunk) => chunk && !isOrdinary(nameKeys(chunk.replace(HYPHENS, "")))).join(" ");
    // The wordings often agree: each word, and each run of words, is judged once.
    const judged = new Set<string>();
    for (const words of wordings(rest)) {
      for (let i = 0; i < words.length; i++) {
        const first = nameKeys(words[i]);
        if (!judged.has(words[i])) {
          judged.add(words[i]);
          const word = isOrdinary(first) ? null : affixWord(first, false) ?? affixWord(first, true);
          if (word) return word;
        }
        // Two or three words run together: a role word begun in the first word and ended in a later one ("Ad Minteam",
        // "Ad Min"); one already within the first (or last) word was judged with that word.
        for (let j = i + 2; j <= Math.min(words.length, i + 3); j++) {
          const runText = words.slice(i, j).join("\u0000");
          if (judged.has(runText)) continue;
          judged.add(runText);
          const run = nameKeys(words.slice(i, j).join(""));
          const starts = affixWord(run, false);
          if (starts && affixWord(first, false) !== starts) return starts;
          const ends = affixWord(run, true);
          if (ends && affixWord(nameKeys(words[j - 1]), true) !== ends) return ends;
        }
      }
    }
  }
  return null;
}
/** Whether a name is, or holds, a reserved name (reservedWordIn). */
export const isReservedName = (name: string): boolean => reservedWordIn(name) !== null;

/** Who holds a name: a live agent, a profile, or an agent that had it (an earlier name, or a removed agent's). */
export type HolderKind = "agent" | "profile" | "former";
export interface Holder { name: string; kind: HolderKind }
/** What a workspace holds, worked out once and passed to every candidate a caller tries (a suggestion loop tries up to
 * a hundred): every key of every name its agents hold or held, removed agents included, and its profiles' names, each
 * with who holds it; and the live agents' url keys and ids, which routing looks up too. `selfId` is the agent being
 * renamed: its own names stay its own. A per-workspace cache, or keys stored with agent_addresses, is the plan's Slice 6
 * follow-up. */
export interface HeldNames { keys: ReadonlyMap<string, Holder>; routed: ReadonlyMap<string, string> }
export function heldNames(orgId: string, selfId?: string): HeldNames {
  const self = selfId ?? null;
  // Live agents first, then profiles, then earlier names: a key two of them share is named after the first.
  const holders = db.prepare(
    `SELECT name, 'agent' AS kind FROM agents WHERE org_id = ? AND id IS NOT ? AND removed_at IS NULL
     UNION ALL SELECT name, 'profile' FROM agent_profiles WHERE org_id = ?
     UNION ALL SELECT name, 'former' FROM agents WHERE org_id = ? AND id IS NOT ? AND removed_at IS NOT NULL
     UNION ALL SELECT name, 'former' FROM agent_addresses WHERE org_id = ? AND agent_id IS NOT ?`,
  ).all(orgId, self, orgId, orgId, self, orgId, self) as Holder[];
  const keys = new Map<string, Holder>();
  for (const holder of holders) for (const key of nameKeys(holder.name).keys) if (!keys.has(key)) keys.set(key, holder);
  const routes = db.prepare(`SELECT url_key, id, name FROM agents WHERE org_id = ? AND removed_at IS NULL AND id IS NOT ?`)
    .all(orgId, self) as Array<{ url_key: string; id: string; name: string }>;
  const routed = new Map<string, string>();
  for (const r of routes) {
    routed.set(r.url_key, r.name);
    routed.set(r.id, r.name);
  }
  return { keys, routed };
}

/** What a name clashes with: a name held in the workspace (by `kind`) or a reserved one, and that name (`like`). */
export interface NameClash { kind: HolderKind | "reserved"; like: string }
/** The clash of `name` with a name the workspace holds (any shared key, heldNames), a live agent's url key or id, or a
 * reserved name; null when it is free. Pass `held` when checking several candidates. */
export function nameClash(orgId: string, name: string, opts: { selfId?: string; allowReserved?: boolean; held?: HeldNames } = {}): NameClash | null {
  const keys = nameKeys(name);
  const held = opts.held ?? heldNames(orgId, opts.selfId);
  for (const key of keys.keys) {
    const holder = held.keys.get(key);
    if (holder) return { kind: holder.kind, like: holder.name };
  }
  const routedTo = held.routed.get(keys.fold);
  if (routedTo !== undefined) return { kind: "agent", like: routedTo };
  if (!opts.allowReserved) {
    const reserved = reservedWordIn(name);
    if (reserved) return { kind: "reserved", like: reserved };
  }
  return null;
}
const CLASH_WHAT: Record<NameClash["kind"], string> = {
  agent: "an agent in this workspace",
  profile: "a profile in this workspace",
  former: "a name an agent in this workspace had",
  reserved: "a reserved name",
};
/** The reason a name is refused for its clash, to show the person: "José looks like Jose, an agent in this workspace",
 * "AdminTeam looks like Admin, a reserved name", "operator is a reserved name". */
export function describeClash(name: string, clash: NameClash): string {
  if (clash.kind === "reserved" && nameKey(clash.like) === nameKey(name)) return `${name} is a reserved name`;
  // A name stored before the name rules can hold an invisible or direction character: shown without it, so it can
  // neither hide in the message nor reorder it.
  const like = clash.like.replace(INVISIBLE_CHARS_ALL, "").replace(/\p{Cc}/gu, " ");
  return `${name} looks like ${like}, ${CLASH_WHAT[clash.kind]}`;
}
/** Kept for callers that only need the kind: "held" (by an agent, a profile, or before), "reserved", or null. */
export function lookalikeHeld(orgId: string, name: string, opts: { selfId?: string; allowReserved?: boolean; held?: HeldNames } = {}): "held" | "reserved" | null {
  const clash = nameClash(orgId, name, opts);
  return clash === null ? null : clash.kind === "reserved" ? "reserved" : "held";
}
/** Kept for callers that only need yes or no. */
export const heldLookalike = (orgId: string, name: string, selfId?: string): boolean => lookalikeHeld(orgId, name, { selfId }) !== null;

// Scripts, for mixesScripts. A letter or digit in none of these counts as "Other". Common and Inherited are ignored.
const SCRIPT_NAMES = [
  "Latin", "Greek", "Cyrillic", "Armenian", "Hebrew", "Arabic", "Syriac", "Thaana", "Nko", "Samaritan", "Mandaic",
  "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai",
  "Lao", "Tibetan", "Myanmar", "Georgian", "Hangul", "Ethiopic", "Cherokee", "Canadian_Aboriginal", "Ogham", "Runic",
  "Tagalog", "Khmer", "Mongolian", "Limbu", "Tai_Le", "New_Tai_Lue", "Buginese", "Tai_Tham", "Balinese", "Sundanese",
  "Batak", "Lepcha", "Ol_Chiki", "Glagolitic", "Tifinagh", "Coptic", "Hiragana", "Katakana", "Bopomofo", "Han", "Yi",
  "Lisu", "Vai", "Bamum", "Javanese", "Cham", "Tai_Viet", "Meetei_Mayek", "Adlam", "Osage", "Braille", "Old_Italic",
  "Gothic", "Deseret", "Shavian", "Osmanya",
];
const SCRIPTS = SCRIPT_NAMES.map((n) => [n, new RegExp(`^\\p{Script=${n}}$`, "u")] as const);
const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;
const NEUTRAL = /^[\p{Script=Common}\p{Script=Inherited}]$/u;
/** The script of any character, or null for a Common or Inherited one. */
function scriptOfAny(ch: string): string | null {
  if (NEUTRAL.test(ch)) return null;
  return SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? "Other";
}
/** The script of a letter or decimal digit, or null for anything else and for Common or Inherited ones. */
function scriptOf(ch: string): string | null {
  if (!LETTER_OR_DIGIT.test(ch) || NEUTRAL.test(ch)) return null;
  return SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? "Other";
}
function scriptCounts(name: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of name) {
    const script = scriptOf(ch);
    if (script) counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  return counts;
}
/** UTS #39 "Highly Restrictive": one script, or Latin with the scripts written alongside it in Japanese, Chinese or
 * Korean. Han with kana or Hangul is how those languages are written; Latin with any of them is common there too. */
const ALLOWED_TOGETHER: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]), new Set(["Latin", "Han", "Bopomofo"]), new Set(["Latin", "Han", "Hangul"]),
];
const allowedTogether = (scripts: string[]) => scripts.length <= 1 || ALLOWED_TOGETHER.some((set) => scripts.every((s) => set.has(s)));
/** Letters or digits from scripts that are not written together: the tell of a lookalike ("Ops" with a Cyrillic or
 * Armenian O, "Bot" with an Arabic-Indic one). */
export const mixesScripts = (name: string): boolean => !allowedTogether([...scriptCounts(name).keys()]);

/** `text` cut to at most `maxUnits` UTF-16 units (how checkAgentName counts a name's length), dropping whole code points
 * from its end, so an emoji or other astral character is never split into half a surrogate pair. */
export function clipToUnits(text: string, maxUnits: number): string {
  const points = Array.from(text);
  let units = text.length;
  while (points.length && units > maxUnits) units -= points.pop()!.length;
  return points.join("").trimEnd();
}

/** Combining marks trimmed to what nameProblem accepts: no repeat of the same mark on a letter, at most three in a row,
 * and none of another script than its letter's. */
function tameMarks(s: string): string {
  let run = 0;
  let last = "";
  let baseScript: string | null = null;
  let out = "";
  for (const ch of s.normalize("NFD")) {
    if (/^\p{M}$/u.test(ch)) {
      const markScript = scriptOfAny(ch);
      if (ch === last || run >= MAX_MARKS_IN_A_ROW || (markScript && markScript !== baseScript)) continue;
      run++;
      last = ch;
    } else {
      run = 0;
      last = "";
      baseScript = scriptOfAny(ch);
    }
    out += ch;
  }
  return out.normalize("NFC");
}

/** A name a person or app supplied, made safe to offer as a default instead of refused: cleaned (cleanName), emoji
 * removed, marks tamed, and when its scripts are not allowed together, each letter outside the main one (the script
 * most of its letters are in) becomes its UTS #39 prototype if that is in the main script ("Ops" with an Armenian O
 * gives the Latin "Ops"), or is dropped. The result is then checked like any other name, and suffixed if it collides; empty
 * means the caller's fallback ("Member", "Connection"). */
export function safeNameBase(raw: string): string {
  const clean = tameMarks(cleanName(raw).replace(EMOJI_ALL, (ch) => (isEmoji(ch) ? " " : ch)).replace(/\s+/g, " ").trim()).replace(/^\p{M}+/u, "").trim();
  const counts = scriptCounts(clean);
  if (allowedTogether([...counts.keys()])) return clean;
  // Keep the scripts of the allowed set (or the single main script) that covers the most letters, so the result is
  // always allowed together and a derived name can never be refused for its scripts.
  const main = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const covered = (set: ReadonlySet<string>) => [...counts].reduce((n, [script, k]) => n + (set.has(script) ? k : 0), 0);
  const keep = [new Set([main]), ...ALLOWED_TOGETHER.filter((set) => set.has(main))].sort((a, b) => covered(b) - covered(a))[0];
  const fits = (script: string | null) => script === null || keep.has(script);
  const prototypes = confusablePrototypes();
  // Over the decomposed text, so a mark follows its letter: a mark whose letter was dropped goes with it.
  let keptBase = true;
  let out = "";
  for (const ch of clean.normalize("NFD")) {
    if (/^\p{M}$/u.test(ch)) {
      if (keptBase) out += ch;
      continue;
    }
    let next = ch;
    if (!fits(scriptOf(ch))) {
      const prototype = prototypes.get(ch.codePointAt(0)!);
      next = prototype && [...prototype].every((p) => fits(scriptOf(p))) ? prototype : "";
    }
    keptBase = next !== "";
    out += next;
  }
  return out.normalize("NFC").replace(/\s+/g, " ").trim().replace(/^\p{M}+/u, "").trim();
}


/** Whether a word is a profile's name in this workspace, so an unnamed session is never called what a profile is. */
export function isProfileName(orgId: string, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM agent_profiles WHERE org_id = ? AND name_key = ?`).get(orgId, nameKey(name)));
}

/** Checks a typed profile name's shape. Returns it trimmed; throws ProfileNameError (400) when malformed: the agent-name
 * rules for what can be read (nothing invisible, no odd blank, no leading mark, one script) apply too. */
export function checkProfileNameShape(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new ProfileNameError("name is required", 400);
  if (name.length > MAX_PROFILE_NAME_CHARS) throw new ProfileNameError(`name must be at most ${MAX_PROFILE_NAME_CHARS} characters`, 400);
  const problem = nameProblem(typeof raw === "string" ? raw : "");
  if (problem === "mixed") throw new ProfileNameError("name must use letters from one alphabet", 400);
  if (problem) throw new ProfileNameError("name must use only letters, numbers, spaces and punctuation", 400);
  if (/\p{Cc}/u.test(name)) throw new ProfileNameError("name must not contain control characters", 400);
  if (name.includes("#")) throw new ProfileNameError(`name must not contain "#": OpenCadre numbers each chat under a name as "${name.replaceAll("#", "").trim() || "Atlas"} #1", "#2"`, 400);
  return name;
}

/** An agent's CURRENT name, looked up by its authenticated id. What an open MCP session writes and shows after a person
 * renames the agent: a display and write-name lookup only. It never resolves anything by name, so an old name can
 * never lead to another agent, and it grants nothing (ruling on PR1's per-call name refresh). */
export function currentAgentName(orgId: string, agentId: string): string | null {
  const row = db.prepare(`SELECT name FROM agents WHERE id = ? AND org_id = ?`).get(agentId, orgId) as { name: string } | undefined;
  return row?.name ?? null;
}
