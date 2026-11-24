# UI rules

Adapted from [unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0. The full skill is vendored in `.claude/skills/unslop/` and `.agents/skills/unslop/`; [NOTICE.md](../.claude/skills/unslop/NOTICE.md) lists the pinned commit and our changes. This page is the short, enforceable version for every agent. Where the two differ, this page wins.

## Direction

- **Product:** a shared workspace where coding agents claim work and a person approves risky commands.
- **Character:** exact, calm, on-call.
- **World:** a dispatch board, flight strips.
- **Moment:** the live board with an amber waiting card.
- **Signature:** the amber wait glyph.

## Our tokens

- Chalk `#F6F6F3` (`--n-50`) and carbon `#15161A` (`--n-950`), declared once in `public/shared/tokens.css`. The console reaches them through its roles in `public/app/app.css`; `public/app/tokens.css` declares neither. The brand is mono, with no accent colour. The cyan `--chip` is the logo chip only.
- Geist for the interface and Geist Mono for figures and meta (`--font`, `--mono` in `public/shared/scale.css`).
- Amber (`--wait-*`, `--amber*`) means waiting on a person, and nothing else. Never use it for emphasis, a warning, a stale item or a computer that is connecting.
- Use the existing tokens. Do not add a literal colour, size or radius where a token exists.

## Standing rules from the operator

- No taglines, helper text or secondary labels. If a screen needs one to be understood, restructure the layout instead.
- One primary action per card or row, with at most one secondary beside it and nothing stacked under them.
- Plain words. Say what the thing does, with no hype words and no exclamation marks.

## Composition

- No rule or explanation in a tooltip, a `title=` or a hidden hint. If it matters, it is visible; otherwise it is gone.
- Quiet chrome, one rich moment. Navigation, buttons, borders and labels stay neutral; colour and detail go to the live board and its amber waiting card.
- Product visuals are real console frames with plausible data, animated with SVG or CSS where motion explains a state. No generated images or illustrations for product visuals, and no generated hero scene: this overrides the vendored skill's Layout and Visuals passes and `references/visuals.md`. Tutorials use real setup screenshots.
- Never a labelled placeholder such as "Illustrated example" or "No live workspace". Show the real thing, or leave the slot out.
- At most one entrance on load: a short fade and rise of the main content. Nothing else animates in.

## Mechanical rules

- Spacing on a 4px grid: margins, padding, gaps and fixed heights are multiples of 4. Equal things get equal sizes.
- Font weights 400 and 500, with 600 at most for rare emphasis. Hierarchy comes from size and colour, not weight. Today `scale.css` sets display and heading weights of 650 to 680 and the pages load Geist `wght@400..800`; the type pass will drop those weights to 600 and load `wght@400..600`. Until then the lint reports them.
- Sentence case everywhere. No uppercase labels with wide tracking.
- No negative letter spacing on text under 1.5rem.
- No italics, for emphasis or anything else.
- No trailing period on headings, buttons or labels. Only paragraphs of several sentences keep their periods.
- No emoji, and no ✓ or ✕ glyphs, as icons. No → arrows, ` · ` separators or em dashes in UI text. Use one line-icon set at one size and stroke, coloured by its text role.
- Name the properties you transition (`transition: background-color 140ms var(--ease-out)`), never `all`. One easing curve for entrances (`--ease-out`) and one for everything else (`--ease-standard`), both in `public/shared/scale.css`, and no other curves. Never animate width, height, top, left or margins.
- Looping motion only for live things: a spinner, a skeleton, a live status dot.
- Radius by size: controls 8, cards 12 to 16, panels and modals up to 24. Inner radius equals outer radius minus the padding between them, never below 4. Use `999px` only for avatars and dots.
- No hue gradients or colour washes. A gradient is only a tone shift between neutrals.

## The nine passes, in order

When you clean up a screen, finish each pass across the whole screen before starting the next: 1 spacing, 2 colour, 3 icons, 4 copy, 5 type, 6 layout, 7 details, 8 visuals, 9 motion. Copy comes before type and layout because a headline's length decides its size and position. Visuals and motion come last because they should fit a screen that already works without them.

## Check your work

`node scripts/ui-lint.mjs` reads the CSS in `public/app` and `public/shared`, and every `public/**/*.html`, `*.js` and `*.mjs`. It reports, per rule: weights above 600 (including `--fw-*` tokens and Geist loads above 600), uppercase, negative tracking under 1.5rem, `transition: all`, loops outside four exact live selectors, `setInterval` and `requestAnimationFrame` (for a person to judge), italics, headings ending in a period, emoji and ✓ ✕ glyphs, arrows and ` · ` separators, em dashes, placeholder copy, helper-text classes (`kicker`, `lede`, `*-note`, `field-hint`, `rule-note`), amber outside person-wait selectors, hue gradients, odd px spacing of 3 or more, and `999px` outside avatars and dots. It exits 0; `--strict` exits 1. It is not a CI gate. Do not add to its counts, and a change that touches a flagged line should clear the finding.

**Its count is an undercount.** It cannot see:

- tooltips, `title=` and hidden hints;
- composition: how many primary actions, quiet chrome, load entrances, illustrations;
- labelled placeholders other than its three phrases;
- trailing periods on buttons and labels, and sentence case in the copy itself (only `text-transform`);
- even spacing values off the 4px grid (6, 10, 14px) and spacing in rem;
- negative tracking on a rule that inherits its font size;
- values it cannot resolve: `color-mix()`, named colours, a `var()` with no declaration in the scanned CSS;
- styles that JS sets at runtime, copy JS assembles from pieces, text in CSS `content:` (apart from emoji), and text served by the API;
- anything outside `public/`.
