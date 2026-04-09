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
    } catch (e) { console.error("Image processing error:", e); }
  }
  const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2, maxOutputTokens: 1024 } })
  });
  if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function optimizeTitle(title: string, description: string, brand: string): Promise<string> {
  const prompt = `Eres un experto en SEO para MercadoLibre. Optimiza este título de Amazon.
REGLAS:
1. Máximo 60 caracteres. TRATA DE ACERCARTE A LOS 60 CARACTERES usando palabras clave relevantes (SEO).
2. TRADUCE TODO AL ESPAÑOL.
3. NO INCLUYAS EL NOMBRE DE LA MARCA ("${brand}"). 
4. Estructura: [Producto] + [Característica 1] + [Característica 2] + [Modelo/Medida].
5. Sé descriptivo: si es un juguete, incluye "Niños" o "Infantil".

Título: "${title}"
Descripción: "${description.substring(0, 300)}"
Responde solo con el texto del título.`;

  const result = await callGemini(prompt);
  return result.substring(0, 60).trim();
}

async function mapAttributes(title: string, description: string, amazonAttrs: any, requiredAttrs: any[]): Promise<any> {
  const prompt = `Extrae valores para estos atributos de MercadoLibre usando los datos de Amazon.
Producto: "${title}"
Descripción: "${description.substring(0, 500)}"
Amazon Attrs: ${JSON.stringify(amazonAttrs)}

Atributos ML a llenar (IDs y Nombres):
${JSON.stringify(requiredAttrs)}

INSTRUCCIONES:
- Responde UNICAMENTE un JSON array: [{"id": "ID", "value_name": "Valor"}]
- Para MARCA usa "${amazonAttrs.brand || 'Genérica'}".
- Sé preciso. Traduce colores.
- Si no sabes un valor, no lo incluyas.`;

  const raw = await callGemini(prompt);
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    return JSON.parse(jsonMatch?.[0] || '[]');
  } catch { return []; }
}

// ... remaining functions same as before
async function detectCategory(title: string, description: string, productType: string, siteId: string): Promise<any> {
    const prompt = `Determina la categoría de MercadoLibre para: "${title}". Responde JSON: {"category_name": "...", "search_term": "...", "confidence": 0.9}`;
    const raw = await callGemini(prompt);
    try { const m = raw.match(/\{[\s\S]*\}/); return JSON.parse(m?.[0] || '{}'); } catch { return {}; }
}

async function checkImage(imageUrl: string): Promise<any> {
    const prompt = `¿Esta imagen tiene datos de contacto? Responde JSON: {"hasContactInfo": true/false}`;
    const raw = await callGemini(prompt, imageUrl);
    try { const m = raw.match(/\{[\s\S]*\}/); return JSON.parse(m?.[0] || '{}'); } catch { return {hasContactInfo:false}; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { action, params } = await req.json();
    let result: any;
    if (action === 'optimizeTitle') result = await optimizeTitle(params.title, params.description, params.brand);
    else if (action === 'detectCategory') result = await detectCategory(params.title, params.description, params.productType, params.siteId);
    else if (action === 'mapAttributes') result = await mapAttributes(params.title, params.description, params.amazonAttrs, params.requiredAttrs);
    else if (action === 'checkImage') result = await checkImage(params.imageUrl);
    return new Response(JSON.stringify({ success: true, data: result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) { return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }); }
});
