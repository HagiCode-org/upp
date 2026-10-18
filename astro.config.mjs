import { defineConfig } from 'astro/config';
import { hagilight, hagilightFavicon } from '@hagicode/hagilight/integration';

// The site URL feeds sitemap, canonical links and metadata. Hosting activation is a separate stage.
export default defineConfig({
  site: process.env.UPP_SITE_URL ?? 'https://status.hagicode.com',
  output: 'static',
  integrations: [hagilight({ rss: false, llms: false }), hagilightFavicon()],
});
