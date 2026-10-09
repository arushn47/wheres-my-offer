import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
      ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
    ] }];
  },
  // Disable internal Node.js gzip compression to prevent live SSE streams from being piped into Gzip transform streams with dangling drain listeners. Compression is handled at the edge (Vercel).
  compress: false,
  experimental: {
    staleTimes: {
      dynamic: 60, // Cache dynamic routes in client memory for 60s to make page switching instant
      static: 300,
    },
  },
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

