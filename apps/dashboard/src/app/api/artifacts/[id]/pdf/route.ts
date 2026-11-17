import { apiRequest } from '@/lib/apiServer';

/** Proxies apps/web's GET /api/v1/artifacts/:id/pdf - a download link, same reasoning as the SSE proxy: the browser only ever talks to this app's own origin. Reads the cookie from the incoming Request directly, same reasoning as api/events/stream/route.ts. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const upstream = await apiRequest(request.headers.get('cookie') ?? '', `/api/v1/artifacts/${id}/pdf`);
  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: upstream.status });
  }
  return new Response(upstream.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="resume-${id}.pdf"`,
    },
  });
}
