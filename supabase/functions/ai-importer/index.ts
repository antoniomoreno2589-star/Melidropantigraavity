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
    } catch (e) {
      console.error("Image processing error for Gemini:", e);
    }
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
    throw new Error(`Gemini API error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function optimizeTitle(title: string, description: string, brand: string): Promise<string> {
  const prompt = `Eres un experto en SEO para MercadoLibre México. Optimiza el siguiente título de producto de Amazon para publicarlo en MercadoLibre.

Reglas ESTRICTAS:
1. Máximo 60 caracteres.
2. Si está en inglés, tradúcelo al español.
3. Convierte medidas americanas a métricas (ej: 12 inches → 30 cm, 1 lb → 454 g).
4. NO inventes atributos que no estén en el título o descripción originales.
5. NO INCLUYAS EL NOMBRE DE LA MARCA EN EL TÍTULO. La marca ya se especifica en los atributos técnicos.
6. Estructura recomendada: [Producto] + [Característica Principal] + [Color/Modelo/Medida].
7. No uses símbolos raros, solo letras, números, espacios y guiones.

Título original: "${title}"
Descripción: "${description?.substring(0, 200) || ''}"
Marca a omitir: "${brand || ''}"

Responde ÚNICAMENTE con el título optimizado, sin comillas ni explicaciones.`;

  const result = await callGemini(prompt);
  return result.substring(0, 60).trim();
}

async function detectCategory(title: string, description: string, productType: string, siteId: string): Promise<any> {
  const prompt = `Eres un experto en MercadoLibre ${siteId === 'MLM' ? 'México' : 'USA'}.

Dado el producto de Amazon, determina la categoría más apropiada de MercadoLibre.

Producto: "${title}"
Tipo Amazon: "${productType || ''}"
Descripción: "${description?.substring(0, 300) || ''}"

Responde ÚNICAMENTE con un JSON válido:
{
  "category_name": "nombre de la categoría",
  "search_term": "término de búsqueda para encontrarla",
  "confidence": 0.9
}`;

  const raw = await callGemini(prompt);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch?.[0] || '{}');
  } catch {
    return { category_name: 'Otros', search_term: title.substring(0, 30), confidence: 0.3 };
  }
}

async function mapAttributes(title: string, description: string, amazonAttrs: any, requiredAttrs: any[]): Promise<any> {
  const attrsJson = JSON.stringify(requiredAttrs.slice(0, 30));
  const amazonJson = JSON.stringify(amazonAttrs || {});

  const prompt = `Eres un experto en atributos de MercadoLibre. Tu tarea es llenar los Atributos Requeridos por MercadoLibre usando la información del producto de Amazon.

Título Amazon: "${title}"
Descripción: "${description?.substring(0, 500) || ''}"

DATOS DISPONIBLES EN AMAZON (JSON):
${amazonJson}

ATRIBUTOS REQUERIDOS EN MERCADOLIBRE (Lista de IDs y Nombres):
${attrsJson}

INSTRUCCIONES:
1. Analiza cuidadosamente la descripción y los datos de Amazon para encontrar los valores.
2. Si el atributo es "MARCA", pon la marca real del producto.
3. Si el atributo es "MODELO", busca el modelo específico.
4. Si no encuentras información para un atributo requerido, usa "Genérico" o "N/A" solo si es texto libre, o déjalo fuera si no estás seguro.
5. Traduce colores y materiales al español.
6. Convierte medidas a sistema métrico.

Responde ÚNICAMENTE con un JSON array de objetos con "id" y "value_name":
[{"id": "BRAND", "value_name": "Nike"}, {"id": "MODEL", "value_name": "Air Max"}]`;

  const raw = await callGemini(prompt);
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    return JSON.parse(jsonMatch?.[0] || '[]');
  } catch {
    return [];
  }
}

async function checkImageForContactInfo(imageUrl: string): Promise<{ hasContactInfo: boolean; description: string }> {
  const prompt = `Analiza esta imagen y detecta si tiene datos de contacto (teléfonos, emails, webs) o marcas de agua de otras tiendas.
Responde JSON: {"hasContactInfo": true/false, "description": "explicación"}`;

  const raw = await callGemini(prompt, imageUrl);
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch?.[0] || '{"hasContactInfo": false, "description": "Imagen limpia"}');
  } catch {
    return { hasContactInfo: false, description: 'No se pudo analizar' };
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { action, params } = await req.json();
    let result: any;
    switch (action) {
      case 'optimizeTitle': result = await optimizeTitle(params.title, params.description, params.brand); break;
      case 'detectCategory': result = await detectCategory(params.title, params.description, params.productType, params.siteId); break;
      case 'mapAttributes': result = await mapAttributes(params.title, params.description, params.amazonAttrs, params.requiredAttrs); break;
      case 'checkImage': result = await checkImageForContactInfo(params.imageUrl); break;
      default: throw new Error(`Unknown action: ${action}`);
    }
    return new Response(JSON.stringify({ success: true, data: result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 });
  }
});
