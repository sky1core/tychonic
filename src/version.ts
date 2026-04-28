import { readFileSync } from "node:fs";

interface PackageManifest {
  version?: unknown;
}

function readProductVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as PackageManifest;
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("package.json must contain a non-empty version string");
  }
  return manifest.version;
}

export const productVersion = readProductVersion();
