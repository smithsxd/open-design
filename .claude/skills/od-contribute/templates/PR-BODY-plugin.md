## Plugin

- **ID:** `{{PLUGIN_ID}}`
- **Spec version:** 1.0.0
- **Plugin version:** {{PLUGIN_VERSION}}
- **Lane:** {{LANE}}
- **Mode:** {{MODE}}
- **Source:** community (`plugins/community/{{PLUGIN_ID}}/`)

## What it does

{{DESCRIPTION}}

{{LONGER_NOTES}}

## Trigger examples

{{TRIGGER_EXAMPLES}}

## Capabilities

The manifest declares these `od.capabilities`:

{{CAPABILITIES_LIST}}

These are the minimum needed for the lane (`{{LANE}}`) and mode (`{{MODE}}`). Any externally-visible action (network publish, share, deploy) routes through a user-confirmation step.

## Validation

Performed locally before push:

- [x] `open-design.json` is valid JSON
- [x] Required fields present: `specVersion`, `name`, `version`
- [x] `SKILL.md` at plugin root with frontmatter (`name`, `description`)
- [x] All path-typed fields in the manifest resolve on disk
- [x] `od.taskKind` (lane) ∈ {create, import, export, share, deploy, refine, extend}
- [x] `od.mode` ∈ {prototype, deck, live-artifact, image, video, hyperframes, audio, design-system}
- [x] All `od.capabilities` are from the known set

Deferred to maintainer side (require workspace install):

- [ ] `pnpm guard`
- [ ] `pnpm --filter @open-design/plugin-runtime typecheck`
- [ ] `od plugin validate ./plugins/community/{{PLUGIN_ID}}` (when daemon CLI is built)

## Screenshots or example outputs

{{SCREENSHOTS_OR_EXAMPLES}}

## Registry publishing

- **Canonical source:** `nexu-io/open-design` `plugins/community/{{PLUGIN_ID}}/` (this PR)
- **Marketplace catalog version:** _none — community plugin, not promoted to a registry yet_
- **skills.sh:** _not published — can be added in a follow-up after merge_
- **ClawHub:** _not published_
- **Other registries:** _none_

This PR adds the source folder only. Marketplace registry entries (`plugins/registry/*.json`) are out of scope and would be a separate PR if/when promotion happens.

## Checklist (per `plugins/spec/CONTRIBUTING.md`)

- [x] Portable `SKILL.md`
- [x] `open-design.json` declares `specVersion` and `version`
- [x] No duplication between SKILL.md body and open-design.json
- [x] Capabilities are minimal
- [x] Externally visible actions are user-confirmed
- [x] Visual examples include a preview or concrete output
- [x] JSON is valid

---

👋 This is my first OD contribution. The skill folder, manifest, and supporting files were assembled by the [`od-contribute` skill](https://github.com/nexu-io/open-design/tree/main/.claude/skills/od-contribute) running in my AI agent — I described the artifact and answered a few questions; the agent did the rest. Happy to push fixup commits if anything looks off.

Need help or want to chat about plugin authoring? OD Discord: {{DISCORD_INVITE}}

_Generated with the `od-contribute` skill (plugin branch)._
