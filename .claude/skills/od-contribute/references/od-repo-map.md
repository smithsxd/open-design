# OD repo map — what goes where

Mirrors `nexu-io/open-design` `CONTRIBUTING.md` so the skill doesn't need to re-fetch it on every run. **If this drifts from upstream CONTRIBUTING.md, upstream wins** — re-read the live file when in doubt.

## Contribution surfaces (per OD's CONTRIBUTING.md + plugins/ guides)

| If you want to… | You're really adding | Where it lives | Ship size |
|---|---|---|---|
| Make OD render a new kind of artifact | a **Skill** | `skills/<your-skill>/` | one folder, ~2 files |
| Make OD speak a new brand's visual language | a **Design System** | `design-systems/<brand>/DESIGN.md` | one Markdown file |
| Wrap a self-contained agent skill + OD marketplace metadata into a portable bundle | a **Plugin** | `plugins/community/<plugin-id>/` (community contributions, default) — or `plugins/spec/examples/<plugin-id>/` for spec-illustrating examples | one folder, 4–8 files |
| Hook up a new coding-agent CLI | an **Agent adapter** | `apps/daemon/src/agents.ts` | ~10 lines (code — out of scope for this skill) |
| Improve docs, port a section to fr / de / zh-CN, fix typos | docs | `README.md`, `README.fr.md`, `README.de.md`, `README.zh-CN.md`, `docs/`, `QUICKSTART.md` | one PR |

## Localized doc files we know about

| Doc family | English source | Translations seen on disk (as of plan time) |
|---|---|---|
| README | `README.md` | ar, de, es, fr, ja-JP, ko, pt-BR, ru, tr, uk, zh-CN, zh-TW |
| QUICKSTART | `QUICKSTART.md` | de, fr, ja-JP, pt-BR, zh-CN, zh-TW |
| CONTRIBUTING | `CONTRIBUTING.md` | de, fr, ja-JP, pt-BR, zh-CN |
| MAINTAINERS | `MAINTAINERS.md` | de, fr, ja-JP, pt-BR, zh-CN |

The skill `discover-i18n-gaps.sh` does NOT trust this table — it scans the workspace at runtime. Use this list only when you need to seed an `AskUserQuestion` card without a workspace.

## Issue templates

- `bug-report.yml` — required fields: description, steps to reproduce, expected, version, platform.
- `feature-request.yml` — out of scope for this skill (feature requests should come from product, not auto-routed.)
- `preview-v0.8.0-feedback.yml` — branch-specific.

## Plugin authoring quick reference

For the 🧩 plugin contribution branch (Step 3e), the relevant in-tree material is:

- `plugins/AGENTS.md` — agent-facing rules (read this before touching anything under plugins/).
- `plugins/spec/SPEC.md` + `plugins/spec/CONTRIBUTING.md` — full spec + review checklist.
- `plugins/spec/templates/` — `SKILL.template.md`, `open-design.template.json`, `README.template.md`, `README.template.zh-CN.md`, `evals.template.json`. The skill's `scaffold-plugin.sh` reads these at runtime.
- `docs/schemas/open-design.plugin.v1.json` — JSON schema. The skill's `validate-plugin.sh` mirrors the required-field and path-resolution checks.
- Existing examples to learn from: `plugins/_official/examples/*` (read-only — first-party only), `plugins/community/import-smoke-test/`.

Do **not** scaffold under `plugins/_official/` — that's reserved for first-party bundled plugins; OD's `plugins/AGENTS.md` is explicit about this.

## Out-of-scope surfaces (don't touch from this skill)

- `apps/daemon/src/` — daemon code. Requires real review.
- `apps/web/src/` — web app code. Requires real review.
- `packages/`, `tools/` — internal libs.
- `plugins/_official/` and `plugins/registry/` — first-party / marketplace catalog. Community plugins go to `plugins/community/<id>/` instead (handled by Step 3e).
- `e2e/` — Playwright-driven; non-trivial to author.

If a user asks to contribute to those surfaces, suggest the original `auto-github-contributor` skill (TDD pipeline) instead.
