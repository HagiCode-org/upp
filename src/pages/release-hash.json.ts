import type { APIRoute } from 'astro';
import { loadReleaseData, serializeReleaseSnapshot } from '../lib/load-release-hash.mjs';

// Same loader and serializer as the page, so the JSON states match the rendered rows.
export const GET: APIRoute = async () => {
  const { snapshot } = await loadReleaseData();
  return new Response(serializeReleaseSnapshot(snapshot), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
