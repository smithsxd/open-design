import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BundleStoreError,
  addBundle,
  BUNDLE_PUBLICATION_FILE,
  BUNDLE_PUBLICATION_LATEST_TAG,
  deleteBundle,
  deleteBundleKey,
  createBundleEpochVersion,
  readBundlePublication,
  listBundles,
  parseBundleEpochVersion,
  replaceBundle,
  resolveBundleArtifact,
  resolveBundleEntryPath,
  resolveBundle,
  resolveBundleBasePath,
  selectBundlePublicationVariant,
  validateBundleDescriptor,
  validateBundlePublication,
  validateBundleRef,
  writeBundlePublication,
} from "../src/index.js";

let roots: string[] = [];

async function tempRoot(label: string): Promise<string> {
  const root = join(tmpdir(), `od-bundle-${label}-${process.pid}-${Date.now()}-${roots.length}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

async function sourceTree(label: string, files: Record<string, string>): Promise<string> {
  const root = await tempRoot(label);
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  return root;
}

function fixtureArtifact(name = "bundle.tar") {
  return {
    artifact: {
      format: "tar",
      sha256: "a".repeat(64),
      size: 12,
      url: name,
    },
  } as const;
}

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
});

describe("bundle refs", () => {
  it("validates object refs without accepting compressed string semantics", () => {
    expect(validateBundleRef({ key: "od:sidecar:web", version: "0.8.0-beta.7+bundle.3" })).toEqual({
      key: "od:sidecar:web",
      version: "0.8.0-beta.7+bundle.3",
    });
    expect(() => validateBundleRef("od:sidecar:web@0.8.0" as never)).toThrow(BundleStoreError);
    expect(() => validateBundleRef({ key: "od/sidecar/web", version: "1" })).toThrow(BundleStoreError);
    expect(() => validateBundleRef({ key: "od:sidecar:web", version: "../1" })).toThrow(BundleStoreError);
  });

  it("resolves bundle base path from explicit value, env, then namespace data path", () => {
    expect(resolveBundleBasePath({
      explicitBasePath: "/tmp/explicit-bundles",
      env: { OD_BUNDLE_BASE_PATH: "/tmp/env-bundles" },
      namespaceDataPath: "/tmp/ns-data",
    })).toBe("/tmp/explicit-bundles");
    expect(resolveBundleBasePath({
      env: { OD_BUNDLE_BASE_PATH: "/tmp/env-bundles" },
      namespaceDataPath: "/tmp/ns-data",
    })).toBe("/tmp/env-bundles");
    expect(resolveBundleBasePath({
      env: {},
      namespaceDataPath: "/tmp/ns-data",
    })).toBe("/tmp/ns-data/bundles");
  });
});

describe("bundle epoch versions", () => {
  it("parses host epoch, bundle slug, and monotonic sequence", () => {
    expect(parseBundleEpochVersion("0.8.0.web.1")).toEqual({
      epoch: "0.8.0",
      sequence: 1,
      slug: "web",
      version: "0.8.0.web.1",
    });
    expect(parseBundleEpochVersion("0.8.0-beta.4.web.12")).toEqual({
      epoch: "0.8.0-beta.4",
      sequence: 12,
      slug: "web",
      version: "0.8.0-beta.4.web.12",
    });
    expect(parseBundleEpochVersion("0.8.0-alpha.0.web.1").epoch).toBe("0.8.0-alpha.0");
    expect(createBundleEpochVersion({ epoch: "0.8.0-beta.4", sequence: 3, slug: "web" })).toBe("0.8.0-beta.4.web.3");
  });

  it("rejects ambiguous or non-monotonic bundle epoch versions", () => {
    expect(() => parseBundleEpochVersion("dev.1")).toThrow(BundleStoreError);
    expect(() => parseBundleEpochVersion("0.8.0-beta.web.1")).toThrow(BundleStoreError);
    expect(() => parseBundleEpochVersion("0.8.0.web.0")).toThrow(BundleStoreError);
    expect(() => createBundleEpochVersion({ epoch: "0.8.0", sequence: 1, slug: "Web" })).toThrow(BundleStoreError);
  });
});

describe("bundle artifact descriptors", () => {
  it("validates the minimal direct bundle descriptor shape", () => {
    expect(validateBundleDescriptor({
      entry: { kind: "tsx", path: "sidecar/index.ts" },
      schemaVersion: 1,
    })).toEqual({
      entry: { kind: "tsx", path: "sidecar/index.ts" },
      schemaVersion: 1,
    });
    expect(validateBundleDescriptor({
      entry: { kind: "js", path: "sidecar/index.mjs" },
      schemaVersion: 1,
    })).toEqual({
      entry: { kind: "js", path: "sidecar/index.mjs" },
      schemaVersion: 1,
    });
    expect(() => validateBundleDescriptor({ entry: { kind: "ts", path: "sidecar/index.ts" }, schemaVersion: 1 })).toThrow(BundleStoreError);
    expect(() => validateBundleDescriptor({ entry: { kind: "tsx", path: "/tmp/entry.ts" }, schemaVersion: 1 })).toThrow(BundleStoreError);
    expect(() => validateBundleDescriptor({
      entry: { kind: "tsx", path: "sidecar/index.ts" },
      schemaVersion: 1,
      web: { outputMode: "standalone" },
    })).toThrow(BundleStoreError);
    expect(() => validateBundleDescriptor({ entry: { kind: "tsx", path: "../entry.ts" }, schemaVersion: 1 })).not.toThrow();
    expect(() => resolveBundleEntryPath({
      bundlePath: "/tmp/bundle",
      descriptor: { entry: { kind: "tsx", path: "../entry.ts" }, schemaVersion: 1 },
    })).toThrow(BundleStoreError);
  });

  it("validates schemaVersion=2 descriptors with bundle ref metadata and target extensions", () => {
    expect(validateBundleDescriptor({
      entry: { kind: "js", path: "sidecar/index.mjs" },
      key: "od:sidecar:web",
      schemaVersion: 2,
      version: "0.8.0-beta.4.web.1",
      web: { outputMode: "standalone", standaloneRoot: "web/standalone" },
    })).toEqual({
      entry: { kind: "js", path: "sidecar/index.mjs" },
      key: "od:sidecar:web",
      schemaVersion: 2,
      version: "0.8.0-beta.4.web.1",
      web: { outputMode: "standalone", standaloneRoot: "web/standalone" },
    });
    expect(() => validateBundleDescriptor({
      entry: { kind: "js", path: "sidecar/index.mjs" },
      key: "od:sidecar:web",
      schemaVersion: 2,
      version: "dev.1",
    })).toThrow(BundleStoreError);
  });

  it("resolves direct bundle roots through bundle.json", async () => {
    const bundlePath = await sourceTree("direct-bundle", {
      "bundle.json": JSON.stringify({
        entry: { kind: "js", path: "sidecar/index.mjs" },
        schemaVersion: 1,
      }),
      "sidecar/index.mjs": "export {};\n",
    });

    await expect(resolveBundleArtifact(bundlePath)).resolves.toMatchObject({
      bundlePath,
      descriptor: {
        entry: { kind: "js", path: "sidecar/index.mjs" },
        schemaVersion: 1,
      },
      entryPath: join(bundlePath, "sidecar", "index.mjs"),
    });
  });

  it("rejects direct bundle descriptors whose entry escapes the bundle root", async () => {
    const bundlePath = await sourceTree("escaped-direct-bundle", {
      "bundle.json": JSON.stringify({
        entry: { kind: "tsx", path: "../outside.ts" },
        schemaVersion: 1,
      }),
      "sidecar/index.ts": "export {};\n",
    });

    await expect(resolveBundleArtifact(bundlePath)).rejects.toMatchObject({ code: "bundle-entry-path-escaped" });
  });
});

describe("bundle publications", () => {
  it("validates explicit bundle key/pathKey metadata and selects platform variants", async () => {
    const publication = validateBundlePublication({
      bundle: {
        key: "od:sidecar:web",
        pathKey: "od-sidecar-web",
        variants: [
          {
            ...fixtureArtifact("any.tar"),
            compatible: { hostEpoch: "0.8.0-beta.4" },
            platform: "any",
            version: "0.8.0-beta.4.web.1",
          },
          {
            ...fixtureArtifact("darwin-arm64.tar"),
            compatible: { hostEpoch: "0.8.0-beta.4" },
            platform: "darwin-arm64",
            version: "0.8.0-beta.4.web.2",
          },
        ],
      },
      metadata: {
        channel: "beta",
        display: {
          summary: { default: "Fast web bundle" },
          title: { default: "Web beta" },
          version: "Beta 4",
        },
        publish: {},
        version: "0.8.0-beta.4",
      },
      schemaVersion: 1,
    });

    expect(selectBundlePublicationVariant({
      hostEpoch: "0.8.0-beta.4",
      key: "od:sidecar:web",
      platform: "darwin-arm64",
      publication,
    })).toMatchObject({ platform: "darwin-arm64", version: "0.8.0-beta.4.web.2" });
    expect(selectBundlePublicationVariant({
      hostEpoch: "0.8.0-beta.4",
      key: "od:sidecar:web",
      platform: "linux-x64",
      publication,
    })).toMatchObject({ platform: "any", version: "0.8.0-beta.4.web.1" });
    expect(() => selectBundlePublicationVariant({
      hostEpoch: "0.8.0-beta.4",
      key: "od:sidecar:daemon",
      platform: "darwin-arm64",
      publication,
    })).toThrow(BundleStoreError);
    expect(() => selectBundlePublicationVariant({
      hostEpoch: "0.8.0-beta.5",
      key: "od:sidecar:web",
      platform: "darwin-arm64",
      publication,
    })).toThrow(BundleStoreError);
  });

  it("writes publication.json plus an independent sha256 file under pathKey/channel/tag", async () => {
    const basePath = await tempRoot("publication-store");
    const publication = {
      bundle: {
        key: "od:sidecar:web",
        pathKey: "od-sidecar-web",
        variants: [
          {
            ...fixtureArtifact(),
            compatible: { hostEpoch: "0.8.0-beta.4" },
            platform: "any",
            version: "0.8.0-beta.4.web.1",
          },
        ],
      },
      metadata: {
        channel: "beta",
        display: {
          summary: { default: "" },
          title: { default: "" },
          version: "0.8.0 beta",
        },
        publish: {},
        version: "0.8.0-beta.4",
      },
      schemaVersion: 1,
    };

    const versioned = await writeBundlePublication({ basePath, publication });
    const tagged = await writeBundlePublication({
      basePath,
      publication,
      versionOrTag: BUNDLE_PUBLICATION_LATEST_TAG,
    });

    expect(versioned.paths.publicationPath).toBe(join(basePath, "od-sidecar-web", "beta", "0.8.0-beta.4", BUNDLE_PUBLICATION_FILE));
    expect(tagged.paths.publicationPath).toBe(join(basePath, "od-sidecar-web", "beta", "latest", BUNDLE_PUBLICATION_FILE));
    expect(await readFile(versioned.paths.digestPath, "utf8")).toContain(versioned.digest.value);
    await expect(readBundlePublication({
      basePath,
      channel: "beta",
      pathKey: "od-sidecar-web",
      versionOrTag: "0.8.0-beta.4",
    })).resolves.toMatchObject({
      digest: versioned.digest,
      publication: { bundle: { key: "od:sidecar:web", pathKey: "od-sidecar-web" } },
    });
  });

  it("rejects duplicate variants and host epoch mismatches", () => {
    expect(() => validateBundlePublication({
      bundle: {
        key: "od:sidecar:web",
        pathKey: "od-sidecar-web",
        variants: [
          {
            ...fixtureArtifact(),
            compatible: { hostEpoch: "0.8.0-beta.4" },
            platform: "any",
            version: "0.8.0-beta.5.web.1",
          },
        ],
      },
      metadata: { channel: "beta", publish: {}, version: "0.8.0-beta.4" },
      schemaVersion: 1,
    })).toThrow(/hostEpoch/);
    expect(() => validateBundlePublication({
      bundle: {
        key: "od:sidecar:web",
        pathKey: "od-sidecar-web",
        variants: [
          {
            ...fixtureArtifact("one.tar"),
            compatible: { hostEpoch: "0.8.0-beta.4" },
            platform: "any",
            version: "0.8.0-beta.4.web.1",
          },
          {
            ...fixtureArtifact("two.tar"),
            compatible: { hostEpoch: "0.8.0-beta.4" },
            platform: "any",
            version: "0.8.0-beta.4.web.2",
          },
        ],
      },
      metadata: { channel: "beta", publish: {}, version: "0.8.0-beta.4" },
      schemaVersion: 1,
    })).toThrow(/duplicate variant/);
  });

  it("rejects unsupported publication fields with zod path context", () => {
    try {
      validateBundlePublication({
        bundle: {
          key: "od:sidecar:web",
          pathKey: "od-sidecar-web",
          variants: [
            {
              ...fixtureArtifact(),
              compatible: { hostEpoch: "0.8.0-beta.4" },
              platform: "any",
              version: "0.8.0-beta.4.web.1",
            },
          ],
        },
        metadata: {
          channel: "beta",
          display: {
            badge: "beta",
            version: "0.8.0 beta",
          },
          publish: {},
          version: "0.8.0-beta.4",
        },
        schemaVersion: 1,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BundleStoreError);
      expect((error as BundleStoreError).code).toBe("bundle-publication-invalid");
      expect((error as Error).message).toContain("bundle publication.metadata.display");
      return;
    }
    throw new Error("expected invalid publication to throw");
  });
});

describe("bundle inventory", () => {
  it("adds, lists, resolves, replaces, and deletes object-addressed bundles", async () => {
    const basePath = await tempRoot("store");
    const source = await sourceTree("source-a", { "server.mjs": "export const marker = 'a';\n" });
    const ref = { key: "od:sidecar:web", version: "dev.1" };

    const added = await addBundle({ basePath, ref, sourcePath: source, now: () => new Date("2026-05-20T00:00:00.000Z") });
    expect(added.ref).toEqual(ref);
    expect(added.entry.createdAt).toBe("2026-05-20T00:00:00.000Z");
    expect(await readFile(join(added.path, "server.mjs"), "utf8")).toContain("marker = 'a'");
    expect(await listBundles(basePath)).toHaveLength(1);

    await expect(addBundle({ basePath, ref, sourcePath: source })).rejects.toMatchObject({ code: "bundle-already-exists" });

    const nextSource = await sourceTree("source-b", { "server.mjs": "export const marker = 'b';\n" });
    const replaced = await replaceBundle({ basePath, ref, sourcePath: nextSource, now: () => new Date("2026-05-20T00:01:00.000Z") });
    expect(replaced.entry.createdAt).toBe("2026-05-20T00:01:00.000Z");
    expect(await readFile(join(replaced.path, "server.mjs"), "utf8")).toContain("marker = 'b'");
    expect(replaced.entry.digest.value).not.toBe(added.entry.digest.value);

    const resolved = await resolveBundle({ basePath, ref });
    expect(resolved.path).toBe(replaced.path);

    expect(await deleteBundle({ basePath, ref })).toBe(true);
    expect(await deleteBundle({ basePath, ref })).toBe(false);
    await expect(resolveBundle({ basePath, ref })).rejects.toMatchObject({ code: "bundle-not-found" });
  });

  it("deletes all versions for a key without touching other keys", async () => {
    const basePath = await tempRoot("delete-key");
    const source = await sourceTree("source", { "entry.mjs": "ok\n" });
    await addBundle({ basePath, ref: { key: "od:sidecar:web", version: "dev.1" }, sourcePath: source });
    await addBundle({ basePath, ref: { key: "od:sidecar:web", version: "dev.2" }, sourcePath: source });
    await addBundle({ basePath, ref: { key: "od:sidecar:daemon", version: "dev.1" }, sourcePath: source });

    expect(await deleteBundleKey({ basePath, key: "od:sidecar:web" })).toBe(2);
    expect((await listBundles(basePath)).map((entry) => entry.ref)).toEqual([{ key: "od:sidecar:daemon", version: "dev.1" }]);
  });

  it("stores bundle content with internal relative symlinks", async () => {
    const basePath = await tempRoot("internal-symlink-store");
    const source = await sourceTree("internal-symlink-source", { "deps/entry.mjs": "ok\n" });
    await symlink("deps/entry.mjs", join(source, "entry-link.mjs"));

    const resolved = await addBundle({
      basePath,
      ref: { key: "od:sidecar:web", version: "dev.1" },
      sourcePath: source,
    });

    const linkPath = join(resolved.path, "entry-link.mjs");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(linkPath)).toBe("deps/entry.mjs");
    expect(await readFile(linkPath, "utf8")).toBe("ok\n");
  });

  it("rejects source trees with external symlinks", async () => {
    const basePath = await tempRoot("symlink-store");
    const source = await sourceTree("symlink-source", { "entry.mjs": "ok\n" });
    await symlink("/tmp", join(source, "escape"));

    await expect(addBundle({
      basePath,
      ref: { key: "od:sidecar:web", version: "dev.1" },
      sourcePath: source,
    })).rejects.toMatchObject({ code: "bundle-source-symlink" });
  });

  it("rejects metadata paths that escape the bundle base path", async () => {
    const basePath = await tempRoot("escaped");
    await writeFile(join(basePath, "metadata.json"), JSON.stringify({
      bundles: [
        {
          createdAt: "2026-05-20T00:00:00.000Z",
          digest: { algorithm: "sha256", value: "x" },
          path: "../outside",
          ref: { key: "od:sidecar:web", version: "dev.1" },
        },
      ],
      version: 1,
    }), "utf8");

    await expect(resolveBundle({ basePath, ref: { key: "od:sidecar:web", version: "dev.1" } })).rejects.toMatchObject({
      code: "bundle-path-escaped",
    });
    await expect(deleteBundle({ basePath, ref: { key: "od:sidecar:web", version: "dev.1" } })).rejects.toMatchObject({
      code: "bundle-path-escaped",
    });
  });

  it("stores bundle content as directories", async () => {
    const basePath = await tempRoot("directory");
    const source = await sourceTree("directory-source", { "entry.mjs": "ok\n" });
    const resolved = await addBundle({ basePath, ref: { key: "od:sidecar:web", version: "dev.1" }, sourcePath: source });
    expect((await lstat(resolved.path)).isDirectory()).toBe(true);
  });
});
