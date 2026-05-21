import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseBundleEpochVersion,
  readBundlePublication,
  selectBundlePublicationVariant,
  validateBundleRef,
  type BundlePublicationDisplay,
  type BundlePublicationVariant,
} from "@open-design/bundle";
import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_EVENTS,
  SIDECAR_MESSAGES,
  type PackagedBundleActivationInput,
  type PackagedBundleOperationResult,
  type PackagedBundlePresentationSnapshot,
} from "@open-design/sidecar-proto";
import { requestJsonIpc, resolveAppIpcPath } from "@open-design/sidecar";

import {
  fetchRemoteBundlePublication,
  installRemoteBundleArtifact,
  type InstalledRemoteBundleArtifact,
} from "./bundle-remote.js";
import type { ToolPackConfig } from "./config.js";

export const TOOLS_PACK_WEB_BUNDLE_KEY = "od:sidecar:web";
export const TOOLS_PACK_WEB_BUNDLE_SLUG = "web";

export type PackagedWebBundleActivationResult = {
  activationPath: string;
  bundleBasePath: string;
  key: typeof TOOLS_PACK_WEB_BUNDLE_KEY;
  namespace: string;
  platform: ToolPackConfig["platform"];
  presentation?: PackagedBundlePresentationSnapshot;
  source: "builtin" | "bundle" | "missing";
  version?: string;
};

export type PackagedWebBundleStatusResult =
  | PackagedBundleOperationResult
  | (PackagedWebBundleActivationResult & {
      mode: "offline";
      onlineError?: string;
    });

export type PackagedWebBundlePublicationRef = {
  channel: string;
  pathKey: string;
  versionOrTag: string;
};

export type PackagedWebBundlePublicationSwitchResult = {
  digest: {
    algorithm: "sha256";
    value: string;
  };
  hostEpoch: string;
  mode: "publication";
  platform: string;
  publication: {
    channel: string;
    display: BundlePublicationDisplay;
    key: string;
    path: string;
    pathKey: string;
    version: string;
  };
  install?: {
    artifactUrl: string;
    bundleBasePath: string;
    digest: InstalledRemoteBundleArtifact["digest"];
    path: string;
    size: number;
  };
  selected: BundlePublicationVariant;
  switch: PackagedBundleOperationResult;
};

function activationPath(config: ToolPackConfig): string {
  return join(config.roots.runtime.namespaceRoot, "data", "bundle-activation.json");
}

function bundleBasePath(config: ToolPackConfig): string {
  return join(config.roots.runtime.namespaceRoot, "data", "bundles");
}

function defaultBundleRegistryBasePath(config: ToolPackConfig): string {
  return join(config.roots.runtime.namespaceRoot, "data", "bundle-registry");
}

function baseResult(config: ToolPackConfig): Omit<PackagedWebBundleActivationResult, "source"> {
  return {
    activationPath: activationPath(config),
    bundleBasePath: bundleBasePath(config),
    key: TOOLS_PACK_WEB_BUNDLE_KEY,
    namespace: config.namespace,
    platform: config.platform,
  };
}

function validateWebBundleVersion(version: string): string {
  const parsed = parseBundleEpochVersion(version);
  if (parsed.slug !== TOOLS_PACK_WEB_BUNDLE_SLUG) {
    throw new Error(`web bundle activation version must use .${TOOLS_PACK_WEB_BUNDLE_SLUG}.M: ${version}`);
  }
  return validateBundleRef({ key: TOOLS_PACK_WEB_BUNDLE_KEY, version: parsed.version }).version;
}

function packagePlatformTag(config: ToolPackConfig): string {
  const platform = config.platform === "mac" ? "darwin" : config.platform === "win" ? "win32" : "linux";
  return `${platform}-${process.arch}`;
}

function parsePublicationRef(value: string): PackagedWebBundlePublicationRef {
  const parts = value.split("/");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("--publication must use <pathKey>/<channel>/<version-or-tag>");
  }
  return {
    pathKey: parts[0] as string,
    channel: parts[1] as string,
    versionOrTag: parts[2] as string,
  };
}

function presentationFromPublication(input: {
  channel: string;
  display: BundlePublicationDisplay;
  version: string;
}): PackagedBundlePresentationSnapshot {
  return {
    channel: input.channel,
    display: input.display,
    version: input.version,
  };
}

function writeActivationPayload(input: "builtin" | {
  presentation?: PackagedBundlePresentationSnapshot;
  version: string;
}): unknown {
  return input === "builtin"
    ? {
      bundle: { key: TOOLS_PACK_WEB_BUNDLE_KEY, source: "builtin" },
      schemaVersion: 1,
    }
    : {
      bundle: { key: TOOLS_PACK_WEB_BUNDLE_KEY, version: input.version },
      ...(input.presentation == null ? {} : { presentation: input.presentation }),
      schemaVersion: 1,
    };
}

function parseActivationPresentation(value: unknown): PackagedBundlePresentationSnapshot | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error("activation presentation must be an object");
  }
  const record = value as Record<string, unknown>;
  const display = record.display;
  if (typeof record.channel !== "string" || typeof record.version !== "string") {
    throw new Error("activation presentation must contain channel and version");
  }
  if (typeof display !== "object" || display == null || Array.isArray(display)) {
    throw new Error("activation presentation display must be an object");
  }
  const displayRecord = display as Record<string, unknown>;
  if (
    typeof displayRecord.version !== "string" ||
    typeof displayRecord.title !== "object" ||
    displayRecord.title == null ||
    Array.isArray(displayRecord.title) ||
    typeof displayRecord.summary !== "object" ||
    displayRecord.summary == null ||
    Array.isArray(displayRecord.summary)
  ) {
    throw new Error("activation presentation display must contain version, title, and summary");
  }
  return {
    channel: record.channel,
    display: {
      summary: parseStringRecord(displayRecord.summary, "activation presentation display.summary"),
      title: parseStringRecord(displayRecord.title, "activation presentation display.title"),
      version: displayRecord.version,
    },
    version: record.version,
  };
}

function parseStringRecord(value: unknown, label: string): Record<string, string> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (key.length === 0) throw new Error(`${label} keys must not be empty`);
    if (typeof text !== "string") throw new Error(`${label}.${key} must be a string`);
    result[key] = text;
  }
  return result;
}

function desktopIpcPath(config: ToolPackConfig): string {
  return resolveAppIpcPath({
    app: APP_KEYS.DESKTOP,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    namespace: config.namespace,
  });
}

function onlineErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestPackagedWebBundleOperation(
  config: ToolPackConfig,
  key: typeof SIDECAR_EVENTS.PACKAGED_BUNDLE_ACTIVATE
    | typeof SIDECAR_EVENTS.PACKAGED_BUNDLE_ENSURE
    | typeof SIDECAR_EVENTS.PACKAGED_BUNDLE_RESTART
    | typeof SIDECAR_EVENTS.PACKAGED_BUNDLE_STATUS
    | typeof SIDECAR_EVENTS.PACKAGED_BUNDLE_SWITCH,
  payload: PackagedBundleActivationInput | { key: typeof TOOLS_PACK_WEB_BUNDLE_KEY },
  timeoutMs: number,
): Promise<PackagedBundleOperationResult> {
  return await requestJsonIpc<PackagedBundleOperationResult>(
    desktopIpcPath(config),
    {
      key,
      payload,
      type: SIDECAR_MESSAGES.EVENT,
    },
    { timeoutMs },
  );
}

function webBundleActivationInput(input: "builtin" | {
  presentation?: PackagedBundlePresentationSnapshot;
  version: string;
}): PackagedBundleActivationInput {
  return input === "builtin"
    ? { key: TOOLS_PACK_WEB_BUNDLE_KEY, source: "builtin" }
    : {
      key: TOOLS_PACK_WEB_BUNDLE_KEY,
      ...(input.presentation == null ? {} : { presentation: input.presentation }),
      version: validateWebBundleVersion(input.version),
    };
}

export async function activatePackagedWebBundle(
  config: ToolPackConfig,
  version: string,
  presentation?: PackagedBundlePresentationSnapshot,
): Promise<PackagedWebBundleActivationResult> {
  const validVersion = validateWebBundleVersion(version);
  const path = activationPath(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(writeActivationPayload({ presentation, version: validVersion }), null, 2)}\n`,
    "utf8",
  );
  return {
    ...baseResult(config),
    ...(presentation == null ? {} : { presentation }),
    source: "bundle",
    version: validVersion,
  };
}

export async function activatePackagedBuiltinWebBundle(
  config: ToolPackConfig,
): Promise<PackagedWebBundleActivationResult> {
  const path = activationPath(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(writeActivationPayload("builtin"), null, 2)}\n`,
    "utf8",
  );
  return {
    ...baseResult(config),
    source: "builtin",
  };
}

export async function readPackagedWebBundleActivation(
  config: ToolPackConfig,
): Promise<PackagedWebBundleActivationResult> {
  const result = baseResult(config);
  try {
    const parsed = JSON.parse(await readFile(result.activationPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      throw new Error("activation file must contain a JSON object");
    }
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== 1) {
      throw new Error("activation file must contain schemaVersion=1");
    }
    const bundle = record.bundle;
    if (typeof bundle !== "object" || bundle == null || Array.isArray(bundle)) {
      throw new Error("activation file bundle must contain a JSON object");
    }
    const bundleRecord = bundle as Record<string, unknown>;
    if (bundleRecord.key !== TOOLS_PACK_WEB_BUNDLE_KEY) {
      throw new Error(`activation key must be ${TOOLS_PACK_WEB_BUNDLE_KEY}`);
    }
    const presentation = parseActivationPresentation(record.presentation);
    if (bundleRecord.source === "builtin") {
      return {
        ...result,
        ...(presentation == null ? {} : { presentation }),
        source: "builtin",
      };
    }
    if (typeof bundleRecord.version !== "string") {
      throw new Error("activation file must contain version or source=builtin");
    }
    return {
      ...result,
      ...(presentation == null ? {} : { presentation }),
      source: "bundle",
      version: validateWebBundleVersion(bundleRecord.version),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...result, source: "missing" };
    }
    throw error;
  }
}

export async function readPackagedWebBundleStatus(
  config: ToolPackConfig,
): Promise<PackagedWebBundleStatusResult> {
  try {
    return await requestPackagedWebBundleOperation(
      config,
      SIDECAR_EVENTS.PACKAGED_BUNDLE_STATUS,
      { key: TOOLS_PACK_WEB_BUNDLE_KEY },
      1500,
    );
  } catch (error) {
    return {
      ...(await readPackagedWebBundleActivation(config)),
      mode: "offline",
      onlineError: onlineErrorMessage(error),
    };
  }
}

export async function ensurePackagedWebBundle(
  config: ToolPackConfig,
): Promise<PackagedBundleOperationResult> {
  return await requestPackagedWebBundleOperation(
    config,
    SIDECAR_EVENTS.PACKAGED_BUNDLE_ENSURE,
    { key: TOOLS_PACK_WEB_BUNDLE_KEY },
    90_000,
  );
}

export async function restartPackagedWebBundle(
  config: ToolPackConfig,
): Promise<PackagedBundleOperationResult> {
  return await requestPackagedWebBundleOperation(
    config,
    SIDECAR_EVENTS.PACKAGED_BUNDLE_RESTART,
    { key: TOOLS_PACK_WEB_BUNDLE_KEY },
    90_000,
  );
}

export async function switchPackagedWebBundle(
  config: ToolPackConfig,
  input: "builtin" | {
    presentation?: PackagedBundlePresentationSnapshot;
    version: string;
  },
): Promise<PackagedBundleOperationResult> {
  return await requestPackagedWebBundleOperation(
    config,
    SIDECAR_EVENTS.PACKAGED_BUNDLE_SWITCH,
    webBundleActivationInput(input),
    120_000,
  );
}

function readOnlineHostEpoch(status: PackagedWebBundleStatusResult): string {
  if (status.mode !== "online") {
    throw new Error(`publication switch requires a running packaged runtime: ${status.onlineError ?? "offline"}`);
  }
  const hostEpoch = status.runtime.hostEpoch;
  if (hostEpoch == null || hostEpoch.length === 0) {
    throw new Error("publication switch requires packaged bundle status to expose hostEpoch");
  }
  return hostEpoch;
}

export async function switchPackagedWebBundlePublication(
  config: ToolPackConfig,
  input: {
    publication: string;
    registryBasePath?: string;
  },
): Promise<PackagedWebBundlePublicationSwitchResult> {
  const ref = parsePublicationRef(input.publication);
  const registryBasePath = resolve(input.registryBasePath ?? defaultBundleRegistryBasePath(config));
  const resolved = await readBundlePublication({
    basePath: registryBasePath,
    channel: ref.channel,
    pathKey: ref.pathKey,
    versionOrTag: ref.versionOrTag,
  });
  const status = await readPackagedWebBundleStatus(config);
  const hostEpoch = readOnlineHostEpoch(status);
  const platform = packagePlatformTag(config);
  const selected = selectBundlePublicationVariant({
    hostEpoch,
    key: TOOLS_PACK_WEB_BUNDLE_KEY,
    platform,
    publication: resolved.publication,
  });
  const presentation = presentationFromPublication({
    channel: resolved.publication.metadata.channel,
    display: resolved.publication.metadata.display,
    version: resolved.publication.metadata.version,
  });
  const switched = await switchPackagedWebBundle(config, {
    presentation,
    version: selected.version,
  });

  return {
    digest: resolved.digest,
    hostEpoch,
    mode: "publication",
    platform,
    publication: {
      channel: resolved.publication.metadata.channel,
      display: resolved.publication.metadata.display,
      key: resolved.publication.bundle.key,
      path: resolved.paths.publicationPath,
      pathKey: resolved.publication.bundle.pathKey,
      version: resolved.publication.metadata.version,
    },
    selected,
    switch: switched,
  };
}

export async function switchPackagedWebBundlePublicationUrl(
  config: ToolPackConfig,
  input: {
    publicationUrl: string;
  },
): Promise<PackagedWebBundlePublicationSwitchResult> {
  const remote = await fetchRemoteBundlePublication(input.publicationUrl);
  const status = await readPackagedWebBundleStatus(config);
  const hostEpoch = readOnlineHostEpoch(status);
  const platform = packagePlatformTag(config);
  const selected = selectBundlePublicationVariant({
    hostEpoch,
    key: TOOLS_PACK_WEB_BUNDLE_KEY,
    platform,
    publication: remote.publication,
  });
  const install = await installRemoteBundleArtifact(config, {
    key: TOOLS_PACK_WEB_BUNDLE_KEY,
    publicationUrl: remote.urls.publicationUrl,
    variant: selected,
  });
  const presentation = presentationFromPublication({
    channel: remote.publication.metadata.channel,
    display: remote.publication.metadata.display,
    version: remote.publication.metadata.version,
  });
  const switched = await switchPackagedWebBundle(config, {
    presentation,
    version: selected.version,
  });

  return {
    digest: remote.digest,
    hostEpoch,
    install: {
      artifactUrl: install.artifactUrl,
      bundleBasePath: install.bundleBasePath,
      digest: install.digest,
      path: install.resolved.path,
      size: install.size,
    },
    mode: "publication",
    platform,
    publication: {
      channel: remote.publication.metadata.channel,
      display: remote.publication.metadata.display,
      key: remote.publication.bundle.key,
      path: remote.urls.publicationUrl,
      pathKey: remote.publication.bundle.pathKey,
      version: remote.publication.metadata.version,
    },
    selected,
    switch: switched,
  };
}

export async function activatePackagedWebBundleOnline(
  config: ToolPackConfig,
  input: "builtin" | {
    presentation?: PackagedBundlePresentationSnapshot;
    version: string;
  },
): Promise<PackagedBundleOperationResult> {
  return await requestPackagedWebBundleOperation(
    config,
    SIDECAR_EVENTS.PACKAGED_BUNDLE_ACTIVATE,
    webBundleActivationInput(input),
    30_000,
  );
}
