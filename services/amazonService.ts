import { Product } from '../types';
import { supabase } from './supabase';

export interface AmazonCredentials {
    sellerId: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    region: 'na' | 'eu' | 'fe';
}

class AmazonService {
    private credentialsKey = 'melidrop_amazon_credentials';
    private proxyUrl = 'https://gbdrxwfywxvyoxroqcut.supabase.co/functions/v1/amazon-proxy';
    private supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdiZHJ4d2Z5d3h2eW94cm9xY3V0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkxMzU1MTQsImV4cCI6MjA4NDcxMTUxNH0.8bGbL6bKSfGShizUiijZIJqRdyO_72hecEujK3vYvr4';

    // In a real production app, we would use a proxy to handle LWA (Login With Amazon) 
    // and SP-API signing to avoid exposing secrets or dealing with CORS.
    // For this MVP/Demo, we will focus on storing credentials.

    getCredentials(): AmazonCredentials | null {
        const stored = localStorage.getItem(this.credentialsKey);
        return stored ? JSON.parse(stored) : null;
    }

    async saveCredentials(creds: AmazonCredentials) {
        localStorage.setItem(this.credentialsKey, JSON.stringify(creds));
        
        // Sync to Supabase
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await supabase.from('user_connections').upsert({
                user_id: user.id,
                amazon_credentials: creds,
                updated_at: new Date().toISOString()
            });
        }
    }

    async clearCredentials() {
        localStorage.removeItem(this.credentialsKey);
        
        // Remove from Supabase
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await supabase.from('user_connections').update({
                amazon_credentials: null
            }).eq('user_id', user.id);
        }
    }

    public async syncFromSupabase(): Promise<boolean> {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return false;

        const { data, error } = await supabase
            .from('user_connections')
            .select('amazon_credentials')
            .eq('user_id', user.id)
            .single();

        if (data?.amazon_credentials) {
            localStorage.setItem(this.credentialsKey, JSON.stringify(data.amazon_credentials));
            return true;
        }
        return false;
    }

    isAuthenticated(): boolean {
        return !!this.getCredentials();
    }

    private async callProxy(action: string, params?: any) {
        const credentials = this.getCredentials();
        if (!credentials) {
            throw new Error('No Amazon credentials found');
        }

        const response = await fetch(this.proxyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.supabaseAnonKey}`
            },
            body: JSON.stringify({
                action,
                credentials,
                params
            })
        });

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || 'Amazon API request failed');
        }

        return data.data;
    }

    /**
     * Test the connection. 
     * In a real implementation, this would call specific valid endpoint like /sellers/v1/marketplaceParticipations
     */
    async testConnection(creds: AmazonCredentials): Promise<boolean> {
        try {
            // Temporarily save credentials for testing
            const originalCreds = this.getCredentials();
            this.saveCredentials(creds);

            // Try to refresh token
            await this.callProxy('refreshToken');

            // Restore original credentials if test was successful
            if (originalCreds) {
                this.saveCredentials(originalCreds);
            }

            return true;
        } catch (error) {
            console.error('Amazon connection test failed:', error);
            return false;
        }
    }

    async getProduct(asin: string, marketplace?: string): Promise<any> {
        if (!this.isAuthenticated()) {
            throw new Error('Not authenticated with Amazon');
        }

        try {
            const params: any = { asin };
            if (marketplace) params.marketplaceId = marketplace;

            const result = await this.callProxy('getProduct', params);

            // Catalog API v2022-04-01 GET /items/{asin} returns the item directly (not in a list)
            const catalogItem = result.catalog;
            const summaries = catalogItem?.summaries?.[0];
            const attributes = catalogItem?.attributes;

            // catalogItem.images is an array of marketplace-scoped groups.
            // Each group's .images array holds one entry per variant (MAIN, PT01, PT02, …).
            // Collect one URL per unique variant across all marketplace groups.
            const seenVariants = new Set<string>();
            const uniqueImages: string[] = [];
            if (Array.isArray(catalogItem?.images)) {
                for (const imgGroup of catalogItem.images) {
                    if (Array.isArray(imgGroup?.images)) {
                        for (const img of imgGroup.images) {
                            if (!img?.link || !img?.variant) continue;
                            // Use variant name as dedup key — same angle may appear in multiple marketplace groups
                            if (seenVariants.has(img.variant)) continue;
                            seenVariants.add(img.variant);
                            // Strip size/quality token to get the highest-quality base URL
                            const cleanUrl = img.link.replace(/\._[A-Za-z0-9_,]+\./, '.');
                            uniqueImages.push(cleanUrl);
                        }
                    }
                }
            }
            const primaryImage = uniqueImages[0] ?? null;

            const pricing = result.pricing?.payload;
            const bulletPoints: string[] = attributes?.bullet_point?.map((bp: any) => bp.value) || [];
            const description = bulletPoints.join('\n');

            const title = summaries?.itemName || attributes?.item_name?.[0]?.value || '';
            const brand = attributes?.brand?.[0]?.value || summaries?.brand || '';

            console.log(`amazonService.getProduct: asin=${asin}, title="${title}", images=${uniqueImages.length}`);
            console.log(`[Melidrop] ${asin}: Amazon returned ${uniqueImages.length} deduplicated images`);

            return {
                asin,
                title,
                description,
                bulletPoints,
                price: pricing?.Summary?.LowestPrices?.[0]?.ListingPrice?.Amount || 0,
                currency: pricing?.Summary?.LowestPrices?.[0]?.ListingPrice?.CurrencyCode || 'USD',
                imageUrl: primaryImage,
                images: uniqueImages.slice(0, 10),
                brand,
                category: summaries?.productType || catalogItem?.productTypes?.[0]?.productType || '',
                salesRank: catalogItem?.salesRanks?.[0]?.rank || null,
                attributes: attributes || {}
            };
        } catch (error) {
            console.error('Error fetching Amazon product:', error);
            throw error;
        }
    }

    async searchProducts(query: string): Promise<any[]> {
        if (!this.isAuthenticated()) {
            throw new Error('Not authenticated with Amazon');
        }

        try {
            const result = await this.callProxy('searchProducts', { query });
            const items = result.items || [];

            return items.map((item: any) => {
                const summary = item.summaries?.[0];
                const image = item.images?.[0]?.images?.[0];

                return {
                    asin: item.asin,
                    title: summary?.itemName || 'Unknown Product',
                    imageUrl: image?.link || null,
                    brand: summary?.brand || null
                };
            });
        } catch (error) {
            console.error('Error searching Amazon products:', error);
            throw error;
        }
    }

    async updatePrice(sku: string, price: number): Promise<boolean> {
        if (!this.isAuthenticated()) {
            throw new Error('Not authenticated with Amazon');
        }

        try {
            await this.callProxy('updatePrice', { sku, price });
            return true;
        } catch (error) {
            console.error('Error updating Amazon price:', error);
            throw error;
        }
    }

    async estimateDelivery(asin: string): Promise<{ mxDays: number; usaDays: number }> {
        if (!this.isAuthenticated()) {
            throw new Error('Not authenticated with Amazon');
        }
        const result = await this.callProxy('estimateDelivery', { asin });
        return result as { mxDays: number; usaDays: number };
    }
}

export const amazonService = new AmazonService();
