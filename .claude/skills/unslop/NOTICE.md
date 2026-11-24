# Notice

This folder is a modified copy of **unslop** by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)).

- Source: https://github.com/heydamir/unslop
- Pinned commit: `4652254daff586ff4739849395a127b56f7f8cc7` (`main` on the fetch date)
- Fetched: 2026-10-31, through the GitHub contents API at that commit
- License: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/), full text in [LICENSE](LICENSE). Citation details are in [CITATION.cff](CITATION.cff).

The same copy lives in `.agents/skills/unslop/` (Codex, Cursor) and `.claude/skills/unslop/` (Claude Code); `tests/agent-skills.test.ts` keeps the two identical. OpenCadre's condensed rules are in [docs/ui-rules.md](../../../docs/ui-rules.md).

## Changes from the original

- **Not included:** `skills/unslop/scripts/snapshot.mjs` and `skills/unslop/scripts/story.mjs` (they drive Playwright and launch browsers), every image (`references/refs/*.webp`, `examples/assets/blob.webp`), the `examples/` folder and `.gitignore`.
- **Moved:** upstream's `skills/unslop/SKILL.md` and `skills/unslop/references/*.md` sit at `SKILL.md` and `references/*.md` here. `LICENSE`, `CITATION.cff` and `README.md` come from the upstream root.
- **SKILL.md:**
  - Added a note under the frontmatter saying this is a modified copy and that `docs/ui-rules.md` wins where the two differ.
  - Run it, step 1: the live-site bullet that ran `scripts/snapshot.mjs <url>` now says the script is not included and to ask the operator for the source or a screenshot.
  - Run it, step 8: says the story video cannot be rendered from this copy.
  - Story video: the link to `story-dashboard-frames.webp` now says the image is not included.
  - Story video, step 8 (Render): replaced. Upstream runs `scripts/story.mjs` with Playwright and ffmpeg and offers an install command; this copy says the script is not included, not to fetch it or install those tools, and to stop at the story file.
- **references/refs.md:** added a note that the five images it lists are not included.
- **README.md:** added a note that the Install steps do not apply here, and removed the hero image line.
- `references/signs.md`, `tokens.md`, `visuals.md`, `effects.md`, `LICENSE` and `CITATION.cff` are byte-for-byte upstream.
