#!/usr/bin/env bash
# Scaffold a plugin folder under <workdir>/plugins/community/<plugin-id>/
# from the four templates already shipped in plugins/spec/templates/.
#
# Usage:
#   scaffold-plugin.sh \
#     --workdir <abs path to OD checkout> \
#     --plugin-id <kebab-case slug> \
#     --title "<Plugin Title>" \
#     --lane <create|import|export|share|deploy|refine|extend> \
#     --mode <prototype|deck|live-artifact|image|video|hyperframes|audio|design-system> \
#     --description "<one-sentence marketplace description>" \
#     [--author-name "<name>"]            (default: "Open Design Community")
#     [--target spec-examples|community]  (default: community)
#
# On success, prints:
#   TARGET_DIR=<abs path to scaffolded plugin folder>
#   SKILL_PATH=<abs path to SKILL.md>
#   MANIFEST_PATH=<abs path to open-design.json>
#
# Why we copy templates from the workdir rather than ship them in the skill:
#   The OD repo at plugins/spec/templates/ is the canonical source of truth.
#   The team maintains them bilingually and reviewers expect any new plugin
#   to look like its sibling examples. Pulling at scaffold time means we
#   stay current without us needing to mirror template changes.

set -euo pipefail
source "$(dirname "$0")/config.sh"

WORKDIR=""
PLUGIN_ID=""
TITLE=""
LANE=""
MODE=""
DESCRIPTION=""
AUTHOR_NAME="Open Design Community"
TARGET_KIND="community"

while (($#)); do
  case "$1" in
    --workdir)      WORKDIR="$2"; shift 2 ;;
    --plugin-id)    PLUGIN_ID="$2"; shift 2 ;;
    --title)        TITLE="$2"; shift 2 ;;
    --lane)         LANE="$2"; shift 2 ;;
    --mode)         MODE="$2"; shift 2 ;;
    --description)  DESCRIPTION="$2"; shift 2 ;;
    --author-name)  AUTHOR_NAME="$2"; shift 2 ;;
    --target)       TARGET_KIND="$2"; shift 2 ;;
    *) od::die "unknown flag: $1" ;;
  esac
done

[[ -n "$WORKDIR"     ]] || od::die "--workdir required"
[[ -n "$PLUGIN_ID"   ]] || od::die "--plugin-id required"
[[ -n "$TITLE"       ]] || od::die "--title required"
[[ -n "$LANE"        ]] || od::die "--lane required"
[[ -n "$MODE"        ]] || od::die "--mode required"
[[ -n "$DESCRIPTION" ]] || od::die "--description required"
[[ -d "$WORKDIR/.git" ]] || od::die "not a git workdir: $WORKDIR"

# Validate plugin-id shape: kebab-case, ASCII, no leading/trailing dash
if ! printf '%s' "$PLUGIN_ID" | grep -qE '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; then
  od::die "plugin-id must be kebab-case ASCII (got: $PLUGIN_ID)"
fi

# Validate lane / mode against the spec's enums.
case "$LANE" in
  create|import|export|share|deploy|refine|extend) ;;
  *) od::die "lane must be one of: create / import / export / share / deploy / refine / extend (got: $LANE)" ;;
esac
case "$MODE" in
  prototype|deck|live-artifact|image|video|hyperframes|audio|design-system) ;;
  *) od::die "mode must be one of: prototype / deck / live-artifact / image / video / hyperframes / audio / design-system (got: $MODE)" ;;
esac

# Pick the target subtree.
case "$TARGET_KIND" in
  community)     PLUGIN_PARENT="$WORKDIR/plugins/community" ;;
  spec-examples) PLUGIN_PARENT="$WORKDIR/plugins/spec/examples" ;;
  *) od::die "--target must be community or spec-examples (got: $TARGET_KIND)" ;;
esac

TARGET_DIR="$PLUGIN_PARENT/$PLUGIN_ID"

# Refuse to scaffold over an existing folder — caller picks a new id.
if [[ -e "$TARGET_DIR" ]]; then
  od::die "target already exists: $TARGET_DIR (pick a different --plugin-id)"
fi

# Templates must exist in the workdir (they're bundled in OD's repo at
# plugins/spec/templates/). If they don't, the user's clone is stale.
TEMPLATES="$WORKDIR/plugins/spec/templates"
for required in SKILL.template.md open-design.template.json README.template.md; do
  [[ -f "$TEMPLATES/$required" ]] || od::die "template missing in checkout: plugins/spec/templates/$required (is the workdir up to date?)"
done

mkdir -p "$TARGET_DIR/assets" "$TARGET_DIR/preview"

# ----- SKILL.md -----
# Substitute frontmatter fields. The template uses placeholder values
# (name: plugin-id, version: "0.1.0", etc.) — replace with real values.
sed \
  -e "s|^name: .*|name: ${PLUGIN_ID}|" \
  -e "s|^description: .*|description: ${DESCRIPTION}|" \
  -e "s|^  author: .*|  author: ${AUTHOR_NAME}|" \
  -e "s|^# Plugin Title|# ${TITLE}|" \
  "$TEMPLATES/SKILL.template.md" > "$TARGET_DIR/SKILL.md"

# ----- open-design.json -----
# jq is the right tool for JSON edits, not sed. Substitute every field that
# the template ships with placeholder values for.
jq \
  --arg id "$PLUGIN_ID" \
  --arg title "$TITLE" \
  --arg desc "$DESCRIPTION" \
  --arg lane "$LANE" \
  --arg mode "$MODE" \
  --arg author "$AUTHOR_NAME" \
  '.name = $id
   | .title = $title
   | .description = $desc
   | (.tags // []) as $existing | .tags = ([$lane, $mode] | unique)
   | .author = { name: $author }
   | .od.taskKind = (if $lane == "create" then "new-generation" else $lane end)
   | .od.mode = $mode' \
  "$TEMPLATES/open-design.template.json" > "$TARGET_DIR/open-design.json"

# ----- README.md (en) -----
sed \
  -e "s|{{TITLE}}|${TITLE}|g" \
  -e "s|{{PLUGIN_ID}}|${PLUGIN_ID}|g" \
  -e "s|{{DESCRIPTION}}|${DESCRIPTION}|g" \
  -e "s|{{LANE}}|${LANE}|g" \
  -e "s|{{MODE}}|${MODE}|g" \
  "$TEMPLATES/README.template.md" > "$TARGET_DIR/README.md"

# ----- README.zh-CN.md (best-effort mirror) -----
# OD spec docs require a zh-CN mirror; community plugin READMEs don't strictly
# require one, but shipping a stub avoids the bilingual rule biting later if
# the plugin gets promoted to spec/examples. The agent can flesh it out
# (or replace the en-version contents) before push if the contributor speaks
# Chinese; otherwise this stub at least declares the intent.
if [[ -f "$TEMPLATES/README.template.zh-CN.md" ]]; then
  sed \
    -e "s|{{TITLE}}|${TITLE}|g" \
    -e "s|{{PLUGIN_ID}}|${PLUGIN_ID}|g" \
    -e "s|{{DESCRIPTION}}|${DESCRIPTION}|g" \
    -e "s|{{LANE}}|${LANE}|g" \
    -e "s|{{MODE}}|${MODE}|g" \
    "$TEMPLATES/README.template.zh-CN.md" > "$TARGET_DIR/README.zh-CN.md"
fi

od::log "scaffolded plugin at $TARGET_DIR"
printf 'TARGET_DIR=%s\n' "$TARGET_DIR"
printf 'SKILL_PATH=%s\n' "$TARGET_DIR/SKILL.md"
printf 'MANIFEST_PATH=%s\n' "$TARGET_DIR/open-design.json"
