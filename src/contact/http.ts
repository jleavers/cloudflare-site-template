export interface ContactResponseBody {
  ok: boolean;
  message: string;
  errors?: Record<string, string>;
}

/** Every /api/contact answer: JSON, never cached, never sniffed. */
export function json(status: number, body: ContactResponseBody, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}
