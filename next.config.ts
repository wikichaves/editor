import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Build a human-readable version string at build time:  vX.Y.Z+<short-sha>.
// The package version is bumped per release; the commit sha (set by Vercel)
// disambiguates redeploys so the footer always tells you exactly what's live.
function appVersion(): string {
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch {
    // keep fallback
  }
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7);
  return `v${version}${sha ? `+${sha}` : "-local"}`;
}

const nextConfig: NextConfig = {
  // sharp ships a native binary — keep it external so it isn't bundled by
  // webpack and resolves correctly in the serverless function.
  serverExternalPackages: ["sharp"],
  // Exposed to the client so the UI can show which build is running.
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion(),
  },
};

export default nextConfig;
