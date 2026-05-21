import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BUNDLE_DESCRIPTOR_FILE,
  BUNDLE_DESCRIPTOR_SCHEMA_VERSION_V2,
  BUNDLE_PUBLICATION_ARTIFACT_FILE,
  BUNDLE_PUBLICATION_SCHEMA_VERSION,
  addBundle,
  createBundleEpochVersion,
  deleteBundle,
  listBundles,
  parseBundleEpochVersion,
  replaceBundle,
  resolveBundle,
  resolveBundleArtifact,
  validateBundleRef,
  writeBundlePublication,
  type BundleArtifact,
  type BundleArtifactDescriptor,
  type BundleEntry,
  type BundlePublication,
  type BundlePublicationResolved,
  type BundleRef,
  type BundleResolved,
} from "@open-design/bundle";

import { createBundleTarArchive } from "./archive.js";
import {
  DAEMON_APP,
  WEB_APP,
  WEB_BUNDLE_KEY,
  defaultKeyForApp,
  requireAppBundleVersion,
  requireSupportedApp,
  slugForApp,
  type BundleApp,
} from "./apps.js";
import { emitDaemonRuntime } from "./daemon.js";
import { fail } from "./errors.js";
import { assertDirectoryRoot, assertInternalLinks, containsPath, pathExists } from "./fs.js";
import { buildAppIfWorkspace } from "./workspace.js";
import { WEB_STANDALONE_BUNDLE_ROOT, copyWebRuntime, detectWebDescriptor, emitWebSidecar } from "./web.js";

export type PackBundleInput = {
  app: string;
  key?: string;
  outPath: string;
  replace?: boolean;
  sourcePath: string;
  version?: string;
};

export type StoreBundleInput = {
  basePath: string;
  bundlePath: string;
  key?: string;
  replace?: boolean;
  version?: string;
};

export type PackBundleToStoreInput = {
  app: string;
  basePath: string;
  epoch: string;
  outPath?: string;
  replace?: boolean;
  replaceOutput?: boolean;
  sourcePath: string;
};

export type PackBundleToStoreResult = {
  artifact: BundleArtifact;
  ref: BundleRef;
  resolved: BundleResolved;
  version: string;
};

export type PublishBundleInput = {
  app: string;
  bundleBasePath: string;
  bundleVersion: string;
  channel: string;
  displayVersion?: string;
  key?: string;
  pathKey: string;
  platform?: string;
  registryBasePath: string;
  summary?: string;
  tag?: string;
  title?: string;
  version: string;
};

export type PublishBundleResult = {
  publication: BundlePublication;
  raw: BundleResolved;
  tagged?: BundlePublicationResolved;
  versioned: BundlePublicationResolved;
};

async function copyPublicationArtifact(archivePath: string, resolved: BundlePublicationResolved): Promise<void> {
  await cp(archivePath, path.join(resolved.paths.directory, BUNDLE_PUBLICATION_ARTIFACT_FILE));
}

function normalizeRef(input: { key?: string; refOrVersion: string }): BundleRef {
  const at = input.refOrVersion.lastIndexOf("@");
  const key = at > 0 && input.refOrVersion.slice(0, at).includes(":")
    ? input.refOrVersion.slice(0, at)
    : input.key ?? WEB_BUNDLE_KEY;
  const version = key === input.refOrVersion.slice(0, at) ? input.refOrVersion.slice(at + 1) : input.refOrVersion;
  return validateBundleRef({ key, version });
}

function descriptorRef(descriptor: BundleArtifactDescriptor): BundleRef | null {
  return descriptor.schemaVersion === BUNDLE_DESCRIPTOR_SCHEMA_VERSION_V2
    ? { key: descriptor.key, version: descriptor.version }
    : null;
}

async function releaseDescriptorForApp(app: BundleApp, sourcePath: string, outPath: string): Promise<BundleArtifactDescriptor> {
  if (app === WEB_APP) {
    return await emitWebSidecar({
      outPath,
      sourceDescriptor: await detectWebDescriptor(sourcePath),
      sourcePath,
    });
  }
  return await emitDaemonRuntime(sourcePath, outPath);
}

function releaseDescriptorWithRef(input: {
  app: BundleApp;
  descriptor: BundleArtifactDescriptor;
  key?: string;
  version?: string;
}): BundleArtifactDescriptor {
  if (input.key == null && input.version == null) return input.descriptor;
  const version = requireAppBundleVersion(input.app, requireOption(input.version, "--version"));
  const key = validateBundleRef({ key: input.key ?? defaultKeyForApp(input.app), version }).key;
  return {
    entry: input.descriptor.entry,
    key,
    schemaVersion: BUNDLE_DESCRIPTOR_SCHEMA_VERSION_V2,
    version,
    ...(input.app === WEB_APP
      ? { web: { outputMode: "standalone", standaloneRoot: WEB_STANDALONE_BUNDLE_ROOT } }
      : {}),
  };
}

export function requireOption(value: string | undefined, name: string): string {
  if (value == null || value.length === 0) fail(`${name} is required`);
  return value;
}

export async function validateBundlePath(bundlePath: string): Promise<BundleArtifact> {
  return await resolveBundleArtifact(path.resolve(bundlePath));
}

export async function packBundle(input: PackBundleInput): Promise<BundleArtifact> {
  const app = requireSupportedApp(input.app);
  const sourcePath = path.resolve(input.sourcePath);
  const outPath = path.resolve(input.outPath);
  if (containsPath(sourcePath, outPath) || containsPath(outPath, sourcePath)) {
    fail("bundle output path must not overlap the source path");
  }

  await assertDirectoryRoot(sourcePath, "bundle source path");
  const outputAlreadyExists = await pathExists(outPath);
  if (outputAlreadyExists) {
    if (input.replace !== true) fail(`bundle output already exists: ${outPath}`);
    await rm(outPath, { force: true, recursive: true });
  }
  await buildAppIfWorkspace(app, sourcePath);

  await mkdir(path.dirname(outPath), { recursive: true });
  await mkdir(outPath, { recursive: true });
  if (app === WEB_APP) await copyWebRuntime(sourcePath, outPath);
  const descriptor = releaseDescriptorWithRef({
    app,
    descriptor: await releaseDescriptorForApp(app, sourcePath, outPath),
    key: input.key,
    version: input.version,
  });
  // Source roots may carry a dev bundle.json; packed bundles always get a
  // release descriptor selected by tools-bundle.
  await writeFile(path.join(outPath, BUNDLE_DESCRIPTOR_FILE), `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  await assertInternalLinks(outPath, "packed bundle");
  return await validateBundlePath(outPath);
}

export async function addBundleToStore(input: StoreBundleInput): Promise<BundleResolved> {
  const bundlePath = path.resolve(input.bundlePath);
  const artifact = await validateBundlePath(bundlePath);
  const embeddedRef = descriptorRef(artifact.descriptor);
  const version = input.version ?? embeddedRef?.version;
  if (version == null) fail("--version is required when bundle.json does not contain schemaVersion=2 ref metadata");
  const ref = validateBundleRef({ key: input.key ?? embeddedRef?.key ?? WEB_BUNDLE_KEY, version });
  if (embeddedRef != null && (embeddedRef.key !== ref.key || embeddedRef.version !== ref.version)) {
    fail(`store ref ${ref.key}@${ref.version} must match bundle descriptor ref ${embeddedRef.key}@${embeddedRef.version}`);
  }
  const write = input.replace === true ? replaceBundle : addBundle;
  return await write({
    basePath: path.resolve(input.basePath),
    ref,
    sourcePath: bundlePath,
  });
}

async function nextBundleSequence(input: {
  basePath: string;
  epoch: string;
  key: string;
  slug: string;
}): Promise<number> {
  const entries = await listBundleStore(input.basePath);
  let maxSequence = 0;
  for (const entry of entries) {
    if (entry.ref.key !== input.key) continue;
    try {
      const parsed = parseBundleEpochVersion(entry.ref.version);
      if (parsed.epoch === input.epoch && parsed.slug === input.slug) {
        maxSequence = Math.max(maxSequence, parsed.sequence);
      }
    } catch {
      continue;
    }
  }
  return maxSequence + 1;
}

export async function packBundleToStore(input: PackBundleToStoreInput): Promise<PackBundleToStoreResult> {
  const app = requireSupportedApp(input.app);
  const basePath = path.resolve(input.basePath);
  const key = defaultKeyForApp(app);
  const slug = slugForApp(app);
  const version = createBundleEpochVersion({
    epoch: input.epoch,
    sequence: await nextBundleSequence({ basePath, epoch: input.epoch, key, slug }),
    slug,
  });
  const tempRoot = input.outPath == null ? await mkdtemp(path.join(tmpdir(), `od-tools-bundle-publish-${app}-`)) : null;
  const outPath = path.resolve(input.outPath ?? path.join(tempRoot ?? "", "bundle"));

  try {
    await packBundle({
      app,
      key,
      outPath,
      replace: input.replaceOutput,
      sourcePath: input.sourcePath,
      version,
    });
    const resolved = await addBundleToStore({
      basePath,
      bundlePath: outPath,
      key,
      replace: input.replace,
      version,
    });
    return {
      artifact: await validateBundlePath(resolved.path),
      ref: resolved.ref,
      resolved,
      version,
    };
  } finally {
    if (tempRoot != null) await rm(tempRoot, { force: true, recursive: true });
  }
}

export async function publishBundle(input: PublishBundleInput): Promise<PublishBundleResult> {
  const app = requireSupportedApp(input.app);
  const bundleVersion = requireAppBundleVersion(app, input.bundleVersion);
  const key = validateBundleRef({ key: input.key ?? defaultKeyForApp(app), version: bundleVersion }).key;
  const raw = await resolveBundle({
    basePath: path.resolve(input.bundleBasePath),
    ref: { key, version: bundleVersion },
  });
  await validateBundlePath(raw.path);
  const parsedVersion = parseBundleEpochVersion(bundleVersion);
  const displayVersion = input.displayVersion ?? input.version;
  const tempRoot = await mkdtemp(path.join(tmpdir(), "od-tools-bundle-artifact-"));

  try {
    const archive = await createBundleTarArchive({
      archivePath: path.join(tempRoot, BUNDLE_PUBLICATION_ARTIFACT_FILE),
      bundlePath: raw.path,
    });
    const publication: BundlePublication = {
      bundle: {
        key,
        pathKey: input.pathKey,
        variants: [
          {
            artifact: {
              contentType: archive.contentType,
              format: archive.format,
              sha256: archive.sha256,
              size: archive.size,
              url: BUNDLE_PUBLICATION_ARTIFACT_FILE,
            },
            compatible: { hostEpoch: parsedVersion.epoch },
            platform: input.platform ?? "any",
            version: bundleVersion,
          },
        ],
      },
      metadata: {
        channel: input.channel,
        display: {
          summary: { default: input.summary ?? "" },
          title: { default: input.title ?? "" },
          version: displayVersion,
        },
        publish: {},
        version: input.version,
      },
      schemaVersion: BUNDLE_PUBLICATION_SCHEMA_VERSION,
    };

    const registryBasePath = path.resolve(input.registryBasePath);
    const versioned = await writeBundlePublication({
      basePath: registryBasePath,
      publication,
    });
    await copyPublicationArtifact(archive.path, versioned);
    const tagged = input.tag == null
      ? undefined
      : await writeBundlePublication({
        basePath: registryBasePath,
        publication,
        versionOrTag: input.tag,
      });
    if (tagged != null) await copyPublicationArtifact(archive.path, tagged);

    return {
      publication: versioned.publication,
      raw,
      ...(tagged == null ? {} : { tagged }),
      versioned,
    };
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

export async function listBundleStore(basePath: string): Promise<BundleEntry[]> {
  return await listBundles(path.resolve(basePath));
}

export async function resolveBundleFromStore(input: {
  basePath: string;
  key?: string;
  refOrVersion: string;
}): Promise<BundleResolved & { artifact: BundleArtifact }> {
  const resolved = await resolveBundle({
    basePath: path.resolve(input.basePath),
    ref: normalizeRef({ key: input.key, refOrVersion: input.refOrVersion }),
  });
  return {
    ...resolved,
    artifact: await validateBundlePath(resolved.path),
  };
}

export async function deleteBundleFromStore(input: {
  basePath: string;
  key?: string;
  refOrVersion: string;
}): Promise<boolean> {
  return await deleteBundle({
    basePath: path.resolve(input.basePath),
    ref: normalizeRef({ key: input.key, refOrVersion: input.refOrVersion }),
  });
}

export { DAEMON_APP, WEB_APP };
