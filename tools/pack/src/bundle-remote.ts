import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUNDLE_DESCRIPTOR_SCHEMA_VERSION_V2,
  bundlePublicationDigest,
  parseBundlePublicationDigest,
  replaceBundle,
  resolveBundleArtifact,
  validateBundlePublication,
  validateBundleRef,
  type BundleArtifact,
  type BundlePublication,
  type BundlePublicationVariant,
  type BundleResolved,
} from "@open-design/bundle";

import type { ToolPackConfig } from "./config.js";

export type RemoteBundlePublication = {
  digest: {
    algorithm: "sha256";
    value: string;
  };
  publication: BundlePublication;
  urls: {
    digestUrl: string;
    publicationUrl: string;
  };
};

export type InstalledRemoteBundleArtifact = {
  artifact: BundleArtifact;
  artifactUrl: string;
  bundleBasePath: string;
  digest: {
    algorithm: "sha256";
    value: string;
  };
  resolved: BundleResolved;
  size: number;
};

function bundleBasePath(config: ToolPackConfig): string {
  return join(config.roots.runtime.namespaceRoot, "data", "bundles");
}

function publicationDigestUrl(publicationUrl: string): string {
  return new URL("publication.json.sha256", publicationUrl).href;
}

function artifactUrl(publicationUrl: string, artifactPath: string): string {
  return new URL(artifactPath, publicationUrl).href;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed ${response.status} ${response.statusText}: ${url}`);
  return response;
}

async function fetchText(url: string): Promise<string> {
  return await (await fetchOk(url)).text();
}

async function downloadFile(url: string, filePath: string): Promise<number> {
  const response = await fetchOk(url);
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, body);
  return body.byteLength;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function commandFailed(command: string, args: string[], code: number | null, signal: NodeJS.Signals | null): Error {
  const suffix = signal == null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
  return new Error(`command failed with ${suffix}: ${[command, ...args].map((part) => JSON.stringify(part)).join(" ")}`);
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectCommand);
    child.once("close", (code, signal) => {
      if (code === 0 && signal == null) {
        resolveCommand();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      const error = commandFailed(command, args, code, signal);
      if (detail.length > 0) error.message = `${error.message}\n${detail}`;
      rejectCommand(error);
    });
  });
}

async function extractTarArchive(input: {
  archivePath: string;
  outputPath: string;
}): Promise<void> {
  await mkdir(input.outputPath, { recursive: true });
  await run("tar", ["-xf", input.archivePath, "-C", input.outputPath]);
}

async function artifactSha256(input: {
  artifact: BundlePublicationVariant["artifact"];
  publicationUrl: string;
}): Promise<string> {
  let expected = input.artifact.sha256?.toLowerCase();
  if (input.artifact.sha256Url != null) {
    const digestUrl = artifactUrl(input.publicationUrl, input.artifact.sha256Url);
    const remoteDigest = parseBundlePublicationDigest(await fetchText(digestUrl)).value;
    if (expected != null && expected !== remoteDigest) {
      throw new Error(`bundle artifact sha256 does not match sha256Url: ${digestUrl}`);
    }
    expected = remoteDigest;
  }
  if (expected == null) throw new Error("bundle publication artifact must provide sha256 or sha256Url");
  return expected;
}

function assertImportedBundle(input: {
  artifact: BundleArtifact;
  key: string;
  version: string;
}): void {
  if (input.artifact.descriptor.schemaVersion !== BUNDLE_DESCRIPTOR_SCHEMA_VERSION_V2) {
    throw new Error("downloaded bundle artifact must contain schemaVersion=2 descriptor metadata");
  }
  if (input.artifact.descriptor.key !== input.key || input.artifact.descriptor.version !== input.version) {
    throw new Error(
      `downloaded bundle descriptor ${input.artifact.descriptor.key}@${input.artifact.descriptor.version} must match ${input.key}@${input.version}`,
    );
  }
}

export async function fetchRemoteBundlePublication(publicationUrl: string): Promise<RemoteBundlePublication> {
  const digestUrl = publicationDigestUrl(publicationUrl);
  const content = await fetchText(publicationUrl);
  const expected = parseBundlePublicationDigest(await fetchText(digestUrl));
  const digest = bundlePublicationDigest(content);
  if (expected.value !== digest.value) {
    throw new Error(`bundle publication digest mismatch for ${publicationUrl}`);
  }
  return {
    digest,
    publication: validateBundlePublication(JSON.parse(content)),
    urls: {
      digestUrl,
      publicationUrl,
    },
  };
}

export async function installRemoteBundleArtifact(
  config: ToolPackConfig,
  input: {
    key: string;
    publicationUrl: string;
    variant: BundlePublicationVariant;
  },
): Promise<InstalledRemoteBundleArtifact> {
  const ref = validateBundleRef({ key: input.key, version: input.variant.version });
  const artifact = input.variant.artifact;
  if (artifact.format !== "tar") throw new Error(`unsupported bundle artifact format: ${artifact.format}`);
  const expectedSha256 = await artifactSha256({ artifact, publicationUrl: input.publicationUrl });
  const tempRoot = await mkdtemp(join(tmpdir(), "od-tools-pack-bundle-download-"));
  try {
    const archivePath = join(tempRoot, "bundle.tar");
    const extractPath = join(tempRoot, "bundle");
    const url = artifactUrl(input.publicationUrl, artifact.url);
    const size = await downloadFile(url, archivePath);
    if (artifact.size != null && artifact.size !== size) {
      throw new Error(`bundle artifact size mismatch for ${url}: expected ${artifact.size}, got ${size}`);
    }
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`bundle artifact sha256 mismatch for ${url}`);
    }
    await extractTarArchive({ archivePath, outputPath: extractPath });
    const basePath = bundleBasePath(config);
    const resolved = await replaceBundle({
      basePath,
      ref,
      sourcePath: extractPath,
    });
    const bundleArtifact = await resolveBundleArtifact(resolved.path);
    assertImportedBundle({ artifact: bundleArtifact, key: ref.key, version: ref.version });
    return {
      artifact: bundleArtifact,
      artifactUrl: url,
      bundleBasePath: basePath,
      digest: {
        algorithm: "sha256",
        value: actualSha256,
      },
      resolved,
      size,
    };
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}
