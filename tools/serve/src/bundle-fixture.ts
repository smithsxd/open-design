import { createServer, type Server } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

export type BundleFixtureOptions = {
  host?: string;
  port?: number;
  registryBasePath: string;
};

export type BundleFixtureInfo = {
  origin: string;
  registryBasePath: string;
  rootUrl: string;
};

export type BundleFixtureServer = {
  close(): Promise<void>;
  info: BundleFixtureInfo;
};

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error == null ? resolveClose() : rejectClose(error)));
  });
}

function serverOrigin(server: Server): string {
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("bundle fixture did not listen on TCP");
  return `http://127.0.0.1:${address.port}`;
}

function containsPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel.length > 0 && !rel.startsWith(".."));
}

function contentType(filePath: string): string {
  if (filePath.endsWith("publication.json")) return "application/json; charset=utf-8";
  if (filePath.endsWith("publication.json.sha256")) return "text/plain; charset=utf-8";
  if (extname(filePath) === ".tar") return "application/x-tar";
  return "application/octet-stream";
}

function resolveRequestPath(root: string, pathname: string): string | null {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const decoded = segments.map((segment) => decodeURIComponent(segment));
  const filePath = resolve(root, ...decoded);
  return containsPath(root, filePath) ? filePath : null;
}

export async function startBundleFixtureServer(options: BundleFixtureOptions): Promise<BundleFixtureServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const registryBasePath = resolve(options.registryBasePath);
  const rootInfo = await lstat(registryBasePath);
  if (!rootInfo.isDirectory()) throw new Error(`bundle fixture registry root must be a directory: ${registryBasePath}`);

  let info: BundleFixtureInfo | null = null;
  const server = createServer((request, response) => {
    void (async () => {
      if (info == null) {
        response.statusCode = 503;
        response.end("fixture not ready");
        return;
      }
      const url = new URL(request.url ?? "/", info.origin);
      const filePath = resolveRequestPath(registryBasePath, url.pathname);
      if (filePath == null) {
        response.statusCode = 400;
        response.end("invalid path");
        return;
      }

      try {
        const fileInfo = await lstat(filePath);
        if (!fileInfo.isFile()) {
          response.statusCode = 404;
          response.end("not found");
          return;
        }
        response.setHeader("content-length", String(fileInfo.size));
        response.setHeader("content-type", contentType(filePath));
        response.end(await readFile(filePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          response.statusCode = 404;
          response.end("not found");
          return;
        }
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  await listen(server, port, host);
  const origin = serverOrigin(server);
  info = {
    origin,
    registryBasePath,
    rootUrl: `${origin}/`,
  };

  return {
    close: () => close(server),
    info,
  };
}
