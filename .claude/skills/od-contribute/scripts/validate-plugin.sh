#!/usr/bin/env bash
# Schema-check a scaffolded plugin folder before PR. Pure bash + jq —
# no daemon dependency, no pnpm install. Catches the same issues
# `od plugin validate` would on the manifest layer; deeper checks
# (atom resolution, design-system lookup) need the daemon CLI and
# are deferred to maintainer-side review.
#
# Usage:
#   validate-plugin.sh <plugin-dir>
#
# Each PASS/FAIL line is on stdout. Final line is RESULT=pass or
# RESULT=fail. Exit code is 0 / 1 to match.

set -uo pipefail
source "$(dirname "$0")/config.sh"
set +e
set -uo pipefail  # match the "accumulate all diagnostics" stance the
                  # other validators use after sourcing config.sh.

PLUGIN_DIR="${1:?plugin directory required}"
[[ -d "$PLUGIN_DIR" ]] || od::die "not a directory: $PLUGIN_DIR"
ABS_PLUGIN_DIR="$(cd "$PLUGIN_DIR" && pwd -P)"

FAIL=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=1; }

od::require jq

# 1) open-design.json exists + is valid JSON ----------------------------------
MANIFEST="$ABS_PLUGIN_DIR/open-design.json"
if [[ ! -f "$MANIFEST" ]]; then
  fail "open-design.json missing — every OD plugin folder must have a manifest"
  printf 'RESULT=fail\nREASON=manifest_missing\n'
  exit 1
fi
if ! jq -e . "$MANIFEST" >/dev/null 2>&1; then
  fail "open-design.json is not valid JSON"
  printf 'RESULT=fail\nREASON=manifest_invalid_json\n'
  exit 1
fi
pass "open-design.json exists and parses as JSON"

# 2) Required top-level fields -------------------------------------------------
# Per docs/schemas/open-design.plugin.v1.json, required: specVersion, name, version.
for field in specVersion name version; do
  val="$(jq -r --arg f "$field" '.[$f] // ""' "$MANIFEST")"
  if [[ -z "$val" ]]; then
    fail "open-design.json missing required field: $field"
    printf 'REASON=missing_required_field\nFIELD=%s\n' "$field"
    FAIL=1
  fi
done
[[ "$FAIL" -eq 0 ]] && pass "manifest has specVersion, name, version"

# 3) SKILL.md at root ---------------------------------------------------------
if [[ ! -f "$ABS_PLUGIN_DIR/SKILL.md" ]]; then
  fail "SKILL.md missing at plugin root — required for portable agent skills"
fi
[[ -f "$ABS_PLUGIN_DIR/SKILL.md" ]] && pass "SKILL.md present at plugin root"

# 4) Path-typed fields all resolve on disk ------------------------------------
# Collect every path the manifest declares, verify each one resolves to a file
# inside the plugin folder. Newline-delimited string approach — Bash 3.2 safe.
PATHS_TO_CHECK=$'\n'

# Newline-separated jq filter that emits one path per line.
PATHS_RAW="$(jq -r '
  ([.compat.agentSkills[]? | .path]
   + [.compat.claudePlugins[]? | .path]
   + [.od.context.skills[]? | .path]
   + [.od.preview.entry // empty]
   + [.od.useCase.exampleOutputs[]? | .path]
  ) | .[] | select(. != null and . != "")
' "$MANIFEST" 2>/dev/null)"

if [[ -n "$PATHS_RAW" ]]; then
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    # Resolve relative paths against plugin root.
    # Forbid absolute paths (they don't make sense in a portable plugin)
    # and ../ escapes outside the plugin folder.
    case "$p" in
      /*)    fail "manifest declares absolute path (forbidden in portable plugins): $p"
             continue ;;
      ../*|*/../*)
             fail "manifest path escapes plugin folder: $p"
             continue ;;
    esac
    # Strip ./ prefix for the on-disk check.
    rel="${p#./}"
    if [[ ! -e "$ABS_PLUGIN_DIR/$rel" ]]; then
      fail "manifest path does not resolve on disk: $p"
    fi
  done <<< "$PATHS_RAW"
  if [[ "$FAIL" -eq 0 ]]; then
    pass "all manifest paths resolve inside the plugin folder"
  else
    printf 'REASON=unresolved_path\n'
  fi
else
  warn "no path-typed fields declared — that's allowed but unusual"
fi

# 5) lane (od.taskKind) and mode are from the spec's enums --------------------
LANE="$(jq -r '.od.taskKind // ""' "$MANIFEST")"
MODE="$(jq -r '.od.mode // ""' "$MANIFEST")"

# Per plugins/spec/CONTRIBUTING.md, lanes (review checklist):
#   create / import / export / share / deploy / refine / extend
# The taskKind field maps closely; the manifest schema also accepts the
# "new-generation" alias for create. Treat new-generation as create.
case "$LANE" in
  ""|create|new-generation|import|export|share|deploy|refine|extend)
    [[ -n "$LANE" ]] && pass "od.taskKind is from the lane enum: $LANE" ;;
  *)
    fail "od.taskKind '$LANE' is not in the allowed lane enum (create/import/export/share/deploy/refine/extend)"
    printf 'REASON=invalid_lane\n'
    ;;
esac

case "$MODE" in
  ""|prototype|deck|live-artifact|image|video|hyperframes|audio|design-system)
    [[ -n "$MODE" ]] && pass "od.mode is from the mode enum: $MODE" ;;
  *)
    fail "od.mode '$MODE' is not in the allowed mode enum (prototype/deck/live-artifact/image/video/hyperframes/audio/design-system)"
    printf 'REASON=invalid_mode\n'
    ;;
esac

# 6) Capabilities — minimal set from a known list ------------------------------
# OD's review checklist asks reviewers to confirm "capabilities are minimal".
# We can at least catch totally unknown capability strings (typo guard).
KNOWN_CAPS_FILE="$(mktemp)"
cat > "$KNOWN_CAPS_FILE" <<'EOF'
prompt:inject
fs:read
fs:write
fs:delete
network:read
network:write
clipboard:read
clipboard:write
shell:execute
mcp:invoke
EOF

CAPS_DECLARED="$(jq -r '.od.capabilities[]? // empty' "$MANIFEST")"
unknown_caps=0
if [[ -n "$CAPS_DECLARED" ]]; then
  while IFS= read -r cap; do
    [[ -z "$cap" ]] && continue
    if ! grep -Fxq "$cap" "$KNOWN_CAPS_FILE"; then
      warn "capability not in known set (typo? new capability?): $cap"
      unknown_caps=$((unknown_caps + 1))
    fi
  done <<< "$CAPS_DECLARED"
  if [[ "$unknown_caps" -eq 0 ]]; then
    pass "od.capabilities are all from the known set"
  fi
else
  warn "no od.capabilities declared — most plugins need at least 'fs:write' or 'prompt:inject'"
fi
rm -f "$KNOWN_CAPS_FILE"

# Final summary --------------------------------------------------------------
if [[ "$FAIL" -eq 0 ]]; then
  printf 'RESULT=pass\n'
  exit 0
else
  printf 'RESULT=fail\n'
  exit 1
fi
