import path from 'node:path';

// HTML and mutable script/config names must revalidate, including clients that have no
// service worker. Versioned bootstrap URLs additionally bypass a prior release's fresh
// HTTP entry. Keep the existing short cache for images/models; API caching is separate.
export function staticCacheOptions(production) {
  return {
    maxAge: production ? '1d' : 0,
    setHeaders(res, file) {
      if (/\.(?:html|m?js|json|webmanifest|css)$/i.test(path.extname(file))) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  };
}
