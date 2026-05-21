import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

export const BUNDLE_BASE_PATH_ENV = "OD_BUNDLE_BASE_PATH";
export const BUNDLE_DESCRIPTOR_FILE = "bundle.json";
export const BUNDLE_DESCRIPTOR_SCHEMA_VERSION = 1;
export const BUNDLE_DESCRIPTOR_SCHEMA_VERSION_V2 = 2;
export const BUNDLE_METADATA_FILE = "metadata.json";
export const BUNDLE_OBJECTS_DIR = "objects";
export const BUNDLE_PUBLICATION_ARTIFACT_FILE = "bundle.tar";
export const BUNDLE_PUBLICATION_DIGEST_FILE = "publication.json.sha256";
export const BUNDLE_PUBLICATION_FILE = "publication.json";
export const BUNDLE_PUBLICATION_LATEST_TAG = "latest";
export const BUNDLE_PUBLICATION_SCHEMA_VERSION = 1;
export const BUNDLE_STAGING_DIR = ".staging";
export const BUNDLE_STORE_VERSION = 1;

const BUNDLE_EPOCH_PATTERN = "\\d+\\.\\d+\\.\\d+(?:-[A-Za-z][A-Za-z0-9-]*\\.(?:0|[1-9]\\d*))?";
const BUNDLE_EPOCH_RE = new RegExp(`^${BUNDLE_EPOCH_PATTERN}$`);
const BUNDLE_EPOCH_VERSION_RE = new RegExp(`^(${BUNDLE_EPOCH_PATTERN})\\.([a-z][a-z0-9-]*)\\.([1-9]\\d*)$`);
const BUNDLE_PUBLICATION_PATH_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;
const BUNDLE_PUBLICATION_PLATFORM_RE = /^(?:any|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const BUNDLE_SLUG_RE = /^[a-z][a-z0-9-]*$/;

export type BundleRef = {
  key: string;
  version: string;
};

export type BundleEntryKind = "js" | "tsx";

export type BundleArtifactDescriptorV1 = {
  entry: {
    kind: BundleEntryKind;
    path: string;
  };
  schemaVersion: typeof BUNDLE_DESCRIPTOR_SCHEMA_VERSION;
};

export type BundleArtifactDescriptorV2 = Record<string, unknown> & {
  entry: {
    kind: BundleEntryKind;
    path: string;
  };
  key: string;
  schemaVersion: typeof BUNDLE_DESCRIPTOR_SCHEMA_VERSION_V2;
  version: string;
};

export type BundleArtifactDescriptor = BundleArtifactDescriptorV1 | BundleArtifactDescriptorV2;

export type BundleEpochVersion = {
  epoch: string;
  sequence: number;
  slug: string;
  version: string;
};

export type BundleArtifact = {
  bundlePath: string;
  descriptor: BundleArtifactDescriptor;
  descriptorPath: string;
  entryPath: string;
};

export type BundleEntry = {
  createdAt: string;
  digest: {
    algorithm: "sha256";
    value: string;
  };
  path: string;
  ref: BundleRef;
};

export type BundleStoreMetadata = {
  bundles: BundleEntry[];
  version: typeof BUNDLE_STORE_VERSION;
};

export type BundleStorePaths = {
  basePath: string;
  metadataPath: string;
};

export type BundlePublicationLocalizedText = {
  default: string;
} & Record<string, string>;

export type BundlePublicationDisplay = {
  summary: BundlePublicationLocalizedText;
  title: BundlePublicationLocalizedText;
  version: string;
};

export type BundlePublicationArtifact = {
  contentType?: string;
  format: "tar";
  sha256?: string;
  sha256Url?: string;
  size?: number;
  url: string;
};

export type BundlePublicationVariant = {
  artifact: BundlePublicationArtifact;
  compatible: {
    hostEpoch: string;
  };
  platform: string;
  version: string;
};

export type BundlePublication = {
  bundle: {
    key: string;
    pathKey: string;
    variants: BundlePublicationVariant[];
  };
  metadata: {
    channel: string;
    display: BundlePublicationDisplay;
    publish: Record<string, unknown>;
    version: string;
  };
  schemaVersion: typeof BUNDLE_PUBLICATION_SCHEMA_VERSION;
};

export type BundlePublicationPaths = {
  basePath: string;
  digestPath: string;
  directory: string;
  publicationPath: string;
};

export type BundlePublicationDigest = {
  algorithm: "sha256";
  value: string;
};

export type BundlePublicationResolved = {
  digest: BundlePublicationDigest;
  paths: BundlePublicationPaths;
  publication: BundlePublication;
};

export type BundleResolved = {
  basePath: string;
  entry: BundleEntry;
  metadataPath: string;
  path: string;
  ref: BundleRef;
};

export type BundleBasePathInput = {
  env?: NodeJS.ProcessEnv;
  envName?: string;
  explicitBasePath?: string | null;
  namespaceDataPath: string;
};

export type BundleWriteInput = {
  basePath: string;
  now?: () => Date;
  ref: BundleRef;
  sourcePath: string;
};

export class BundleStoreError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BundleStoreError";
    this.code = code;
  }
}

const bundleKeySchema = z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/);
const bundleVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
const bundleEpochSchema = z.string().regex(BUNDLE_EPOCH_RE);
const bundlePublicationPathSegmentSchema = z.string()
  .regex(BUNDLE_PUBLICATION_PATH_SEGMENT_RE)
  .refine((value) => value !== "." && value !== "..");
const bundlePublicationPlatformSchema = z.string().regex(BUNDLE_PUBLICATION_PLATFORM_RE);
const bundleRefInputSchema = z.object({
  key: z.string(),
  version: z.string(),
}).strict();
const bundleDescriptorEntryInputSchema = z.object({
  kind: z.enum(["js", "tsx"]),
  path: z.string().min(1),
}).strict();
const bundleDescriptorInputSchema = z.discriminatedUnion("schemaVersion", [
  z.object({
    entry: bundleDescriptorEntryInputSchema,
    schemaVersion: z.literal(BUNDLE_DESCRIPTOR_SCHEMA_VERSION),
  }).strict(),
  z.object({
    entry: bundleDescriptorEntryInputSchema,
    key: z.string(),
    schemaVersion: z.literal(BUNDLE_DESCRIPTOR_SCHEMA_VERSION_V2),
    version: z.string(),
  }).catchall(z.unknown()),
]);
const nullSafeStringSchema = z.string().refine((value) => !value.includes("\0"), {
  message: "must not contain null bytes",
});
const bundlePublicationLocalizedTextInputSchema = z.record(
  z.string().min(1).refine((value) => !value.includes("\0"), {
    message: "keys must not contain null bytes",
  }),
  nullSafeStringSchema,
);
const bundlePublicationDisplayInputSchema = z.object({
  summary: bundlePublicationLocalizedTextInputSchema.optional(),
  title: bundlePublicationLocalizedTextInputSchema.optional(),
  version: nullSafeStringSchema.min(1).optional(),
}).strict();
const bundleSha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const bundlePublicationArtifactInputSchema = z.object({
  contentType: nullSafeStringSchema.min(1).optional(),
  format: z.literal("tar"),
  sha256: bundleSha256Schema.optional(),
  sha256Url: nullSafeStringSchema.min(1).optional(),
  size: z.number().int().nonnegative().optional(),
  url: nullSafeStringSchema.min(1),
}).strict();
const bundlePublicationVariantInputSchema = z.object({
  artifact: bundlePublicationArtifactInputSchema,
  compatible: z.object({
    hostEpoch: z.string(),
  }).strict(),
  platform: z.string(),
  version: z.string(),
}).strict();
const bundlePublicationInputSchema = z.object({
  bundle: z.object({
    key: z.string(),
    pathKey: z.string(),
    variants: z.array(bundlePublicationVariantInputSchema).min(1),
  }).strict(),
  metadata: z.object({
    channel: z.string(),
    display: bundlePublicationDisplayInputSchema.optional(),
    publish: z.record(z.string(), z.unknown()).optional().default({}),
    version: z.string(),
  }).strict(),
  schemaVersion: z.literal(BUNDLE_PUBLICATION_SCHEMA_VERSION),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatZodPath(path: PropertyKey[]): string {
  return path.map(String).join(".");
}

function formatZodError(label: string, error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? label : `${label}.${formatZodPath(issue.path)}`;
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, code: string, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BundleStoreError(code, formatZodError(label, result.error));
  }
  return result.data;
}

function containsPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function assertNoNullBytes(value: string, label: string): void {
  if (value.includes("\0")) throw new BundleStoreError("bundle-path-invalid", `${label} must not contain null bytes`);
}

function resolveAbsolutePath(value: string, label: string): string {
  assertNoNullBytes(value, label);
  if (!isAbsolute(value)) throw new BundleStoreError("bundle-path-not-absolute", `${label} must be absolute`);
  return resolve(value);
}

export function validateBundleKey(key: string): string {
  const result = bundleKeySchema.safeParse(key);
  if (!result.success) {
    throw new BundleStoreError(
      "bundle-key-invalid",
      `bundle key must use a colon-separated lowercase namespace pattern: ${key}`,
    );
  }
  return result.data;
}

export function validateBundleVersion(version: string): string {
  const result = bundleVersionSchema.safeParse(version);
  if (!result.success) {
    throw new BundleStoreError(
      "bundle-version-invalid",
      `bundle version must be a safe path segment: ${version}`,
    );
  }
  return result.data;
}

export function validateBundlePublicationPathKey(pathKey: string): string {
  const result = bundlePublicationPathSegmentSchema.safeParse(pathKey);
  if (!result.success) {
    throw new BundleStoreError(
      "bundle-publication-path-key-invalid",
      `bundle publication pathKey must be a lowercase safe path segment: ${pathKey}`,
    );
  }
  return result.data;
}

export function validateBundlePublicationChannel(channel: string): string {
  const result = bundlePublicationPathSegmentSchema.safeParse(channel);
  if (!result.success) {
    throw new BundleStoreError(
      "bundle-publication-channel-invalid",
      `bundle publication channel must be a lowercase safe path segment: ${channel}`,
    );
  }
  return result.data;
}

export function validateBundlePublicationVersionOrTag(versionOrTag: string): string {
  return validateBundleVersion(versionOrTag);
}

export function validateBundlePublicationPlatform(platform: string): string {
  const result = bundlePublicationPlatformSchema.safeParse(platform);
  if (!result.success) {
    throw new BundleStoreError(
      "bundle-publication-platform-invalid",
      `bundle publication platform must be any or a lowercase platform tag: ${platform}`,
    );
  }
  return result.data;
}

export function validateBundleEpoch(epoch: string): string {
  const result = bundleEpochSchema.safeParse(epoch);
  if (!result.success) {
    throw new BundleStoreError(
      "bundle-epoch-invalid",
      `bundle epoch must use X.Y.Z or X.Y.Z-<channel>.N: ${epoch}`,
    );
  }
  return result.data;
}

export function parseBundleEpochVersion(version: string): BundleEpochVersion {
  const safeVersion = validateBundleVersion(version);
  const match = BUNDLE_EPOCH_VERSION_RE.exec(safeVersion);
  if (match == null) {
    throw new BundleStoreError(
      "bundle-version-invalid",
      `bundle version must use <epoch>.<bundle_slug>.M with epoch X.Y.Z or X.Y.Z-<channel>.N: ${version}`,
    );
  }

  const sequence = Number(match[3]);
  if (!Number.isSafeInteger(sequence)) {
    throw new BundleStoreError("bundle-version-invalid", `bundle version sequence is too large: ${version}`);
  }

  return {
    epoch: validateBundleEpoch(match[1] ?? ""),
    sequence,
    slug: match[2] ?? "",
    version: safeVersion,
  };
}

export function createBundleEpochVersion(input: {
  epoch: string;
  sequence: number;
  slug: string;
}): string {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new BundleStoreError("bundle-version-invalid", `bundle version sequence must be a positive integer: ${input.sequence}`);
  }
  if (!BUNDLE_SLUG_RE.test(input.slug)) {
    throw new BundleStoreError("bundle-version-invalid", `bundle slug must be lowercase alphanumeric or hyphenated: ${input.slug}`);
  }
  return parseBundleEpochVersion(`${validateBundleEpoch(input.epoch)}.${input.slug}.${input.sequence}`).version;
}

export function validateBundleRef(ref: BundleRef): BundleRef {
  const parsed = parseSchema(bundleRefInputSchema, ref, "bundle-ref-invalid", "bundle ref");
  return {
    key: validateBundleKey(parsed.key),
    version: validateBundleVersion(parsed.version),
  };
}

function validateBundleDescriptorEntry(value: unknown): BundleArtifactDescriptor["entry"] {
  const parsed = parseSchema(bundleDescriptorEntryInputSchema, value, "bundle-descriptor-invalid", "bundle descriptor entry");
  assertNoNullBytes(parsed.path, "bundle descriptor entry path");
  if (isAbsolute(parsed.path)) {
    throw new BundleStoreError("bundle-entry-path-invalid", "bundle descriptor entry path must be relative");
  }

  return {
    kind: parsed.kind,
    path: parsed.path.split("\\").join("/"),
  };
}

export function validateBundleDescriptor(value: unknown): BundleArtifactDescriptor {
  const parsed = parseSchema(bundleDescriptorInputSchema, value, "bundle-descriptor-invalid", "bundle descriptor");
  const entry = validateBundleDescriptorEntry(parsed.entry);

  if (parsed.schemaVersion === BUNDLE_DESCRIPTOR_SCHEMA_VERSION) {
    return {
      entry,
      schemaVersion: BUNDLE_DESCRIPTOR_SCHEMA_VERSION,
    };
  }

  return {
    ...parsed,
    entry,
    key: validateBundleKey(parsed.key),
    schemaVersion: BUNDLE_DESCRIPTOR_SCHEMA_VERSION_V2,
    version: parseBundleEpochVersion(parsed.version).version,
  } as BundleArtifactDescriptorV2;
}

function validateBundlePublicationLocalizedText(value: unknown, label: string): BundlePublicationLocalizedText {
  const parsed = parseSchema(
    bundlePublicationLocalizedTextInputSchema,
    value ?? {},
    "bundle-publication-invalid",
    label,
  );
  return { ...parsed, default: parsed.default ?? "" };
}

function validateBundlePublicationDisplay(value: unknown, metadataVersion: string): BundlePublicationDisplay {
  const parsed = parseSchema(
    bundlePublicationDisplayInputSchema,
    value ?? {},
    "bundle-publication-invalid",
    "bundle publication metadata.display",
  );
  return {
    summary: validateBundlePublicationLocalizedText(parsed.summary, "bundle publication display.summary"),
    title: validateBundlePublicationLocalizedText(parsed.title, "bundle publication display.title"),
    version: parsed.version ?? metadataVersion,
  };
}

function validateBundlePublicationArtifact(value: unknown): BundlePublicationArtifact {
  const parsed = parseSchema(
    bundlePublicationArtifactInputSchema,
    value,
    "bundle-publication-invalid",
    "bundle publication variant.artifact",
  );
  return {
    ...(parsed.contentType == null ? {} : { contentType: parsed.contentType }),
    format: parsed.format,
    ...(parsed.sha256 == null ? {} : { sha256: parsed.sha256.toLowerCase() }),
    ...(parsed.sha256Url == null ? {} : { sha256Url: parsed.sha256Url }),
    ...(parsed.size == null ? {} : { size: parsed.size }),
    url: parsed.url,
  };
}

function validateBundlePublicationMetadata(value: unknown): BundlePublication["metadata"] {
  const parsed = parseSchema(
    bundlePublicationInputSchema.shape.metadata,
    value,
    "bundle-publication-invalid",
    "bundle publication metadata",
  );
  const version = validateBundlePublicationVersionOrTag(parsed.version);
  return {
    channel: validateBundlePublicationChannel(parsed.channel),
    display: validateBundlePublicationDisplay(parsed.display, version),
    publish: { ...parsed.publish },
    version,
  };
}

function validateBundlePublicationVariant(value: unknown): BundlePublicationVariant {
  const parsed = parseSchema(
    bundlePublicationVariantInputSchema,
    value,
    "bundle-publication-invalid",
    "bundle publication variant",
  );
  const hostEpoch = validateBundleEpoch(parsed.compatible.hostEpoch);
  const parsedVersion = parseBundleEpochVersion(parsed.version);
  if (parsedVersion.epoch !== hostEpoch) {
    throw new BundleStoreError(
      "bundle-publication-host-epoch-mismatch",
      `bundle publication variant ${parsedVersion.version} must match compatible.hostEpoch ${hostEpoch}`,
    );
  }

  return {
    artifact: validateBundlePublicationArtifact(parsed.artifact),
    compatible: { hostEpoch },
    platform: validateBundlePublicationPlatform(parsed.platform),
    version: parsedVersion.version,
  };
}

function validateBundlePublicationBundle(value: unknown): BundlePublication["bundle"] {
  const parsed = parseSchema(
    bundlePublicationInputSchema.shape.bundle,
    value,
    "bundle-publication-invalid",
    "bundle publication bundle",
  );
  const variants = parsed.variants.map(validateBundlePublicationVariant);
  const seen = new Set<string>();
  for (const variant of variants) {
    const identity = `${variant.compatible.hostEpoch}\0${variant.platform}`;
    if (seen.has(identity)) {
      throw new BundleStoreError(
        "bundle-publication-variant-duplicate",
        `bundle publication contains duplicate variant for ${variant.platform} ${variant.compatible.hostEpoch}`,
      );
    }
    seen.add(identity);
  }

  return {
    key: validateBundleKey(parsed.key),
    pathKey: validateBundlePublicationPathKey(parsed.pathKey),
    variants,
  };
}

export function validateBundlePublication(value: unknown): BundlePublication {
  const parsed = parseSchema(
    bundlePublicationInputSchema,
    value,
    "bundle-publication-invalid",
    "bundle publication",
  );
  return {
    bundle: validateBundlePublicationBundle(parsed.bundle),
    metadata: validateBundlePublicationMetadata(parsed.metadata),
    schemaVersion: BUNDLE_PUBLICATION_SCHEMA_VERSION,
  };
}

export function selectBundlePublicationVariant(input: {
  hostEpoch: string;
  key: string;
  platform: string;
  publication: unknown;
}): BundlePublicationVariant {
  const publication = validateBundlePublication(input.publication);
  const key = validateBundleKey(input.key);
  if (publication.bundle.key !== key) {
    throw new BundleStoreError(
      "bundle-publication-key-mismatch",
      `bundle publication key ${publication.bundle.key} does not match requested key ${key}`,
    );
  }

  const hostEpoch = validateBundleEpoch(input.hostEpoch);
  const platform = validateBundlePublicationPlatform(input.platform);
  const hostMatches = publication.bundle.variants.filter((variant) => variant.compatible.hostEpoch === hostEpoch);
  const exactMatches = hostMatches.filter((variant) => variant.platform === platform);
  if (exactMatches.length === 1) return exactMatches[0] as BundlePublicationVariant;
  if (exactMatches.length > 1) {
    throw new BundleStoreError(
      "bundle-publication-variant-ambiguous",
      `bundle publication has multiple variants for ${platform} ${hostEpoch}`,
    );
  }

  const anyMatches = hostMatches.filter((variant) => variant.platform === "any");
  if (anyMatches.length === 1) return anyMatches[0] as BundlePublicationVariant;
  if (anyMatches.length > 1) {
    throw new BundleStoreError(
      "bundle-publication-variant-ambiguous",
      `bundle publication has multiple any-platform variants for ${hostEpoch}`,
    );
  }

  throw new BundleStoreError(
    "bundle-publication-variant-not-found",
    `bundle publication has no variant for ${key} on ${platform} with host epoch ${hostEpoch}`,
  );
}

export function bundleRefsEqual(left: BundleRef, right: BundleRef): boolean {
  return left.key === right.key && left.version === right.version;
}

export function resolveBundleBasePath(input: BundleBasePathInput): string {
  const env = input.env ?? process.env;
  const envName = input.envName ?? BUNDLE_BASE_PATH_ENV;
  const configured = input.explicitBasePath ?? env[envName] ?? join(input.namespaceDataPath, "bundles");
  return resolveAbsolutePath(configured, "bundle base path");
}

export function bundleStorePaths(basePath: string): BundleStorePaths {
  const resolvedBasePath = resolveAbsolutePath(basePath, "bundle base path");
  return {
    basePath: resolvedBasePath,
    metadataPath: join(resolvedBasePath, BUNDLE_METADATA_FILE),
  };
}

export function bundlePublicationPaths(input: {
  basePath: string;
  channel: string;
  pathKey: string;
  versionOrTag: string;
}): BundlePublicationPaths {
  const basePath = resolveAbsolutePath(input.basePath, "bundle publication base path");
  const directory = join(
    basePath,
    validateBundlePublicationPathKey(input.pathKey),
    validateBundlePublicationChannel(input.channel),
    validateBundlePublicationVersionOrTag(input.versionOrTag),
  );
  return {
    basePath,
    digestPath: join(directory, BUNDLE_PUBLICATION_DIGEST_FILE),
    directory,
    publicationPath: join(directory, BUNDLE_PUBLICATION_FILE),
  };
}

export function bundlePublicationPathsForPublication(input: {
  basePath: string;
  publication: unknown;
  versionOrTag?: string;
}): BundlePublicationPaths {
  const publication = validateBundlePublication(input.publication);
  return bundlePublicationPaths({
    basePath: input.basePath,
    channel: publication.metadata.channel,
    pathKey: publication.bundle.pathKey,
    versionOrTag: input.versionOrTag ?? publication.metadata.version,
  });
}

export function resolveBundleEntryPath(input: {
  bundlePath: string;
  descriptor: BundleArtifactDescriptor;
}): string {
  const bundlePath = resolveAbsolutePath(input.bundlePath, "bundle path");
  const descriptor = validateBundleDescriptor(input.descriptor);
  const entryPath = resolve(bundlePath, descriptor.entry.path);
  if (!containsPath(bundlePath, entryPath)) {
    throw new BundleStoreError("bundle-entry-path-escaped", "bundle descriptor entry path escaped the bundle path");
  }
  return entryPath;
}

export async function readBundleDescriptor(bundlePath: string): Promise<BundleArtifactDescriptor> {
  const resolvedBundlePath = resolveAbsolutePath(bundlePath, "bundle path");
  try {
    return validateBundleDescriptor(JSON.parse(await readFile(join(resolvedBundlePath, BUNDLE_DESCRIPTOR_FILE), "utf8")));
  } catch (error) {
    if (error instanceof BundleStoreError) throw error;
    throw new BundleStoreError("bundle-descriptor-read-failed", error instanceof Error ? error.message : String(error));
  }
}

export async function resolveBundleArtifact(bundlePath: string): Promise<BundleArtifact> {
  const resolvedBundlePath = resolveAbsolutePath(bundlePath, "bundle path");
  const bundleInfo = await lstat(resolvedBundlePath);
  if (!bundleInfo.isDirectory()) throw new BundleStoreError("bundle-path-not-directory", "bundle path must resolve to a directory");
  if (bundleInfo.isSymbolicLink()) throw new BundleStoreError("bundle-path-symlink", "bundle path must not be a symlink");

  const descriptor = await readBundleDescriptor(resolvedBundlePath);
  const entryPath = resolveBundleEntryPath({ bundlePath: resolvedBundlePath, descriptor });
  let entryInfo;
  try {
    entryInfo = await lstat(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BundleStoreError("bundle-entry-not-found", "bundle descriptor entry path does not exist");
    }
    throw error;
  }
  if (!entryInfo.isFile()) throw new BundleStoreError("bundle-entry-not-file", "bundle descriptor entry path must resolve to a file");
  if (entryInfo.isSymbolicLink()) throw new BundleStoreError("bundle-entry-symlink", "bundle descriptor entry path must not be a symlink");

  return {
    bundlePath: resolvedBundlePath,
    descriptor,
    descriptorPath: join(resolvedBundlePath, BUNDLE_DESCRIPTOR_FILE),
    entryPath,
  };
}

function objectId(ref: BundleRef): string {
  return createHash("sha256").update(`${ref.key}\0${ref.version}`).digest("hex").slice(0, 24);
}

function operationId(): string {
  return `${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

function objectContentPath(basePath: string, ref: BundleRef, operation = operationId()): string {
  return join(basePath, BUNDLE_OBJECTS_DIR, objectId(ref), operation, "content");
}

function relativeStorePath(basePath: string, candidate: string): string {
  const rel = relative(basePath, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new BundleStoreError("bundle-path-escaped", "bundle object path escaped the bundle base path");
  }
  return rel.split("\\").join("/");
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const tmp = `${path}.${operationId()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
}

export function bundlePublicationDigest(content: string | Buffer): BundlePublicationDigest {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(content).digest("hex"),
  };
}

export function parseBundlePublicationDigest(content: string): BundlePublicationDigest {
  const digest = content.trim().split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    throw new BundleStoreError("bundle-publication-digest-invalid", "bundle publication digest must contain a sha256 hex value");
  }
  return {
    algorithm: "sha256",
    value: digest.toLowerCase(),
  };
}

export async function writeBundlePublication(input: {
  basePath: string;
  publication: unknown;
  versionOrTag?: string;
}): Promise<BundlePublicationResolved> {
  const publication = validateBundlePublication(input.publication);
  const paths = bundlePublicationPathsForPublication({
    basePath: input.basePath,
    publication,
    versionOrTag: input.versionOrTag,
  });
  const content = `${JSON.stringify(publication, null, 2)}\n`;
  const digest = bundlePublicationDigest(content);
  await writeTextAtomic(paths.publicationPath, content);
  await writeTextAtomic(paths.digestPath, `${digest.value}  ${BUNDLE_PUBLICATION_FILE}\n`);
  return { digest, paths, publication };
}

export async function readBundlePublication(input: {
  basePath: string;
  channel: string;
  pathKey: string;
  verifyDigest?: boolean;
  versionOrTag: string;
}): Promise<BundlePublicationResolved> {
  const paths = bundlePublicationPaths(input);
  let content: string;
  try {
    content = await readFile(paths.publicationPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BundleStoreError("bundle-publication-not-found", `bundle publication not found: ${paths.publicationPath}`);
    }
    throw error;
  }

  const digest = bundlePublicationDigest(content);
  if (input.verifyDigest !== false) {
    let digestContent: string;
    try {
      digestContent = await readFile(paths.digestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BundleStoreError("bundle-publication-digest-missing", `bundle publication digest missing: ${paths.digestPath}`);
      }
      throw error;
    }
    const expected = parseBundlePublicationDigest(digestContent);
    if (expected.value !== digest.value) {
      throw new BundleStoreError(
        "bundle-publication-digest-mismatch",
        `bundle publication digest mismatch for ${paths.publicationPath}`,
      );
    }
  }

  return {
    digest,
    paths,
    publication: validateBundlePublication(JSON.parse(content)),
  };
}

function parseMetadata(value: unknown): BundleStoreMetadata {
  if (!isRecord(value) || value.version !== BUNDLE_STORE_VERSION || !Array.isArray(value.bundles)) {
    throw new BundleStoreError("bundle-metadata-invalid", "bundle metadata has an unsupported shape");
  }

  const bundles = value.bundles.map((entry): BundleEntry => {
    if (!isRecord(entry)) throw new BundleStoreError("bundle-metadata-invalid", "bundle entry must be an object");
    const refValue = entry.ref;
    const digestValue = entry.digest;
    if (!isRecord(refValue)) throw new BundleStoreError("bundle-metadata-invalid", "bundle entry ref must be an object");
    if (!isRecord(digestValue)) throw new BundleStoreError("bundle-metadata-invalid", "bundle entry digest must be an object");
    if (digestValue.algorithm !== "sha256" || typeof digestValue.value !== "string" || digestValue.value.length === 0) {
      throw new BundleStoreError("bundle-metadata-invalid", "bundle entry digest must be sha256");
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      throw new BundleStoreError("bundle-metadata-invalid", "bundle entry path must be a string");
    }
    if (typeof entry.createdAt !== "string" || entry.createdAt.length === 0) {
      throw new BundleStoreError("bundle-metadata-invalid", "bundle entry createdAt must be a string");
    }
    return {
      createdAt: entry.createdAt,
      digest: {
        algorithm: "sha256",
        value: digestValue.value,
      },
      path: entry.path,
      ref: validateBundleRef(refValue as BundleRef),
    };
  });

  return { bundles, version: BUNDLE_STORE_VERSION };
}

export async function readBundleStore(basePath: string): Promise<BundleStoreMetadata> {
  const paths = bundleStorePaths(basePath);
  try {
    return parseMetadata(JSON.parse(await readFile(paths.metadataPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { bundles: [], version: BUNDLE_STORE_VERSION };
    }
    if (error instanceof BundleStoreError) throw error;
    throw new BundleStoreError("bundle-metadata-read-failed", error instanceof Error ? error.message : String(error));
  }
}

async function writeBundleStore(basePath: string, metadata: BundleStoreMetadata): Promise<void> {
  const paths = bundleStorePaths(basePath);
  await writeJsonAtomic(paths.metadataPath, metadata);
}

async function assertDirectoryWithInternalSymlinks(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory()) throw new BundleStoreError("bundle-source-not-directory", "bundle source path must be a directory");
  if (info.isSymbolicLink()) throw new BundleStoreError("bundle-source-symlink", "bundle source path must not be a symlink");
  const realRoot = await realpath(root);

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const child = await lstat(path);
      if (child.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target)) {
          throw new BundleStoreError("bundle-source-symlink", "bundle source symlinks must be relative");
        }

        let realTarget;
        try {
          realTarget = await realpath(path);
        } catch {
          throw new BundleStoreError("bundle-source-symlink", "bundle source symlinks must not be broken");
        }
        if (!containsPath(realRoot, realTarget)) {
          throw new BundleStoreError("bundle-source-symlink", "bundle source symlinks must stay inside the source tree");
        }
        continue;
      }
      if (entry.isDirectory()) await walk(path);
    }
  }

  await walk(root);
}

async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function walk(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split("\\").join("/");
      const info = await lstat(path);
      hash.update(entry.isDirectory() ? "dir\0" : "file\0");
      hash.update(rel);
      hash.update("\0");
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        hash.update(await readFile(path));
      } else if (entry.isSymbolicLink()) {
        hash.update(await readlink(path));
      } else {
        throw new BundleStoreError("bundle-source-invalid-entry", `unsupported bundle source entry: ${rel}`);
      }
      hash.update("\0");
      hash.update(String(info.mode));
      hash.update("\0");
    }
  }

  await walk(root);
  return hash.digest("hex");
}

function entryPath(basePath: string, entry: BundleEntry): string {
  const abs = resolve(basePath, entry.path);
  if (!containsPath(basePath, abs)) {
    throw new BundleStoreError("bundle-path-escaped", "bundle entry path escaped the bundle base path");
  }
  return abs;
}

export async function listBundles(basePath: string): Promise<BundleEntry[]> {
  return (await readBundleStore(basePath)).bundles;
}

export async function resolveBundle(input: { basePath: string; ref: BundleRef }): Promise<BundleResolved> {
  const ref = validateBundleRef(input.ref);
  const paths = bundleStorePaths(input.basePath);
  const metadata = await readBundleStore(paths.basePath);
  const entry = metadata.bundles.find((candidate) => bundleRefsEqual(candidate.ref, ref));
  if (entry == null) {
    throw new BundleStoreError("bundle-not-found", `bundle not found for ${ref.key} ${ref.version}`);
  }
  const path = entryPath(paths.basePath, entry);
  const resolvedRealBase = await realpath(paths.basePath);
  const resolvedRealPath = await realpath(path);
  if (!containsPath(resolvedRealBase, resolvedRealPath)) {
    throw new BundleStoreError("bundle-path-escaped", "bundle resolved outside the bundle base path");
  }
  const info = await stat(path);
  if (!info.isDirectory()) throw new BundleStoreError("bundle-path-not-directory", "bundle path must resolve to a directory");
  return {
    basePath: paths.basePath,
    entry,
    metadataPath: paths.metadataPath,
    path,
    ref,
  };
}

export async function addBundle(input: BundleWriteInput): Promise<BundleResolved> {
  const ref = validateBundleRef(input.ref);
  const paths = bundleStorePaths(input.basePath);
  const sourcePath = resolveAbsolutePath(input.sourcePath, "bundle source path");
  await assertDirectoryWithInternalSymlinks(sourcePath);
  const metadata = await readBundleStore(paths.basePath);
  if (metadata.bundles.some((entry) => bundleRefsEqual(entry.ref, ref))) {
    throw new BundleStoreError("bundle-already-exists", `bundle already exists for ${ref.key} ${ref.version}`);
  }

  await mkdir(paths.basePath, { recursive: true });
  const stagingPath = join(paths.basePath, BUNDLE_STAGING_DIR, operationId());
  const finalPath = objectContentPath(paths.basePath, ref);
  await mkdir(resolve(stagingPath, ".."), { recursive: true });
  await cp(sourcePath, stagingPath, { recursive: true, verbatimSymlinks: true });
  await mkdir(resolve(finalPath, ".."), { recursive: true });
  await rename(stagingPath, finalPath);

  const entry: BundleEntry = {
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    digest: {
      algorithm: "sha256",
      value: await digestDirectory(finalPath),
    },
    path: relativeStorePath(paths.basePath, finalPath),
    ref,
  };
  await writeBundleStore(paths.basePath, {
    bundles: [...metadata.bundles, entry].sort((a, b) => `${a.ref.key}\0${a.ref.version}`.localeCompare(`${b.ref.key}\0${b.ref.version}`)),
    version: BUNDLE_STORE_VERSION,
  });
  return await resolveBundle({ basePath: paths.basePath, ref });
}

export async function replaceBundle(input: BundleWriteInput): Promise<BundleResolved> {
  const ref = validateBundleRef(input.ref);
  const paths = bundleStorePaths(input.basePath);
  const sourcePath = resolveAbsolutePath(input.sourcePath, "bundle source path");
  await assertDirectoryWithInternalSymlinks(sourcePath);
  const metadata = await readBundleStore(paths.basePath);
  const existing = metadata.bundles.find((entry) => bundleRefsEqual(entry.ref, ref));
  const existingPath = existing == null ? null : entryPath(paths.basePath, existing);

  await mkdir(paths.basePath, { recursive: true });
  const stagingPath = join(paths.basePath, BUNDLE_STAGING_DIR, operationId());
  const finalPath = objectContentPath(paths.basePath, ref);
  await mkdir(resolve(stagingPath, ".."), { recursive: true });
  await cp(sourcePath, stagingPath, { recursive: true, verbatimSymlinks: true });
  await mkdir(resolve(finalPath, ".."), { recursive: true });
  await rename(stagingPath, finalPath);

  const nextEntry: BundleEntry = {
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    digest: {
      algorithm: "sha256",
      value: await digestDirectory(finalPath),
    },
    path: relativeStorePath(paths.basePath, finalPath),
    ref,
  };
  await writeBundleStore(paths.basePath, {
    bundles: [
      ...metadata.bundles.filter((entry) => !bundleRefsEqual(entry.ref, ref)),
      nextEntry,
    ].sort((a, b) => `${a.ref.key}\0${a.ref.version}`.localeCompare(`${b.ref.key}\0${b.ref.version}`)),
    version: BUNDLE_STORE_VERSION,
  });
  if (existingPath != null) {
    await rm(existingPath, { force: true, recursive: true }).catch(() => undefined);
  }
  return await resolveBundle({ basePath: paths.basePath, ref });
}

export async function deleteBundle(input: { basePath: string; ref: BundleRef }): Promise<boolean> {
  const ref = validateBundleRef(input.ref);
  const paths = bundleStorePaths(input.basePath);
  const metadata = await readBundleStore(paths.basePath);
  const existing = metadata.bundles.find((entry) => bundleRefsEqual(entry.ref, ref));
  if (existing == null) return false;
  const existingPath = entryPath(paths.basePath, existing);
  await writeBundleStore(paths.basePath, {
    bundles: metadata.bundles.filter((entry) => !bundleRefsEqual(entry.ref, ref)),
    version: BUNDLE_STORE_VERSION,
  });
  await rm(existingPath, { force: true, recursive: true }).catch(() => undefined);
  return true;
}

export async function deleteBundleKey(input: { basePath: string; key: string }): Promise<number> {
  const key = validateBundleKey(input.key);
  const paths = bundleStorePaths(input.basePath);
  const metadata = await readBundleStore(paths.basePath);
  const removed = metadata.bundles.filter((entry) => entry.ref.key === key);
  if (removed.length === 0) return 0;
  const removedPaths = removed.map((entry) => entryPath(paths.basePath, entry));
  await writeBundleStore(paths.basePath, {
    bundles: metadata.bundles.filter((entry) => entry.ref.key !== key),
    version: BUNDLE_STORE_VERSION,
  });
  await Promise.all(removedPaths.map((path) => rm(path, { force: true, recursive: true }).catch(() => undefined)));
  return removed.length;
}
