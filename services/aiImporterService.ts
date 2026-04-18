const EDGE_URL = 'https://gbdrxwfywxvyoxroqcut.supabase.co/functions/v1/ai-importer';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdiZHJ4d2Z5d3h2eW94cm9xY3V0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkxMzU1MTQsImV4cCI6MjA4NDcxMTUxNH0.8bGbL6bKSfGShizUiijZIJqRdyO_72hecEujK3vYvr4';

async function callAI(action: string, params: any): Promise<any> {
    const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` },
        body: JSON.stringify({ action, params })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'AI Importer error');
    return data.data;
}

export interface CategorySuggestion {
    category_name: string;
    search_term: string;
    confidence: number;
    meli_category_id?: string;
}

export interface ProcessedProduct {
    asin: string;
    originalTitle: string;
    optimizedTitle: string;
    categorySuggestion: CategorySuggestion;
    images: ProcessedImage[];
    mappedAttributes: any[];
    errors: string[];
}

export interface ProcessedImage {
    url: string;
    cleanedUrl?: string;
    hasContactInfo: boolean;
    description: string;
    checked: boolean;
}

class AiImporterService {

    /**
     * Optimize a title for MercadoLibre: translate to Spanish, ≤60 chars, convert to metric.
     */
    async optimizeTitle(title: string, description: string, brand: string): Promise<string> {
        try {
            return await callAI('optimizeTitle', { title, description, brand });
        } catch (e) {
            console.error('aiImporterService optimizeTitle error:', e);
            // Fallback: truncate original
            return title.substring(0, 60);
        }
    }

    /**
     * Detect the best MercadoLibre category for a product using Gemini.
     */
    async detectCategory(title: string, description: string, productType: string, siteId: string = 'MLM'): Promise<CategorySuggestion> {
        try {
            return await callAI('detectCategory', { title, description, productType, siteId });
        } catch (e) {
            console.error('aiImporterService detectCategory error:', e);
            return { category_name: 'Otros', search_term: title.substring(0, 30), confidence: 0.2 };
        }
    }

    /**
     * Map Amazon product attributes to MercadoLibre required attributes.
     */
    async mapAttributes(title: string, description: string, amazonAttrs: any, requiredAttrs: any[]): Promise<any[]> {
        try {
            return await callAI('mapAttributes', { title, description, amazonAttrs, requiredAttrs });
        } catch (e) {
            console.error('aiImporterService mapAttributes error:', e);
            return [];
        }
    }

    /**
     * Detect and remove contact info/watermarks from an image using Claude Vision + Clipdrop.
     */
    async cleanImage(imageUrl: string): Promise<ProcessedImage> {
        try {
            const result = await callAI('cleanImage', { imageUrl });
            return {
                url: imageUrl,
                cleanedUrl: result.hadContactInfo ? `data:${result.mimeType};base64,${result.cleanedImageBase64}` : undefined,
                hasContactInfo: result.hadContactInfo,
                description: result.hadContactInfo ? 'Datos de contacto eliminados' : 'Sin datos de contacto',
                checked: true
            };
        } catch (e) {
            console.error('aiImporterService cleanImage error:', e);
            return { url: imageUrl, hasContactInfo: false, description: 'No analizada', checked: false };
        }
    }

    /**
     * Full AI processing pipeline for a single Amazon product.
     */
    async processProduct(
        product: any,
        siteId: string,
        requiredMeliAttrs: any[],
        checkImages: boolean = false
    ): Promise<ProcessedProduct> {
        const errors: string[] = [];

        // 1. Optimize title
        let optimizedTitle = product.title;
        try {
            optimizedTitle = await this.optimizeTitle(product.title, product.description || '', product.brand || '');
        } catch (e) {
            errors.push('No se pudo optimizar el título');
        }

        // 2. Detect category
        let categorySuggestion: CategorySuggestion = { category_name: '', search_term: '', confidence: 0 };
        try {
            categorySuggestion = await this.detectCategory(product.title, product.description || '', product.category || '', siteId);
        } catch (e) {
            errors.push('No se pudo detectar la categoría');
        }

        // 3. Process images (optional)
        let images: ProcessedImage[] = (product.images || [product.imageUrl].filter(Boolean)).map((url: string) => ({
            url, hasContactInfo: false, description: '', checked: false
        }));

        if (checkImages && images.length > 0) {
            images = await Promise.all(images.map(img => this.cleanImage(img.url)));
        }

        // 4. Map attributes (if we have required attrs and amazon attrs)
        let mappedAttributes: any[] = [];
        if (requiredMeliAttrs.length > 0) {
            try {
                mappedAttributes = await this.mapAttributes(
                    product.title,
                    product.description || '',
                    product.attributes || {},
                    requiredMeliAttrs
                );
            } catch (e) {
                errors.push('No se pudieron mapear atributos automáticamente');
            }
        }

        return {
            asin: product.asin,
            originalTitle: product.title,
            optimizedTitle,
            categorySuggestion,
            images,
            mappedAttributes,
            errors
        };
    }
}

export const aiImporterService = new AiImporterService();
