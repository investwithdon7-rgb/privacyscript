/** @type {import('next').NextConfig} */

// PrivacyScript is hosted under tekdruid.com/privacyscript (single-origin SEO
// strategy — see README "Deployment"). A Cloudflare Worker on the tekdruid.com
// zone proxies /privacyscript* to the Pages deployment at
// privacyscript.pages.dev. Everything else hits Bluehost as today.
//
// The basePath / assetPrefix below make Next emit URLs prefixed with
// /privacyscript so the worker proxy returns the right files. Locally, you can
// override with `NEXT_PUBLIC_BASE_PATH=""` for a root-mounted dev experience.

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/privacyscript';

const nextConfig = {
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
  trailingSlash: true,
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    return config;
  },
};

module.exports = nextConfig;
