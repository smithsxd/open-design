import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startBundleFixtureServer } from "../src/bundle-fixture.js";

describe("bundle fixture server", () => {
  it("serves publication files and tar artifacts from a registry root", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-serve-bundle-"));
    try {
      const publicationDir = join(root, "od-sidecar-web", "beta", "latest");
      await mkdir(publicationDir, { recursive: true });
      await writeFile(join(publicationDir, "publication.json"), "{\"schemaVersion\":1}\n", "utf8");
      await writeFile(join(publicationDir, "publication.json.sha256"), `${"a".repeat(64)}  publication.json\n`, "utf8");
      await writeFile(join(publicationDir, "bundle.tar"), "tar bytes", "utf8");

      const server = await startBundleFixtureServer({ registryBasePath: root });
      try {
        const publicationUrl = `${server.info.rootUrl}od-sidecar-web/beta/latest/publication.json`;
        const publication = await fetch(publicationUrl);
        expect(publication.headers.get("content-type")).toContain("application/json");
        expect(await publication.text()).toBe("{\"schemaVersion\":1}\n");

        const digest = await fetch(`${publicationUrl}.sha256`);
        expect(digest.headers.get("content-type")).toContain("text/plain");
        expect(await digest.text()).toContain("publication.json");

        const artifact = await fetch(new URL("bundle.tar", publicationUrl));
        expect(artifact.headers.get("content-type")).toContain("application/x-tar");
        expect(await artifact.text()).toBe("tar bytes");
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not serve paths outside the registry root", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-serve-bundle-"));
    try {
      const server = await startBundleFixtureServer({ registryBasePath: root });
      try {
        const response = await fetch(`${server.info.rootUrl}..%2Foutside`);
        expect(response.status).toBe(400);
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
