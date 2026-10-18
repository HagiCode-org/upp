import type { APIRoute } from 'astro';
import { loadStatusData, serializeSnapshot } from '../lib/load-status.mjs';

// Same loader and serializer as the page, so the JSON bytes match the rendered observations.
export const GET: APIRoute = async () => {
  const { snapshot } = await loadStatusData();
  return new Response(serializeSnapshot(snapshot), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
