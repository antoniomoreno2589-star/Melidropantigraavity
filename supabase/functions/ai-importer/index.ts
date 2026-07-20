const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const CLIPDROP_API_KEY = Deno.env.get('CLIPDROP_API_KEY') || '';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';
// gemini-2.5-flash still shows up in the model-list endpoint but returned a live
// 404 ("no longer available to new users") for this key — the list endpoint
// doesn't reflect real per-key availability. Using Google's own "-latest" alias
// instead of a pinned version number so this doesn't need a code change the next
// time a specific version gets retired.
const GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

// Fallback for when Claude fails (out of credits, rate-limited, transient outage —
// callAI() below doesn't distinguish why, it just needs a second opinion). Mirrors
// callClaude's exact signature/return shape so every existing prompt/parsing call
// site works unchanged regardless of which provider actually answered.
async function callGemini(prompt: string, imageUrl?: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const parts: any[] = [{ text: prompt }];

  if (imageUrl) {
    try {
      const imgRes = await fetch(imageUrl);
      const imgBuffer = await imgRes.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(imgBuffer)));
      const mimeType = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
      parts.push({ inline_data: { mime_type: mimeType, data: base64 } });
    } catch (e) { console.error("Gemini img error:", e); }
  }

  const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini error ${response.status}: ${err}`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

// Single entry point every action below calls instead of callClaude directly —
// tries Claude first (it's the primary, better-quality model), and on ANY failure
// (credits exhausted, rate limit, outage) retries the exact same prompt against
// Gemini's free tier instead of failing the whole request. If GEMINI_API_KEY isn't
// configured yet, this degrades to exactly today's behavior (Claude's error surfaces).
async function callAI(prompt: string, imageUrl?: string): Promise<string> {
  try {
    return await callClaude(prompt, imageUrl);
  } catch (claudeErr) {
    console.error('[ai-importer] Claude failed, falling back to Gemini:', claudeErr);
    try {
      return await callGemini(prompt, imageUrl);
    } catch (geminiErr) {
      throw new Error(`Both AI providers failed. Claude: ${(claudeErr as Error).message} | Gemini: ${(geminiErr as Error).message}`);
    }
  }
}

async function mapAttributes(title: string, description: string, amazonAttrs: any, requiredAttrs: any[]): Promise<any> {
  const attrsForPrompt = requiredAttrs.map(a => {
    const base: any = { id: a.id, name: a.name, required: !!(a.tags?.required || a.tags?.new_required || a.tags?.conditional_required || a.tags?.catalog_required) };
    // BRAND/MARCA's `values` here is only ever a tiny, non-exhaustive sample of ML's
    // real brand catalog (confirmed live against a real category: 3 entries for a
    // catalog that has thousands of real brands) — sending it as allowed_values told
    // the model those were the ONLY valid options, which fought rule 6 below and
    // caused real brand names to get omitted or replaced with an unrelated sample
    // entry. Scoped to BRAND/MARCA specifically — other catalog_required attributes
    // (e.g. PRODUCT_TYPE) can genuinely be a small, complete list, so their
    // allowed_values constraint stays as-is.
    if (a.values && a.values.length > 0 && a.id !== 'BRAND' && a.id !== 'MARCA') {
      base.allowed_values = a.values.slice(0, 60).map((v: any) => v.name);
    }
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
2. Para atributos con "allowed_values", usa EXACTAMENTE uno de esos valores tal cual aparece en la lista, letra por letra — cópialo, no lo redactes de nuevo. NUNCA inventes ni combines opciones (ej. si la lista tiene "12-18 meses" y "18-24 meses", NO generes "12-24 meses" — elige la que mejor aplique de las que SÍ están en la lista). Si ninguna aplica bien, omite el atributo en vez de inventar una.
3. Para atributos requeridos (required: true) SIEMPRE proporciona un valor, aunque sea inferido del tipo de producto — salvo que tenga "allowed_values" y ninguno aplique (ver regla 2).
4. Para atributos opcionales sin datos claros, puedes omitirlos.
5. Traduce valores al español. Ejemplo: "Black" → "Negro", "New" → "Nuevo".
6. Para BRAND/MARCA usa: "${brand || 'extrae del título'}".
7. NO pongas "N/A", "Desconocido" ni valores inventados para campos de texto libre.
8. NO expliques nada. Solo el JSON array.`;

  const raw = await callAI(prompt);
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    return JSON.parse(jsonMatch?.[0] || '[]');
  } catch { return []; }
}

async function optimizeTitle(title: string, description: string, brand: string): Promise<string> {
  const prompt = `Eres experto en SEO para MercadoLibre México. Tu tarea es generar un título optimizado.

REGLAS ESTRICTAS:
1. El título debe tener MÁXIMO 60 caracteres. Lo ideal es entre 45 y 60, pero NUNCA excedas 60.
2. Escribe en español natural y fluido, NO traduzcas palabra por palabra.
3. NO incluyas la marca "${brand}" en el título.
4. NO inventes características que no estén en el título o descripción original.
5. Si el título queda corto, es preferible dejarlo corto y natural antes que rellenar. Solo puedes añadir especificaciones REALES del producto (material, color, tamaño, uso, cantidad, tipo) si aportan valor de búsqueda.
6. PROHIBIDO rellenar para alcanzar caracteres: NO separes letras con guiones (ej. "P-a-r-c"), NO añadas etiquetas como "Conteo:" o "Pieza:", NO repitas palabras, NO agregues texto sin sentido. El título debe leerse como algo que un humano escribiría.
7. Prioriza las palabras más buscadas: tipo de producto + características principales + uso.
8. Responde ÚNICAMENTE con el título, sin comillas, sin explicaciones, sin puntuación al final.

Título original: "${title}"
Descripción/características: "${description.substring(0, 400)}"

Un título corto y natural SIEMPRE es mejor que uno largo con relleno artificial.`;

  const result = await callAI(prompt);
  return result.replace(/^["']|["']$/g, '').replace(/^[\s\-–—,.:;|]+/, '').substring(0, 60).trim();
}

async function cleanImage(imageUrl: string): Promise<{ hadContactInfo: boolean; cleanedImageBase64: string; mimeType: string }> {
  const checkPrompt = `Does this image contain contact information such as phone numbers, email addresses, WhatsApp numbers, website URLs, social media usernames, QR codes, or text watermarks with seller contact details? Reply with only YES or NO.`;
  const answer = await callAI(checkPrompt, imageUrl);
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
  const raw = await callAI(prompt);
  try { const m = raw.match(/\{[\s\S]*\}/); return JSON.parse(m?.[0] || '{}'); } catch { return {}; }
}

Deno.serve(async (req) => {
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
