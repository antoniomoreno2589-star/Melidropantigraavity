import { Product } from '../types';

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

    saveCredentials(creds: AmazonCredentials) {
        localStorage.setItem(this.credentialsKey, JSON.stringify(creds));
    }

    clearCredentials() {
        localStorage.removeItem(this.credentialsKey);
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

    async getProduct(asin: string): Promise<any> {
        if (!this.isAuthenticated()) {
            throw new Error('Not authenticated with Amazon');
        }

        try {
            const result = await this.callProxy('getProduct', { asin });

            // Transform Amazon data to our Product format
            const catalogItem = result.catalog?.items?.[0];
            const summaries = catalogItem?.summaries?.[0];
            const attributes = catalogItem?.attributes;
            const images = catalogItem?.images?.[0]?.images?.[0];
            const pricing = result.pricing?.payload;

            return {
                asin: asin,
                title: summaries?.itemName || attributes?.item_name?.[0]?.value || 'Unknown Product',
                description: attributes?.bullet_point?.map((bp: any) => bp.value).join('\n') || '',
                price: pricing?.Summary?.LowestPrices?.[0]?.ListingPrice?.Amount || 0,
                currency: pricing?.Summary?.LowestPrices?.[0]?.ListingPrice?.CurrencyCode || 'USD',
                imageUrl: images?.link || null,
                brand: attributes?.brand?.[0]?.value || null,
                category: summaries?.productType || null,
                salesRank: catalogItem?.salesRanks?.[0]?.rank || null
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
}

export const amazonService = new AmazonService();
