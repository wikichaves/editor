import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // sharp ships a native binary — keep it external so it isn't bundled by
  // webpack and resolves correctly in the serverless function.
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
