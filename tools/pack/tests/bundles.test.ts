import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bundlePublicationDigest, resolveBundle } from "@open-design/bundle";

import { fetchRemoteBundlePublication, installRemoteBundleArtifact } from "../src/bundle-remote.js";
import {
  activatePackagedBuiltinWebBundle,
  activatePackagedWebBundle,
  readPackagedWebBundleActivation,
  readPackagedWebBundleStatus,
} from "../src/bundles.js";
import type { ToolPackConfig } from "../src/config.js";

function makeConfig(root: string): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace: "bundle-smoke",
    platform: "mac",
    portable: false,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    roots: {
      output: {
        appBuilderRoot: join(root, "out", "builder"),
        namespaceRoot: join(root, "out"),
        platformRoot: join(root, "out"),
        root: join(root, "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, "runtime", "namespaces"),
        namespaceRoot: join(root, "runtime", "namespaces", "bundle-smoke"),
      },
      cacheRoot: join(root, "cache"),
      toolPackRoot: root,
    },
    silent: true,
    signed: false,
    to: "app",
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (address == null || typeof address === "string") throw new Error("server did not listen on TCP");
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error == null ? resolveClose() : rejectClose(error)));
  });
}

async function createTarArchive(input: { archivePath: string; root: string }): Promise<void> {
  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn("tar", ["-cf", input.archivePath, "-C", input.root, "."], {
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
      rejectCommand(new Error(Buffer.concat(stderr).toString("utf8") || `tar failed with ${code ?? signal ?? "unknown"}`));
    });
  });
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function startBundleHttpFixture(root: string): Promise<{ close(): Promise<void>; origin: string }> {
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const filePath = join(root, ...pathname.split("/").filter(Boolean));
      try {
        response.end(await readFile(filePath));
      } catch {
        response.statusCode = 404;
        response.end("not found");
      }
    })();
  });
  const origin = await listen(server);
  return {
    close: () => close(server),
    origin,
  };
}

describe("packaged web bundle activation", () => {
  it("writes and reads a simple key/version activation pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      const config = makeConfig(root);

      const activated = await activatePackagedWebBundle(config, "0.8.0-beta.4.web.2");
      const raw = JSON.parse(await readFile(activated.activationPath, "utf8")) as unknown;

      expect(raw).toEqual({
        bundle: {
          key: "od:sidecar:web",
          version: "0.8.0-beta.4.web.2",
        },
        schemaVersion: 1,
      });
      await expect(readPackagedWebBundleActivation(config)).resolves.toMatchObject({
        source: "bundle",
        version: "0.8.0-beta.4.web.2",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists publication presentation with a bundle activation pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      const config = makeConfig(root);
      const presentation = {
        channel: "beta",
        display: {
          summary: { default: "Fresh web runtime" },
          title: { default: "Web Bundle" },
          version: "Beta 4 web 7",
        },
        version: "0.8.0-beta.4",
      };

      const activated = await activatePackagedWebBundle(config, "0.8.0-beta.4.web.7", presentation);

      expect(JSON.parse(await readFile(activated.activationPath, "utf8"))).toEqual({
        bundle: {
          key: "od:sidecar:web",
          version: "0.8.0-beta.4.web.7",
        },
        presentation,
        schemaVersion: 1,
      });
      await expect(readPackagedWebBundleActivation(config)).resolves.toMatchObject({
        presentation,
        source: "bundle",
        version: "0.8.0-beta.4.web.7",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("can switch the pointer back to builtin", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      const config = makeConfig(root);

      await activatePackagedWebBundle(config, "0.8.0.web.1");
      const builtin = await activatePackagedBuiltinWebBundle(config);

      expect(JSON.parse(await readFile(builtin.activationPath, "utf8"))).toEqual({
        bundle: {
          key: "od:sidecar:web",
          source: "builtin",
        },
        schemaVersion: 1,
      });
      await expect(readPackagedWebBundleActivation(config)).resolves.toMatchObject({
        source: "builtin",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects non-web bundle versions before writing activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      await expect(activatePackagedWebBundle(makeConfig(root), "0.8.0.daemon.1")).rejects.toThrow(/\.web\.M/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("falls back to offline activation status when packaged IPC is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      const config = makeConfig(root);
      await activatePackagedWebBundle(config, "0.8.0.web.1");

      await expect(readPackagedWebBundleStatus(config)).resolves.toMatchObject({
        mode: "offline",
        source: "bundle",
        version: "0.8.0.web.1",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("remote bundle publication downloads", () => {
  it("fetches a publication, verifies the tar artifact, and imports it into the bundle store", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      const config = makeConfig(root);
      const served = join(root, "served", "od-sidecar-web", "beta", "latest");
      const bundleRoot = join(root, "bundle");
      await mkdir(join(bundleRoot, "sidecar"), { recursive: true });
      await writeFile(join(bundleRoot, "sidecar", "index.mjs"), "export {};\n", "utf8");
      await writeFile(join(bundleRoot, "bundle.json"), `${JSON.stringify({
        entry: { kind: "js", path: "sidecar/index.mjs" },
        key: "od:sidecar:web",
        schemaVersion: 2,
        version: "0.8.0-beta.4.web.9",
      }, null, 2)}\n`, "utf8");
      await mkdir(served, { recursive: true });
      const archivePath = join(served, "bundle.tar");
      await createTarArchive({ archivePath, root: bundleRoot });
      const archiveSha256 = await sha256File(archivePath);
      const publication = {
        bundle: {
          key: "od:sidecar:web",
          pathKey: "od-sidecar-web",
          variants: [
            {
              artifact: {
                format: "tar",
                sha256: archiveSha256,
                url: "bundle.tar",
              },
              compatible: { hostEpoch: "0.8.0-beta.4" },
              platform: "any",
              version: "0.8.0-beta.4.web.9",
            },
          ],
        },
        metadata: { channel: "beta", publish: {}, version: "0.8.0-beta.4" },
        schemaVersion: 1,
      };
      const publicationContent = `${JSON.stringify(publication, null, 2)}\n`;
      await writeFile(join(served, "publication.json"), publicationContent, "utf8");
      await writeFile(join(served, "publication.json.sha256"), `${bundlePublicationDigest(publicationContent).value}  publication.json\n`, "utf8");
      const server = await startBundleHttpFixture(join(root, "served"));
      try {
        const publicationUrl = `${server.origin}/od-sidecar-web/beta/latest/publication.json`;
        const remote = await fetchRemoteBundlePublication(publicationUrl);
        const selected = remote.publication.bundle.variants[0];
        expect(selected).toBeDefined();

        const installed = await installRemoteBundleArtifact(config, {
          key: "od:sidecar:web",
          publicationUrl,
          variant: selected!,
        });

        expect(installed.digest.value).toBe(archiveSha256);
        await expect(resolveBundle({
          basePath: installed.bundleBasePath,
          ref: { key: "od:sidecar:web", version: "0.8.0-beta.4.web.9" },
        })).resolves.toMatchObject({ path: installed.resolved.path });
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
