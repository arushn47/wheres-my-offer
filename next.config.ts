import type { NextConfig } from "next";

// Suppress DEP0169 warning emitted by legacy third-party dependencies (e.g. web-push) on Node 22+
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning: string | Error, ...args: any[]) => {
  if (
    (typeof warning === 'string' && warning.includes('url.parse')) ||
    (typeof warning === 'object' && (warning as { code?: string })?.code === 'DEP0169')
  ) {
    return;
  }
  return (originalEmitWarning as any).call(process, warning, ...args);
};

const nextConfig: NextConfig = {
  // Disable internal Node.js gzip compression to prevent live SSE streams from being piped into Gzip transform streams with dangling drain listeners. Compression is handled at the edge (Vercel).
  compress: false,
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [
          {
            type: 'host',
            value: 'wheresmyoffer.vercel.app',
          },
        ],
        destination: 'https://www.wheresmyoffer.in/:path*',
        permanent: true,
      },
      {
        source: '/:path*',
        has: [
          {
            type: 'host',
            value: 'wheresmyoffer.in',
          },
        ],
        destination: 'https://www.wheresmyoffer.in/:path*',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;

