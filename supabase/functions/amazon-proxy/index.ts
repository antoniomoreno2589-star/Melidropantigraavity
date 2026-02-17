import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface AmazonCredentials {
    sellerId: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    region: string;
}

interface AmazonRequest {
    action: 'getProduct' | 'searchProducts' | 'updatePrice' | 'refreshToken';
    credentials: AmazonCredentials;
    params?: any;
}

// Amazon SP-API endpoints by region
const ENDPOINTS = {
    'na': 'https://sellingpartnerapi-na.amazon.com',
    'eu': 'https://sellingpartnerapi-eu.amazon.com',
    'fe': 'https://sellingpartnerapi-fe.amazon.com'
};

// LWA (Login with Amazon) token endpoint
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

async function getAccessToken(credentials: AmazonCredentials): Promise<string> {
    console.log('Getting Amazon access token...');

    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret
    });

    const response = await fetch(LWA_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });

    if (!response.ok) {
        const error = await response.text();
        console.error('LWA Token Error:', error);
        throw new Error(`Failed to get access token: ${error}`);
    }

    const data = await response.json();
    console.log('Access token obtained successfully');
    return data.access_token;
}

async function makeAmazonRequest(
    endpoint: string,
    path: string,
    accessToken: string,
    method: string = 'GET',
    body?: any
) {
    const url = `${endpoint}${path}`;
    console.log(`Making Amazon API request: ${method} ${url}`);

    const headers: Record<string, string> = {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json'
    };

    const options: RequestInit = {
        method,
        headers
    };

    if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
        const error = await response.text();
        console.error('Amazon API Error:', error);
        throw new Error(`Amazon API error: ${response.status} - ${error}`);
    }

    return await response.json();
}

async function getProduct(credentials: AmazonCredentials, asin: string) {
    const accessToken = await getAccessToken(credentials);
    const endpoint = ENDPOINTS[credentials.region as keyof typeof ENDPOINTS] || ENDPOINTS.na;

    // Get catalog item
    const catalogPath = `/catalog/2022-04-01/items/${asin}?marketplaceIds=ATVPDKIKX0DER&includedData=attributes,images,productTypes,salesRanks,summaries`;
    const catalogData = await makeAmazonRequest(endpoint, catalogPath, accessToken);

    // Get pricing
    const pricingPath = `/products/pricing/v0/items/${asin}/offers?MarketplaceId=ATVPDKIKX0DER&ItemCondition=New`;
    let pricingData = null;
    try {
        pricingData = await makeAmazonRequest(endpoint, pricingPath, accessToken);
    } catch (e) {
        console.warn('Could not fetch pricing data:', e);
    }

    return {
        catalog: catalogData,
        pricing: pricingData
    };
}

async function searchProducts(credentials: AmazonCredentials, query: string) {
    const accessToken = await getAccessToken(credentials);
    const endpoint = ENDPOINTS[credentials.region as keyof typeof ENDPOINTS] || ENDPOINTS.na;

    const searchPath = `/catalog/2022-04-01/items?marketplaceIds=ATVPDKIKX0DER&keywords=${encodeURIComponent(query)}&includedData=summaries,images`;
    return await makeAmazonRequest(endpoint, searchPath, accessToken);
}

async function updatePrice(credentials: AmazonCredentials, sku: string, price: number) {
    const accessToken = await getAccessToken(credentials);
    const endpoint = ENDPOINTS[credentials.region as keyof typeof ENDPOINTS] || ENDPOINTS.na;

    const pricePath = `/listings/2021-08-01/items/${credentials.sellerId}/${sku}`;
    const priceData = {
        productType: 'PRODUCT',
        patches: [
            {
                op: 'replace',
                path: '/attributes/purchasable_offer',
                value: [
                    {
                        marketplace_id: 'ATVPDKIKX0DER',
                        currency: 'USD',
                        our_price: [
                            {
                                schedule: [
                                    {
                                        value_with_tax: price
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ]
    };

    return await makeAmazonRequest(endpoint, pricePath, accessToken, 'PATCH', priceData);
}

serve(async (req) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const { action, credentials, params }: AmazonRequest = await req.json();

        if (!credentials || !credentials.sellerId || !credentials.clientId || !credentials.clientSecret || !credentials.refreshToken) {
            throw new Error('Missing required Amazon credentials');
        }

        let result;

        switch (action) {
            case 'getProduct':
                if (!params?.asin) throw new Error('ASIN is required');
                result = await getProduct(credentials, params.asin);
                break;

            case 'searchProducts':
                if (!params?.query) throw new Error('Search query is required');
                result = await searchProducts(credentials, params.query);
                break;

            case 'updatePrice':
                if (!params?.sku || !params?.price) throw new Error('SKU and price are required');
                result = await updatePrice(credentials, params.sku, params.price);
                break;

            case 'refreshToken':
                const accessToken = await getAccessToken(credentials);
                result = { accessToken };
                break;

            default:
                throw new Error(`Unknown action: ${action}`);
        }

        return new Response(
            JSON.stringify({ success: true, data: result }),
            {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 200
            }
        );

    } catch (error) {
        console.error('Edge Function Error:', error);
        return new Response(
            JSON.stringify({
                success: false,
                error: error.message || 'Internal server error'
            }),
            {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                status: 500
            }
        );
    }
});
