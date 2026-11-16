import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The MongoDB driver and the embedded mongod binary must stay outside the bundle.
  serverExternalPackages: ["mongodb", "mongodb-memory-server"],
};

export default nextConfig;
