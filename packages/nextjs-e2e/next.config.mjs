/** @type {import('next').NextConfig} */
export default {
  // The fixture only has to COMPILE — the assertion is about what lands in each runtime's graph.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};
