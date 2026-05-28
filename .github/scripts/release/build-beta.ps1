param(
  [ValidateSet("win")]
  [string]$Platform = "win",
  [ValidateSet("hosted", "self-hosted")]
  [string]$Lane = "self-hosted",
  [string]$Namespace = "release-beta-win",
  [string]$Root = "",
  [string]$ReleaseVersion = "",
  [string]$MetadataUrl = "https://releases.open-design.ai/beta/latest/metadata.json",
  [ValidateSet("full", "fast")]
  [string]$SmokeMode = "full"
)

$ErrorActionPreference = "Stop"
$scriptStartedAt = Get-Date
$script:timings = @()
$script:failureMessage = $null

if ($Platform -ne "win") {
  throw "build-beta.ps1 currently supports win only"
}

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$fnm = "C:\Users\runner\.cargo\bin\fnm.exe"
$cargo = "C:\Users\runner\.cargo\bin\cargo.exe"
$makensis = "C:\Program Files (x86)\NSIS\makensis.exe"

function Require-File([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Name is required at $Path"
  }
}

function Format-Duration([int64]$Milliseconds) {
  if ($Milliseconds -ge 60000) {
    return "$([Math]::Round($Milliseconds / 60000, 1))m"
  }
  return "$([Math]::Round($Milliseconds / 1000, 1))s"
}

function Measure-Step([string]$Name, [scriptblock]$Script) {
  Write-Host "##[group]$Name"
  $started = Get-Date
  try {
    $result = & $Script
    $durationMs = [int64]((Get-Date) - $started).TotalMilliseconds
    $script:timings += [ordered]@{
      step = $Name
      status = "success"
      durationMs = $durationMs
    }
    Write-Host "[$Name] success in $(Format-Duration $durationMs)"
    return $result
  } catch {
    $durationMs = [int64]((Get-Date) - $started).TotalMilliseconds
    $script:timings += [ordered]@{
      step = $Name
      status = "failed"
      durationMs = $durationMs
      error = $_.Exception.Message
    }
    $script:failureMessage = $_.Exception.Message
    Write-Host "[$Name] failed in $(Format-Duration $durationMs)"
    throw
  } finally {
    Write-Host "##[endgroup]"
  }
}

function Invoke-Node24([string[]]$Arguments, [string]$WorkingDirectory = $workspaceRoot) {
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $fnm exec --using=24 -- @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "fnm exec failed with exit code ${LASTEXITCODE}: $($Arguments -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Read-GitHubOutput([string]$Path) {
  $outputs = @{}
  foreach ($line in Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue) {
    $index = $line.IndexOf("=")
    if ($index -le 0) { continue }
    $outputs[$line.Substring(0, $index)] = $line.Substring($index + 1)
  }
  return $outputs
}

function Repair-ElectronDist {
  $electronVersion = "41.3.0"
  $electronRoot = Join-Path $workspaceRoot "node_modules\.pnpm\electron@$electronVersion\node_modules\electron"
  $dist = Join-Path $electronRoot "dist"
  $electronExe = Join-Path $dist "electron.exe"
  if (Test-Path -LiteralPath $electronExe) {
    return
  }

  $cacheRoot = Join-Path $env:LOCALAPPDATA "electron\Cache"
  $zip = Get-ChildItem -LiteralPath $cacheRoot -Recurse -Filter "electron-v$electronVersion-win32-x64.zip" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($zip -eq $null) {
    $previousForceNoCache = $env:force_no_cache
    try {
      $env:force_no_cache = "true"
      Invoke-Node24 -Arguments @("node", (Join-Path $electronRoot "install.js"))
    } finally {
      $env:force_no_cache = $previousForceNoCache
    }
    $zip = Get-ChildItem -LiteralPath $cacheRoot -Recurse -Filter "electron-v$electronVersion-win32-x64.zip" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
  }

  if ($zip -eq $null) {
    throw "Electron cache zip not found for $electronVersion under $cacheRoot"
  }

  $resolvedDist = (Resolve-Path -LiteralPath $dist -ErrorAction SilentlyContinue)
  if ($resolvedDist -ne $null -and -not $resolvedDist.Path.StartsWith($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to repair Electron dist outside workspace: $($resolvedDist.Path)"
  }

  Remove-Item -LiteralPath $dist -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $dist | Out-Null
  tar.exe -xf $zip.FullName -C $dist
  Require-File $electronExe "electron.exe"
}

function Read-BuildJson {
  if (-not (Test-Path -LiteralPath $buildJsonPath)) {
    return $null
  }
  return Read-JsonFile $buildJsonPath
}

function Read-JsonFile([string]$Path) {
  return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
}

function Get-SmokeSummary {
  $summaryJsonPath = Join-Path $env:OD_PACKAGED_E2E_REPORT_DIR "summary.json"
  if (-not (Test-Path -LiteralPath $summaryJsonPath)) {
    return $null
  }
  return Read-JsonFile $summaryJsonPath
}

function Get-ArtifactSummary {
  $build = Read-BuildJson
  if ($build -eq $null) {
    return $null
  }
  return [ordered]@{
    installerPath = $build.installerPath
    installerBytes = $build.sizeReport.installerBytes
    latestYmlPath = $build.latestYmlPath
    outputRoot = $build.outputRoot
    outputRootBytes = $build.sizeReport.outputRootBytes
    portableZipPath = $build.portableZipPath
    portableZipBytes = $build.sizeReport.portableZipBytes
  }
}

function Get-CacheSummary {
  $build = Read-BuildJson
  if ($build -eq $null -or $build.cacheReport -eq $null -or $build.cacheReport.entries -eq $null) {
    return @()
  }
  return @($build.cacheReport.entries | ForEach-Object {
    [ordered]@{
      nodeId = $_.nodeId
      status = $_.status
      durationMs = $_.durationMs
      reason = $_.reason
      materialized = @($_.materialized | ForEach-Object {
        [ordered]@{
          from = $_.from
          to = $_.to
          durationMs = $_.durationMs
          skipped = $_.skipped
        }
      })
    }
  })
}

function Get-BuildSegments {
  $build = Read-BuildJson
  if ($build -eq $null -or $build.segments -eq $null) {
    return @()
  }
  return @($build.segments | ForEach-Object {
    [ordered]@{
      phase = $_.phase
      durationMs = $_.durationMs
      details = $_.details
    }
  })
}

function Write-IndexAndSummary([string]$Status) {
  $durationMs = [int64]((Get-Date) - $scriptStartedAt).TotalMilliseconds
  $artifactSummary = Get-ArtifactSummary
  $cacheSummary = Get-CacheSummary
  $buildSegments = Get-BuildSegments
  $smokeSummary = Get-SmokeSummary
  $index = [ordered]@{
    channel = "beta"
    lane = $Lane
    namespace = $Namespace
    platform = $Platform
    releaseVersion = $ReleaseVersion
    status = $Status
    failure = $script:failureMessage
    commit = $env:GITHUB_SHA
    branch = $env:GITHUB_REF_NAME
    root = $Root
    toolsPackDir = $toolsPackDir
    cacheDir = $cacheDir
    buildJsonPath = $buildJsonPath
    reportDir = $env:OD_PACKAGED_E2E_REPORT_DIR
    smokeMode = $SmokeMode
    smoke = $smokeSummary
    artifacts = $artifactSummary
    cache = $cacheSummary
    buildSegments = $buildSegments
    timings = $script:timings
    durationMs = $durationMs
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }

  New-Item -ItemType Directory -Force -Path $indexDir | Out-Null
  $index | ConvertTo-Json -Depth 8 | Set-Content -Path $indexPath -Encoding utf8

  $summary = @(
    "## release-beta-s",
    "",
    "- status: ``$Status``",
    "- platform: ``$Platform``",
    "- lane: ``$Lane``",
    "- namespace: ``$Namespace``",
    "- releaseVersion: ``$ReleaseVersion``",
    "- smokeMode: ``$SmokeMode``",
    "- duration: ``$(Format-Duration $durationMs)``",
    "- index: ``$indexPath``",
    "- reportDir: ``$($env:OD_PACKAGED_E2E_REPORT_DIR)``"
  )

  if ($script:failureMessage -ne $null) {
    $summary += "- failure: ``$script:failureMessage``"
  }

  if ($artifactSummary -ne $null) {
    $summary += ""
    $summary += "### Artifacts"
    $summary += "- installer: ``$($artifactSummary.installerPath)``"
    $summary += "- portableZip: ``$($artifactSummary.portableZipPath)``"
  }

  if ($script:timings.Count -gt 0) {
    $summary += ""
    $summary += "### Timings"
    foreach ($timing in $script:timings) {
      $summary += "- $($timing.step): ``$(Format-Duration $timing.durationMs)`` $($timing.status)"
    }
  }

  if ($cacheSummary.Count -gt 0) {
    $summary += ""
    $summary += "### Tools-Pack Cache"
    foreach ($entry in $cacheSummary) {
      $summary += "- $($entry.nodeId): ``$($entry.status)`` ``$(Format-Duration $entry.durationMs)``"
      $slowMaterialized = @($entry.materialized | Sort-Object durationMs -Descending | Select-Object -First 5)
      foreach ($materialized in $slowMaterialized) {
        $mode = if ($materialized.skipped) { "reuse" } else { "copy" }
        $summary += "  - materialize $($materialized.from): ``$(Format-Duration $materialized.durationMs)`` $mode"
      }
    }
  }

  if ($buildSegments.Count -gt 0) {
    $summary += ""
    $summary += "### Build Segments"
    foreach ($segment in @($buildSegments | Sort-Object durationMs -Descending | Select-Object -First 12)) {
      $detailText = ""
      if ($segment.details -ne $null -and $segment.details.outputBytes -ne $null) {
        $detailText = " output=$([Math]::Round($segment.details.outputBytes / 1MB, 1))MiB"
      }
      if ($segment.details -ne $null -and $segment.details.files -ne $null) {
        $detailText = " files=$($segment.details.files) dirs=$($segment.details.directories) bytes=$([Math]::Round($segment.details.bytes / 1MB, 1))MiB maxPath=$($segment.details.maxPathLength)"
      }
      $summary += "- $($segment.phase): ``$(Format-Duration $segment.durationMs)``$detailText"
    }
  }

  if ($smokeSummary -ne $null -and $smokeSummary.timings -ne $null) {
    $summary += ""
    $summary += "### Smoke Segments"
    foreach ($timing in @($smokeSummary.timings | Sort-Object durationMs -Descending | Select-Object -First 16)) {
      $summary += "- $($timing.step): ``$(Format-Duration $timing.durationMs)``"
    }
  }

  $summary | Set-Content -Path $summaryPath -Encoding utf8
  if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
    $summary | Add-Content -Path $env:GITHUB_STEP_SUMMARY -Encoding utf8
  }
}

if ([string]::IsNullOrWhiteSpace($Root)) {
  if ($Lane -eq "self-hosted") {
    $Root = "C:\.tmp\runner\od-beta"
  } else {
    $Root = Join-Path $env:RUNNER_TEMP "od-beta"
  }
}

$platformRoot = Join-Path $Root $Platform
$toolsPackDir = Join-Path $platformRoot "tools-pack"
$cacheDir = Join-Path $platformRoot "tools-pack-cache"
$reportDir = Join-Path $platformRoot "release-report"
$indexDir = Join-Path $platformRoot "index"
$buildJsonPath = Join-Path $platformRoot "windows-tools-pack-build.json"
$indexPath = Join-Path $indexDir "index.json"
$summaryPath = Join-Path $platformRoot "summary.md"
$metadataOutputPath = Join-Path $platformRoot "metadata.outputs"

New-Item -ItemType Directory -Force -Path $platformRoot, $toolsPackDir, $cacheDir, $reportDir, $indexDir | Out-Null
Remove-Item -LiteralPath $buildJsonPath -Force -ErrorAction SilentlyContinue

try {
  Measure-Step "toolchain" {
    Require-File $fnm "fnm"
    Require-File $cargo "cargo"
    Require-File $makensis "makensis"
    git --version
    git lfs version
    & $fnm exec --using=24 -- node --version
    & $fnm exec --using=24 -- pnpm.cmd --version
    & $cargo --version
    & $makensis /VERSION
  }

  Measure-Step "pnpm install" {
    Invoke-Node24 -Arguments @("pnpm.cmd", "install", "--frozen-lockfile", "--prefer-offline")
  }

  Measure-Step "tools-pack dist bundle" {
    Invoke-Node24 -Arguments @("node", ".\esbuild.config.mjs") -WorkingDirectory (Join-Path $workspaceRoot "tools\pack")
  }

  Measure-Step "electron dist repair" {
    Repair-ElectronDist
  }

  if ([string]::IsNullOrWhiteSpace($ReleaseVersion)) {
    Measure-Step "resolve beta metadata" {
      git fetch --force --depth=1 origin "+refs/tags/open-design-v*:refs/tags/open-design-v*"

      $previousMetadataUrl = $env:OPEN_DESIGN_BETA_METADATA_URL
      $previousGitHubOutput = $env:GITHUB_OUTPUT
      try {
        $env:OPEN_DESIGN_BETA_METADATA_URL = $MetadataUrl
        $env:GITHUB_OUTPUT = $metadataOutputPath
        Remove-Item -LiteralPath $metadataOutputPath -Force -ErrorAction SilentlyContinue
        Invoke-Node24 -Arguments @("node", "--experimental-strip-types", ".\scripts\release-beta.ts")
        $metadata = Read-GitHubOutput $metadataOutputPath
        $script:ReleaseVersion = [string]$metadata["beta_version"]
      } finally {
        $env:OPEN_DESIGN_BETA_METADATA_URL = $previousMetadataUrl
        $env:GITHUB_OUTPUT = $previousGitHubOutput
      }
    }
    $ReleaseVersion = $script:ReleaseVersion
  }

  if ([string]::IsNullOrWhiteSpace($ReleaseVersion)) {
    throw "failed to resolve beta release version"
  }

  $outputNamespaceRoot = Join-Path $toolsPackDir "out\win\namespaces\$Namespace"
  $runtimeNamespaceRoot = Join-Path $toolsPackDir "runtime\win\namespaces\$Namespace"
  Measure-Step "pre-clean runtime root" {
    Remove-Item -LiteralPath $runtimeNamespaceRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  $buildArgs = @(
    "pnpm.cmd", "exec", "tools-pack", "win", "build",
    "--dir", $toolsPackDir,
    "--cache-dir", $cacheDir,
    "--namespace", $Namespace,
    "--portable",
    "--app-version", $ReleaseVersion,
    "--to", "all",
    "--json"
  )

  Measure-Step "tools-pack win build" {
    $buildOutput = & $fnm exec --using=24 -- @buildArgs
    if ($LASTEXITCODE -ne 0) {
      throw "tools-pack win build failed with exit code $LASTEXITCODE"
    }
    $buildOutput | Set-Content -Path $buildJsonPath -Encoding utf8
  }

  $env:OD_PACKAGED_E2E_BUILD_JSON_PATH = $buildJsonPath
  $env:OD_PACKAGED_E2E_WIN = "1"
  $env:OD_PACKAGED_E2E_WIN_VERIFY_REINSTALL = "0"
  $env:OD_PACKAGED_E2E_WIN_UPDATER_VIOLENT = if ($SmokeMode -eq "fast") { "0" } else { "1" }
  $env:OD_PACKAGED_E2E_NAMESPACE = $Namespace
  $env:OD_PACKAGED_E2E_RELEASE_CHANNEL = "beta"
  $env:OD_PACKAGED_E2E_RELEASE_VERSION = $ReleaseVersion
  $env:OD_PACKAGED_E2E_REPORT_DIR = Join-Path $reportDir "win"
  $env:OD_PACKAGED_E2E_TOOLS_PACK_DIR = $toolsPackDir

  Measure-Step "release smoke win" {
    Invoke-Node24 -Arguments @("pnpm.cmd", "exec", "tsx", "scripts/release-smoke.ts", "win", "specs/win.spec.ts") -WorkingDirectory (Join-Path $workspaceRoot "e2e")
  }

  Measure-Step "write index" {
    Write-IndexAndSummary "success"
  }
  Write-IndexAndSummary "success"

  Write-Host "release-beta-s index: $indexPath"
} catch {
  if ($script:failureMessage -eq $null) {
    $script:failureMessage = $_.Exception.Message
  }
  try {
    Write-IndexAndSummary "failed"
  } catch {
    Write-Warning "failed to write release-beta-s index: $($_.Exception.Message)"
  }
  throw
}
