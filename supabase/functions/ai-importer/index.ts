import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY_IMPORTER') || 'AIzaSyDJI2XuXOnjl6zygz6KsmOrn5HdXlFAu4Q';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function callGemini(prompt: string, imageUrl?: string): Promise<string> {
  const parts: any[] = [{ text: prompt }];
  if (imageUrl) {
    try {
      const imgRes = await fetch(imageUrl);
      const imgBuffer = await imgRes.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(imgBuffer)));
      const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
      parts.unshift({ inline_data: { mime_type: mimeType, data: base64 } });
    } catch (e) { console.error("Img error:", e); }
  }
  const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 1024 } })
  });
  if (!response.ok) throw new Error("Gemini error");
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function mapAttributes(title: string, description: string, amazonAttrs: any, requiredAttrs: any[]): Promise<any> {
  const prompt = `Eres un experto en MercadoLibre. Tu tarea es extraer valores para los ATRIBUTOS requeridos.
DATOS AMAZON:
- Titulo: ${title}
- Descripcion: ${description.substring(0, 500)}
- Atributos Amazon: ${JSON.stringify(amazonAttrs)}

ATRIBUTOS ML A LLENAR:
${JSON.stringify(requiredAttrs.map(a => ({ id: a.id, name: a.name })))}

REGLAS:
1. Responde UNICAMENTE con un JSON array de objetos: [{"id": "...", "value_name": "..."}]
2. Para "BRAND" o "MARCA", usa el valor real (ej: ${amazonAttrs.brand || 'busca en el titulo'}).
3. Traduce al español. 
4. Si no encuentras el dato exacto, NO incluyas ese atributo. No pongas basura ni caracteres aleatorios.
5. NO expliques nada. Solo el JSON.`;

  const raw = await callGemini(prompt);
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    return JSON.parse(jsonMatch?.[0] || '[]');
  } catch { return []; }
}

async function optimizeTitle(title: string, description: string, brand: string): Promise<string> {
  const prompt = `Optimiza este titulo para MercadoLibre (max 60 chars, sin marca, traduce al español): "${title}". Marca a omitir: "${brand}". Solo responde el nuevo titulo.`;
  const result = await callGemini(prompt);
  return result.substring(0, 60).trim();
}

async function detectCategory(title: string, description: string, productType: string, siteId: string): Promise<any> {
    const prompt = `Categoria ML para: "${title}". Responde solo JSON: {"category_name": "...", "search_term": "...", "confidence": 0.9}`;
    const raw = await callGemini(prompt);
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
    return new Response(JSON.stringify({ success: true, data: result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) { return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }); }
});
