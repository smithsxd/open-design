import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  addBundleToStore,
  deleteBundleFromStore,
  listBundleStore,
  packBundle,
  packBundleToStore,
  publishBundle,
  resolveBundleFromStore,
  validateBundlePath,
} from "../src/index.js";

async function tempRoot(label: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), `od-tools-bundle-${label}-`));
}

async function withTempRoot(label: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await tempRoot(label);
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function makeWebSource(root: string, entry = "sidecar/index.ts"): Promise<string> {
  const source = path.join(root, "source");
  const entryPath = path.join(source, entry);
  const devEntry = path.join(source, "scripts", "dev.ts");
  const standaloneRoot = path.join(source, ".next", "standalone");
  const standaloneWebRoot = path.join(standaloneRoot, "apps", "web");
  const pnpmHoistRoot = path.join(standaloneRoot, "node_modules", ".pnpm", "node_modules");
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, "export {};\n", "utf8");
  await mkdir(path.dirname(devEntry), { recursive: true });
  await writeFile(devEntry, "export {};\n", "utf8");
  await mkdir(standaloneWebRoot, { recursive: true });
  await writeFile(path.join(standaloneWebRoot, "server.js"), "console.log('standalone');\n", "utf8");
  await mkdir(path.join(standaloneRoot, "node_modules", "next"), { recursive: true });
  await writeFile(path.join(standaloneRoot, "node_modules", "next", "package.json"), "{\"name\":\"next\"}\n", "utf8");
  await mkdir(path.join(standaloneRoot, "node_modules", ".pnpm", "pkg@1", "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(standaloneRoot, "node_modules", ".pnpm", "pkg@1", "node_modules", "pkg", "package.json"), "{\"name\":\"pkg\"}\n", "utf8");
  await mkdir(path.join(standaloneRoot, "node_modules", ".pnpm", "sharp@1", "node_modules", "sharp"), { recursive: true });
  await writeFile(path.join(standaloneRoot, "node_modules", ".pnpm", "sharp@1", "node_modules", "sharp", "package.json"), "{\"name\":\"sharp\"}\n", "utf8");
  await mkdir(pnpmHoistRoot, { recursive: true });
  await symlink("../pkg@1/node_modules/pkg", path.join(pnpmHoistRoot, "pkg"));
  await symlink("../sharp@1/node_modules/sharp", path.join(pnpmHoistRoot, "sharp"));
  await mkdir(path.join(source, ".next", "static", "chunks"), { recursive: true });
  await writeFile(path.join(source, ".next", "static", "chunks", "app.js"), "console.log('chunk');\n", "utf8");
  await mkdir(path.join(source, "public"), { recursive: true });
  await writeFile(path.join(source, "public", "favicon.ico"), "ico\n", "utf8");
  await writeFile(path.join(source, "bundle.json"), `${JSON.stringify({
    entry: { kind: "tsx", path: "scripts/dev.ts" },
    schemaVersion: 1,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(source, "package.json"), "{\"name\":\"@open-design/web\"}\n", "utf8");
  return source;
}

async function makeDaemonSource(root: string, packageName = "@open-design/daemon"): Promise<string> {
  const source = path.join(root, "daemon-source");
  await mkdir(path.join(source, "dist", "sidecar"), { recursive: true });
  await writeFile(path.join(source, "dist", "sidecar", "index.js"), "console.log('daemon sidecar');\n", "utf8");
  await writeFile(path.join(source, "dist", "cli.js"), "console.log('daemon cli');\n", "utf8");
  await writeFile(path.join(source, "package.json"), `${JSON.stringify({
    name: packageName,
    type: "module",
  })}\n`, "utf8");
  await writeFile(path.join(source, "bundle.json"), `${JSON.stringify({
    entry: { kind: "tsx", path: "scripts/dev.ts" },
    schemaVersion: 1,
  }, null, 2)}\n`, "utf8");
  return source;
}

async function writeLargeFixture(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${"same-resource-payload\n".repeat(1200)}`, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("tools-bundle", () => {
  it("packs and validates a standalone web bundle", async () => {
    await withTempRoot("pack", async (root) => {
      const sourcePath = await makeWebSource(root);
      const outPath = path.join(root, "bundle");

      const artifact = await packBundle({ app: "web", outPath, sourcePath });

      assert.equal(artifact.bundlePath, outPath);
      assert.deepEqual(artifact.descriptor, {
        entry: { kind: "js", path: "sidecar/index.mjs" },
        schemaVersion: 1,
      });
      assert.equal(JSON.parse(await readFile(path.join(sourcePath, "bundle.json"), "utf8")).entry.path, "scripts/dev.ts");
      assert.equal(await readFile(path.join(outPath, "bundle.json"), "utf8"), `${JSON.stringify(artifact.descriptor, null, 2)}\n`);
      assert.equal(await exists(path.join(outPath, "sidecar", "index.mjs")), true);
      assert.equal(await exists(path.join(outPath, "web", "standalone", "apps", "web", "server.js")), true);
      assert.equal(await exists(path.join(outPath, "web", "standalone", "apps", "web", ".next", "static", "chunks", "app.js")), true);
      assert.equal(await exists(path.join(outPath, "web", "standalone", "apps", "web", "public", "favicon.ico")), true);
      assert.equal(await exists(path.join(outPath, "package.json")), false);
      assert.deepEqual(await validateBundlePath(outPath), artifact);
    });
  });

  it("detects js web entries when no tsx sidecar entry exists", async () => {
    await withTempRoot("pack-js", async (root) => {
      const sourcePath = await makeWebSource(root, "sidecar/index.mjs");
      const outPath = path.join(root, "bundle");

      const artifact = await packBundle({ app: "web", outPath, sourcePath });

      assert.deepEqual(artifact.descriptor.entry, { kind: "js", path: "sidecar/index.mjs" });
    });
  });

  it("packs a schemaVersion=2 web release descriptor when a version is provided", async () => {
    await withTempRoot("pack-v2", async (root) => {
      const sourcePath = await makeWebSource(root);
      const outPath = path.join(root, "bundle");

      const artifact = await packBundle({
        app: "web",
        outPath,
        sourcePath,
        version: "0.8.0-beta.4.web.1",
      });

      assert.deepEqual(artifact.descriptor, {
        entry: { kind: "js", path: "sidecar/index.mjs" },
        key: "od:sidecar:web",
        schemaVersion: 2,
        version: "0.8.0-beta.4.web.1",
        web: { outputMode: "standalone", standaloneRoot: "web/standalone" },
      });
      assert.equal(await readFile(path.join(outPath, "bundle.json"), "utf8"), `${JSON.stringify(artifact.descriptor, null, 2)}\n`);
    });
  });

  it("packs and validates a daemon bundle", async () => {
    await withTempRoot("pack-daemon", async (root) => {
      const sourcePath = await makeDaemonSource(root);
      const outPath = path.join(root, "bundle");

      const artifact = await packBundle({ app: "daemon", outPath, sourcePath });

      assert.deepEqual(artifact.descriptor, {
        entry: { kind: "js", path: "sidecar/index.mjs" },
        schemaVersion: 1,
      });
      assert.equal(await exists(path.join(outPath, "sidecar", "index.mjs")), true);
      assert.equal(await exists(path.join(outPath, "daemon", "daemon-cli.mjs")), true);
      assert.equal(await exists(path.join(outPath, ".entrypoints")), false);
      assert.equal(await readFile(path.join(outPath, "bundle.json"), "utf8"), `${JSON.stringify(artifact.descriptor, null, 2)}\n`);
      assert.deepEqual(await validateBundlePath(outPath), artifact);
    });
  });

  it("deduplicates identical daemon resource files with internal symlinks", async () => {
    if (process.platform === "win32") return;

    await withTempRoot("pack-daemon-dedupe", async (root) => {
      await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
      const sourcePath = await makeDaemonSource(root, "fixture-daemon");
      const duplicateA = path.join(root, "design-templates", "demo", "asset.txt");
      const duplicateB = path.join(root, "skills", "demo", "asset.txt");
      await writeLargeFixture(duplicateA);
      await writeLargeFixture(duplicateB);

      const outPath = path.join(root, "bundle");
      await packBundle({ app: "daemon", outPath, sourcePath });

      const packedA = path.join(outPath, "daemon", "resources", "design-templates", "demo", "asset.txt");
      const packedB = path.join(outPath, "daemon", "resources", "skills", "demo", "asset.txt");
      assert.equal((await lstat(packedA)).isFile(), true);
      assert.equal((await lstat(packedB)).isSymbolicLink(), true);
      assert.equal(await readlink(packedB), path.relative(path.dirname(packedB), packedA));
      assert.equal(await readFile(packedB, "utf8"), await readFile(packedA, "utf8"));
      await validateBundlePath(outPath);
    });
  });

  it("copies only release runtime content and rejects symlinked sidecar entries", async () => {
    await withTempRoot("pack-excludes", async (root) => {
      const sourcePath = await makeWebSource(root);
      const dependencyTarget = path.join(root, "dependency-target");
      await mkdir(dependencyTarget, { recursive: true });
      await mkdir(path.join(sourcePath, "node_modules"), { recursive: true });
      await symlink(dependencyTarget, path.join(sourcePath, "node_modules", "example"));
      await mkdir(path.join(sourcePath, "dist"), { recursive: true });
      await mkdir(path.join(sourcePath, "out"), { recursive: true });
      await writeFile(path.join(sourcePath, "dist", "old.js"), "old\n", "utf8");
      await writeFile(path.join(sourcePath, "out", "export.txt"), "out\n", "utf8");

      const outPath = path.join(root, "bundle");
      await packBundle({ app: "web", outPath, sourcePath });

      assert.equal(await exists(path.join(outPath, ".next")), false);
      assert.equal(await exists(path.join(outPath, "dist")), false);
      assert.equal(await exists(path.join(outPath, "out")), false);
      assert.equal(await exists(path.join(outPath, "node_modules")), false);
      assert.equal(await exists(path.join(outPath, "web", "standalone", "node_modules", "next", "package.json")), true);
      assert.equal(
        (await lstat(path.join(outPath, "web", "standalone", "node_modules", ".pnpm", "node_modules", "pkg"))).isSymbolicLink(),
        true,
      );
      assert.equal(await readlink(path.join(outPath, "web", "standalone", "node_modules", ".pnpm", "node_modules", "pkg")), "../pkg@1/node_modules/pkg");
      assert.equal(await exists(path.join(outPath, "web", "standalone", "node_modules", ".pnpm", "sharp@1")), false);
      assert.equal(await exists(path.join(outPath, "web", "standalone", "node_modules", ".pnpm", "node_modules", "sharp")), false);

      await rm(path.join(sourcePath, "sidecar", "index.ts"));
      await symlink(path.join(sourcePath, "package.json"), path.join(sourcePath, "sidecar", "index.ts"));
      await assert.rejects(
        packBundle({ app: "web", outPath: path.join(root, "bundle-with-link"), sourcePath }),
        /web sidecar entry must not be a symlink/,
      );
    });
  });

  it("quick-fails when standalone web output is missing", async () => {
    await withTempRoot("pack-missing-standalone", async (root) => {
      const sourcePath = await makeWebSource(root);
      await rm(path.join(sourcePath, ".next", "standalone"), { force: true, recursive: true });

      await assert.rejects(
        packBundle({ app: "web", outPath: path.join(root, "bundle"), sourcePath }),
        /Next\.js standalone output/,
      );
    });
  });

  it("adds, resolves, lists, and deletes direct bundles through the store", async () => {
    await withTempRoot("store", async (root) => {
      const sourcePath = await makeWebSource(root);
      const bundlePath = path.join(root, "bundle");
      const basePath = path.join(root, "store");
      await packBundle({ app: "web", outPath: bundlePath, sourcePath });

      const added = await addBundleToStore({ basePath, bundlePath, version: "dev.1" });
      const resolved = await resolveBundleFromStore({ basePath, refOrVersion: "dev.1" });

      assert.deepEqual(added.ref, { key: "od:sidecar:web", version: "dev.1" });
      assert.equal((await listBundleStore(basePath)).length, 1);
      assert.equal(resolved.artifact.descriptor.entry.path, "sidecar/index.mjs");
      assert.equal(await deleteBundleFromStore({ basePath, refOrVersion: "dev.1" }), true);
      assert.deepEqual(await listBundleStore(basePath), []);
    });
  });

  it("uses schemaVersion=2 descriptor refs when adding bundles to the store", async () => {
    await withTempRoot("store-v2", async (root) => {
      const sourcePath = await makeWebSource(root);
      const bundlePath = path.join(root, "bundle");
      const basePath = path.join(root, "store");
      await packBundle({
        app: "web",
        outPath: bundlePath,
        sourcePath,
        version: "0.8.0.web.1",
      });

      const added = await addBundleToStore({ basePath, bundlePath });

      assert.deepEqual(added.ref, { key: "od:sidecar:web", version: "0.8.0.web.1" });
      await assert.rejects(
        addBundleToStore({ basePath, bundlePath, key: "od:sidecar:daemon", replace: true, version: "0.8.0.web.1" }),
        /must match bundle descriptor ref/,
      );
    });
  });

  it("packs the next epoch-scoped web bundle version into the raw store", async () => {
    await withTempRoot("store-pack", async (root) => {
      const sourcePath = await makeWebSource(root);
      const basePath = path.join(root, "store");

      const first = await packBundleToStore({ app: "web", basePath, epoch: "0.8.0-beta.4", sourcePath });
      const second = await packBundleToStore({ app: "web", basePath, epoch: "0.8.0-beta.4", sourcePath });

      assert.equal(first.version, "0.8.0-beta.4.web.1");
      assert.equal(second.version, "0.8.0-beta.4.web.2");
      assert.deepEqual((await listBundleStore(basePath)).map((entry) => entry.ref.version), [
        "0.8.0-beta.4.web.1",
        "0.8.0-beta.4.web.2",
      ]);
      assert.equal(second.artifact.descriptor.schemaVersion, 2);
      assert.equal(second.artifact.bundlePath, second.resolved.path);
    });
  });

  it("publishes a registry record for an existing raw bundle version", async () => {
    await withTempRoot("publish-record", async (root) => {
      const sourcePath = await makeWebSource(root);
      const bundleBasePath = path.join(root, "store");
      const registryBasePath = path.join(root, "registry");
      const raw = await packBundleToStore({
        app: "web",
        basePath: bundleBasePath,
        epoch: "0.8.0-beta.4",
        sourcePath,
      });

      const result = await publishBundle({
        app: "web",
        bundleBasePath,
        bundleVersion: raw.version,
        channel: "beta",
        displayVersion: "Beta 4 web 1",
        pathKey: "od-sidecar-web",
        registryBasePath,
        summary: "Fresh web runtime",
        tag: "latest",
        title: "Web Bundle",
        version: "0.8.0-beta.4",
      });

      assert.deepEqual(result.raw.ref, { key: "od:sidecar:web", version: "0.8.0-beta.4.web.1" });
      assert.equal(result.publication.bundle.key, "od:sidecar:web");
      assert.equal(result.publication.bundle.pathKey, "od-sidecar-web");
      assert.deepEqual(result.publication.bundle.variants, [
        {
          artifact: {
            contentType: "application/x-tar",
            format: "tar",
            sha256: result.publication.bundle.variants[0]?.artifact.sha256,
            size: result.publication.bundle.variants[0]?.artifact.size,
            url: "bundle.tar",
          },
          compatible: { hostEpoch: "0.8.0-beta.4" },
          platform: "any",
          version: "0.8.0-beta.4.web.1",
        },
      ]);
      assert.match(result.publication.bundle.variants[0]?.artifact.sha256 ?? "", /^[a-f0-9]{64}$/);
      assert.equal(typeof result.publication.bundle.variants[0]?.artifact.size, "number");
      assert.equal(
        result.versioned.paths.publicationPath,
        path.join(registryBasePath, "od-sidecar-web", "beta", "0.8.0-beta.4", "publication.json"),
      );
      assert.equal(
        result.tagged?.paths.publicationPath,
        path.join(registryBasePath, "od-sidecar-web", "beta", "latest", "publication.json"),
      );
      assert.equal(JSON.parse(await readFile(result.versioned.paths.publicationPath, "utf8")).metadata.display.title.default, "Web Bundle");
      assert.match(await readFile(result.versioned.paths.digestPath, "utf8"), /^[a-f0-9]{64}  publication\.json\n$/);
      assert.equal(await exists(path.join(registryBasePath, "od-sidecar-web", "beta", "0.8.0-beta.4", "bundle.tar")), true);
      assert.equal(await exists(path.join(registryBasePath, "od-sidecar-web", "beta", "latest", "bundle.tar")), true);
    });
  });

  it("requires explicit replace for an existing output path", async () => {
    await withTempRoot("replace", async (root) => {
      const sourcePath = await makeWebSource(root);
      const outPath = path.join(root, "bundle");
      await packBundle({ app: "web", outPath, sourcePath });

      await assert.rejects(packBundle({ app: "web", outPath, sourcePath }), /already exists/);
      await assert.doesNotReject(packBundle({ app: "web", outPath, replace: true, sourcePath }));
    });
  });
});
