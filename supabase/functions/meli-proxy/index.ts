const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Allowlist: this proxy exists ONLY to work around ML/MP's browser CORS
// restrictions. It must never become a general-purpose "fetch any URL" proxy
// (that pattern gets flagged as abuse by hosting providers).
const ALLOWED_PREFIXES = [
  'https://api.mercadolibre.com',
  'https://api.mercadopago.com',
];

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { url, method, body, headers: customHeaders, multipart } = await req.json();

    console.log(`Proxying ${method || 'GET'} request to: ${url}${multipart ? ' (multipart)' : ''}`);

    if (typeof url !== 'string' || !ALLOWED_PREFIXES.some(p => url.startsWith(p))) {
      return new Response(JSON.stringify({ error: 'Forbidden target URL. Only Mercado Libre / Mercado Pago hosts are allowed.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let response: Response;

    if (multipart) {
      // Binary file upload (e.g. images): reconstruct a real multipart/form-data
      // request server-side. The client can't send a real FormData/Blob through
      // this JSON-only proxy — it base64-encodes the file instead — so this is
      // the one place that payload gets turned back into actual binary.
      const formData = new FormData();
      const blob = base64ToBlob(multipart.base64, multipart.mimeType);
      formData.append(multipart.fieldName || 'file', blob, multipart.fileName || 'file');

      response = await fetch(url, {
        method: method || 'POST',
        headers: { ...customHeaders }, // no Content-Type — fetch sets the multipart boundary itself
        body: formData,
      });
    } else {
      response = await fetch(url, {
        method: method || 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...customHeaders
        },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
    }

    // Files — shipping labels from /shipment_labels are PDFs — go back byte for
    // byte with their own type: reading them as text, as below, corrupts them.
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/json|text|javascript/i.test(contentType)) {
      if (!response.ok) console.error(`ML/MP API Error [${response.status}] for ${url} (${contentType})`);
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': contentType },
      });
    }

    const data = await response.text();

    if (!response.ok) {
        console.error(`ML/MP API Error [${response.status}] for ${url}:`, data);
    }

    return new Response(data, {
      status: response.status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
