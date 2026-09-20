import type { NextConfig } from "next";

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

