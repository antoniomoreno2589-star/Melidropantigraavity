export class AIService {
    private apiKey: string;
    private baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

    constructor() {
        // @ts-ignore
        // Prioritize the hardcoded key for now to ensure it works
        this.apiKey = 'AIzaSyAkztkTlqDmg8ccksBSjysro5bvCbm-9vY';
        // this.apiKey = localStorage.getItem('melidrop_gemini_api_key') || process.env.GEMINI_API_KEY || 'AIzaSyAkztkTlqDmg8ccksBSjysro5bvCbm-9vY';
    }

    setApiKey(key: string) {
        this.apiKey = key;
        localStorage.setItem('melidrop_gemini_api_key', key);
    }

    async generateResponseSuggestion(productInfo: any, question: string): Promise<string> {
        if (!this.apiKey) {
            console.error("AIService: No GEMINI_API_KEY found");
            return "No se pudo generar una sugerencia (API KEY faltante).";
        }

        const prompt = `
            Eres un asistente de ventas experto en Mercado Libre. 
            Tu objetivo es ayudar al vendedor a responder preguntas de manera profesional, amable y vendedora.
            
            PRODUCTO:
            - Título: ${productInfo?.title}
            - Atributos: ${JSON.stringify(productInfo?.attributes?.map((a: any) => `${a.name}: ${a.value_name}`).slice(0, 10))}
            - Características: ${JSON.stringify(productInfo?.variations?.[0]?.attribute_combinations?.map((a: any) => `${a.name}: ${a.value_name}`))}
            - Precio: ${productInfo?.price} ${productInfo?.currency_id}
            - Stock disponible: ${productInfo?.available_quantity}
            
            PREGUNTA DEL CLIENTE:
            "${question}"
            
            INSTRUCCIONES:
            1. Responde de forma concisa (máximo 2-3 oraciones).
            2. Sé sumamente amable.
            3. Si la información solicitada no está en los datos del producto, indica amablemente que el vendedor la confirmará pronto.
            4. No uses saludos genéricos como "Hola", ve directo a la respuesta útil pero con tono cordial.
            
            RESPUESTA SUGERIDA:
        `;

        try {
            const response = await fetch(`${this.baseUrl}?key=${this.apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }]
                    }]
                })
            });

            if (!response.ok) {
                const err = await response.text();
                console.error("AIService: API error", err);
                try {
                    const errorObj = JSON.parse(err);
                    return `Error IA: ${errorObj.error?.message || response.statusText}`;
                } catch (e) {
                    return `Error IA: ${response.status} ${response.statusText}`;
                }
            }

            const data = await response.json();
            const suggestion = data.candidates?.[0]?.content?.parts?.[0]?.text;

            return suggestion?.trim() || "No se pudo generar una respuesta.";
        } catch (error) {
            console.error("AIService: Error generating suggestion", error);
            return "Error inesperado al generar sugerencia.";
        }
    }
}

export const aiService = new AIService();
