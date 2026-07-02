// Client-side calls to Mercado Libre / Mercado Pago must go through this Supabase
// Edge Function, not a Vercel serverless function — an open `fetch(any url)` proxy
// on Vercel is flagged as "Never fair use" (proxies/VPNs) and can get the whole
// account suspended. meli-proxy enforces an allowlist of ML/MP hosts server-side.
const MELI_PROXY_URL = 'https://gbdrxwfywxvyoxroqcut.supabase.co/functions/v1/meli-proxy';

interface ProxyRequest {
    url: string;
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
}

export function mlProxyFetch(req: ProxyRequest): Promise<Response> {
    return fetch(MELI_PROXY_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(req),
    });
}
