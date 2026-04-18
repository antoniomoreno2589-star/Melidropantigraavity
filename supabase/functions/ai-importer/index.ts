import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const CLIPDROP_API_KEY = Deno.env.get('CLIPDROP_API_KEY') || '';

async function callClaude(prompt: string, imageUrl?: string): Promise<string> {
  const content: any[] = [];

  if (imageUrl) {
    try {
      const imgRes = await fetch(imageUrl);
      const imgBuffer = await imgRes.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(imgBuffer)));
      const mimeType = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
      content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } });
    } catch (e) { console.error("Img error:", e); }
  }

  content.push({ type: 'text', text: prompt });

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, temperature: 0.1, messages: [{ role: 'user', content }] })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude error ${response.status}: ${err}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text?.trim() || '';
}

async function mapAttributes(title: string, description: string, amazonAttrs: any, requiredAttrs: any[]): Promise<any> {
  const attrsForPrompt = requiredAttrs.map(a => {
    const base: any = { id: a.id, name: a.name, required: !!(a.tags?.required || a.tags?.new_required) };
    if (a.values && a.values.length > 0) base.allowed_values = a.values.slice(0, 30).map((v: any) => v.name);
    if (a.hint) base.hint = a.hint;
    return base;
  });

  const brand = Array.isArray(amazonAttrs.brand) ? amazonAttrs.brand[0]?.value : (amazonAttrs.brand || '');
  const color = Array.isArray(amazonAttrs.color) ? amazonAttrs.color[0]?.value : (amazonAttrs.color || '');
  const material = Array.isArray(amazonAttrs.material) ? amazonAttrs.material[0]?.value : (amazonAttrs.material || '');

  const prompt = `Eres experto en MercadoLibre México. Extrae y completa los atributos del producto para publicarlo.

DATOS DEL PRODUCTO (Amazon):
- Título: ${title}
- Descripción: ${description.substring(0, 600)}
- Marca: ${brand}
- Color: ${color}
- Material: ${material}
- Otros atributos: ${JSON.stringify(Object.fromEntries(
    Object.entries(amazonAttrs)
      .filter(([k]) => !['bullet_point'].includes(k))
      .map(([k, v]: any) => [k, Array.isArray(v) ? v[0]?.value ?? v[0] : v])
      .slice(0, 15)
  ))}

ATRIBUTOS A COMPLETAR:
${JSON.stringify(attrsForPrompt)}

INSTRUCCIONES:
1. Responde ÚNICAMENTE con un JSON array: [{"id": "ATTR_ID", "value_name": "valor"}]
2. Para atributos con "allowed_values", usa EXACTAMENTE uno de esos valores (el más apropiado).
3. Para atributos requeridos (required: true) SIEMPRE proporciona un valor, aunque sea inferido del tipo de producto.
4. Para atributos opcionales sin datos claros, puedes omitirlos.
5. Traduce valores al español. Ejemplo: "Black" → "Negro", "New" → "Nuevo".
6. Para BRAND/MARCA usa: "${brand || 'extrae del título'}".
7. NO pongas "N/A", "Desconocido" ni valores inventados para campos de texto libre.
8. NO expliques nada. Solo el JSON array.`;

  const raw = await callClaude(prompt);
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    return JSON.parse(jsonMatch?.[0] || '[]');
  } catch { return []; }
}

async function optimizeTitle(title: string, description: string, brand: string): Promise<string> {
  const prompt = `Eres experto en SEO para MercadoLibre México. Tu tarea es generar un título optimizado.

REGLAS ESTRICTAS:
1. El título debe tener entre 55 y 60 caracteres EXACTOS (cuenta cada letra, espacio y símbolo).
2. Escribe en español natural y fluido, NO traduzcas palabra por palabra.
3. NO incluyas la marca "${brand}" en el título.
4. NO inventes características que no estén en el título o descripción original.
5. Si el título queda corto, añade especificaciones del producto original: material, color, tamaño, uso, cantidad, tipo.
6. Prioriza las palabras más buscadas: tipo de producto + características principales + uso.
7. Responde ÚNICAMENTE con el título, sin comillas, sin explicaciones, sin puntuación al final.

Título original: "${title}"
Descripción/características: "${description.substring(0, 400)}"

IMPORTANTE: Antes de responder, cuenta los caracteres. Si son menos de 55, agrega más detalles del producto. Si son más de 60, recorta. Objetivo: entre 55-60 caracteres.`;

  const result = await callClaude(prompt);
  return result.replace(/^["']|["']$/g, '').replace(/^[\s\-–—,.:;|]+/, '').substring(0, 60).trim();
}

async function cleanImage(imageUrl: string): Promise<{ hadContactInfo: boolean; cleanedImageBase64: string; mimeType: string }> {
  const checkPrompt = `Does this image contain contact information such as phone numbers, email addresses, WhatsApp numbers, website URLs, social media usernames, QR codes, or text watermarks with seller contact details? Reply with only YES or NO.`;
  const answer = await callClaude(checkPrompt, imageUrl);
  const hadContactInfo = answer.toUpperCase().includes('YES');

  if (!hadContactInfo) return { hadContactInfo: false, cleanedImageBase64: '', mimeType: '' };

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error('Failed to fetch image');
  const imgBuffer = await imgRes.arrayBuffer();
  const mimeType = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];

  const formData = new FormData();
  formData.append('image_file', new Blob([imgBuffer], { type: mimeType }), 'image.jpg');

  const clipdropRes = await fetch('https://clipdrop-api.co/remove-text/v1', {
    method: 'POST',
    headers: { 'x-api-key': CLIPDROP_API_KEY },
    body: formData
  });

  if (!clipdropRes.ok) {
    const err = await clipdropRes.text();
    throw new Error(`Clipdrop error ${clipdropRes.status}: ${err}`);
  }

  const cleanedBuffer = await clipdropRes.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(cleanedBuffer)));
  const cleanedMime = clipdropRes.headers.get('content-type') || 'image/png';

  return { hadContactInfo: true, cleanedImageBase64: base64, mimeType: cleanedMime };
}

async function detectCategory(title: string, description: string, productType: string, siteId: string): Promise<any> {
  const prompt = `Categoria ML para: "${title}". Responde solo JSON: {"category_name": "...", "search_term": "...", "confidence": 0.9}`;
  const raw = await callClaude(prompt);
  try { const m = raw.match(/\{[\s\S]*\}/); return JSON.parse(m?.[0] || '{}'); } catch { return {}; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { action, params } = await req.json();
    let result: any;
    if (action === 'optimizeTitle') result = await optimizeTitle(params.title, params.description, params.brand);
    else if (action === 'detectCategory') result = await detectCategory(params.title, params.description, params.productType, params.siteId || 'MLM');
    else if (action === 'mapAttributes') result = await mapAttributes(params.title, params.description, params.amazonAttrs, params.requiredAttrs);
    else if (action === 'cleanImage') result = await cleanImage(params.imageUrl);
    return new Response(JSON.stringify({ success: true, data: result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) { return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }); }
});
