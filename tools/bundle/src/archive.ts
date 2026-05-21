import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { toolError } from "./errors.js";

export type BundleTarArchive = {
  contentType: "application/x-tar";
  format: "tar";
  path: string;
  sha256: string;
  size: number;
};

function commandFailed(command: string, args: string[], code: number | null, signal: NodeJS.Signals | null): Error {
  const suffix = signal == null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
  return toolError(`command failed with ${suffix}: ${[command, ...args].map((part) => JSON.stringify(part)).join(" ")}`);
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
      const error = commandFailed(command, args, code, signal);
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (detail.length > 0) error.message = `${error.message}\n${detail}`;
      rejectCommand(error);
    });
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

export async function createBundleTarArchive(input: {
  archivePath: string;
  bundlePath: string;
}): Promise<BundleTarArchive> {
  await mkdir(path.dirname(input.archivePath), { recursive: true });
  await run("tar", ["-cf", input.archivePath, "-C", input.bundlePath, "."]);
  const info = await stat(input.archivePath);
  return {
    contentType: "application/x-tar",
    format: "tar",
    path: input.archivePath,
    sha256: await sha256File(input.archivePath),
    size: info.size,
  };
}
