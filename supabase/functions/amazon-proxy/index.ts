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
    action: 'getProduct' | 'searchProducts' | 'updatePrice' | 'refreshToken' | 'estimateDelivery';
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

// LWA access tokens are valid ~3600s, but every call to getProduct/searchProducts/
// updatePrice/estimateDelivery was requesting a brand-new one — a batch import of
// N ASINs fired up to N (or more, with client-side retries) fresh LWA token
// exchanges within seconds of each other. LWA's own rate limit is considerably
// stricter than the Catalog/Pricing APIs it's gating, so this alone was enough to
// start failing well before those APIs' own limits came into play. Cached
// per-credential-set (this proxy is multi-tenant) and kept for a warm isolate's
// lifetime; a cold start just refetches once.
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getAccessToken(credentials: AmazonCredentials): Promise<string> {
    const cacheKey = `${credentials.clientId}:${credentials.refreshToken}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.accessToken;
    }

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
    // Cache with a 5-minute safety margin so we refresh a little before Amazon
    // would actually reject it, not exactly at the edge.
    const expiresInMs = (data.expires_in ?? 3600) * 1000;
    tokenCache.set(cacheKey, { accessToken: data.access_token, expiresAt: Date.now() + expiresInMs - 5 * 60 * 1000 });
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

// The Pricing API has its own rate limit separate from Catalog's, and can also
// momentarily report no current offer even outside any rate limit. A single failed
// attempt used to be swallowed silently into price: 0 (see getProduct below) with
// nothing retried — the client had no way to detect it since getProduct still
// "succeeded", so this exact failure only ever got fixed by a user noticing the
// wrong price and manually clicking "Reintentar precio" (a fresh attempt). This
// gives every call that same fresh-attempt chance automatically.
async function makeAmazonRequestWithRetry(
    endpoint: string,
    path: string,
    accessToken: string,
    maxAttempts: number = 3
) {
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await makeAmazonRequest(endpoint, path, accessToken);
        } catch (e) {
            lastErr = e;
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, 600 * attempt));
            }
        }
    }
    throw lastErr;
}

async function getProduct(credentials: AmazonCredentials, asin: string, params?: any) {
    const accessToken = await getAccessToken(credentials);
    const endpoint = ENDPOINTS[credentials.region as keyof typeof ENDPOINTS] || ENDPOINTS.na;

    // Get catalog item
    const marketplaceId = params?.marketplaceId || 'A1AM78C64UM0Y8'; // Default to Mexico
    const catalogPath = `/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=attributes,images,productTypes,salesRanks,summaries`;
    const catalogData = await makeAmazonRequest(endpoint, catalogPath, accessToken);

    // Get pricing — retried on its own since it fails independently of catalog
    // (its own rate limit / momentary no-offer gaps), not just once-and-give-up.
    const pricingPath = `/products/pricing/v0/items/${asin}/offers?MarketplaceId=${marketplaceId}&ItemCondition=New`;
    let pricingData = null;
    try {
        pricingData = await makeAmazonRequestWithRetry(endpoint, pricingPath, accessToken, 3);
    } catch (e) {
        console.warn('Could not fetch pricing data after retries:', e);
    }

    return {
        catalog: catalogData,
        pricing: pricingData
    };
}

async function searchProducts(credentials: AmazonCredentials, query: string, params?: any) {
    const accessToken = await getAccessToken(credentials);
    const endpoint = ENDPOINTS[credentials.region as keyof typeof ENDPOINTS] || ENDPOINTS.na;

    const marketplaceId = params?.marketplaceId || 'A1AM78C64UM0Y8';
    const searchPath = `/catalog/2022-04-01/items?marketplaceIds=${marketplaceId}&keywords=${encodeURIComponent(query)}&includedData=summaries,images`;
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

const MARKETPLACE_MXN = "A1AM78C64UM0Y8";

// Owner-defined 4-level tiebreak for picking "the" winning offer out of an
// ASIN's Offers array. Confirmed live this is needed, not optional: for a
// real ASIN, TWO offers (a China merchant and an "Amazon Estados Unidos"
// cross-border one) both had IsBuyBoxWinner:true simultaneously — Amazon's
// own Summary.BuyBoxPrices pointed at the cheaper China one, but the actual
// amazon.com.mx retail page featured the Amazon one as the default "Agregar
// al carrito" offer instead. IsBuyBoxWinner alone can't be trusted to be
// unique, so ship-from-country, then Prime, then FBA break the tie.
const SHIP_FROM_PRIORITY = ['MX', 'US'];

function isPrimeOffer(o: any): boolean {
    return !!(o?.PrimeInformation?.IsNationalPrime ?? o?.PrimeInformation?.IsPrime);
}

function pickWinningOffer(offers: any[]): any | null {
    if (offers.length === 0) return null;

    // 1) Buy box winner(s) — narrow to those if any exist, otherwise consider
    // every offer (a defensive fallback for the case none are flagged at all;
    // not something confirmed to happen live, just cheap to guard against).
    let candidates = offers.filter((o: any) => o.IsBuyBoxWinner);
    if (candidates.length === 0) candidates = offers;
    if (candidates.length === 1) return candidates[0];

    // 2) Ship-from country: MX first, then US, then leave the full remaining
    // set alone for "any other country" (no preference among those).
    for (const country of SHIP_FROM_PRIORITY) {
        const inCountry = candidates.filter((o: any) => o.ShipsFrom?.Country === country);
        if (inCountry.length > 0) {
            candidates = inCountry;
            break;
        }
    }
    if (candidates.length === 1) return candidates[0];

    // 3) Prime eligibility.
    const primeCandidates = candidates.filter(isPrimeOffer);
    if (primeCandidates.length > 0) candidates = primeCandidates;
    if (candidates.length === 1) return candidates[0];

    // 4) Fulfilled by Amazon (FBA).
    const fbaCandidates = candidates.filter((o: any) => o.IsFulfilledByAmazon);
    if (fbaCandidates.length > 0) candidates = fbaCandidates;

    // Still tied after all 4 criteria — deterministic, arbitrary pick.
    return candidates[0];
}

// Fixed business rule (owner-defined, confirmed against real Offers data —
// Amazon's own ShippingTime.maximumHours is unreliable: real offers can
// report 0 hours, a data gap, not "ships instantly"). ShipsFrom.Country is
// the trustworthy field instead, so base delivery days off wherever the
// winning offer (picked above) ships from.
const EUROPE_COUNTRIES = new Set([
    'DE', 'GB', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'AT', 'IE', 'PT',
    'DK', 'FI', 'NO', 'CH', 'CZ', 'GR', 'HU', 'RO'
]);

function daysForShipsFromCountry(country: string | undefined): number | null {
    if (!country) return null;
    if (country === 'MX') return 2;
    if (country === 'US') return 8;
    if (country === 'CN') return 18;
    if (EUROPE_COUNTRIES.has(country)) return 23;
    return null; // unrecognized origin — caller falls back to its own default
}

async function estimateDelivery(credentials: AmazonCredentials, asin: string) {
    const accessToken = await getAccessToken(credentials);
    const endpoint = ENDPOINTS[credentials.region as keyof typeof ENDPOINTS] || ENDPOINTS.na;

    // Same marketplace getProduct already queries by default.
    let shipsFromCountry: string | null = null;
    try {
        const path = `/products/pricing/v0/items/${asin}/offers?MarketplaceId=${MARKETPLACE_MXN}&ItemCondition=New`;
        const data = await makeAmazonRequest(endpoint, path, accessToken);
        const winner = pickWinningOffer(data?.payload?.Offers ?? []);
        shipsFromCountry = winner?.ShipsFrom?.Country ?? null;
    } catch (e) {
        console.warn('Could not fetch delivery estimate:', e);
    }

    const deliveryDays = daysForShipsFromCountry(shipsFromCountry ?? undefined);
    return { deliveryDays, shipsFromCountry };
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
                result = await getProduct(credentials, params.asin, params);
                break;

            case 'searchProducts':
                if (!params?.query) throw new Error('Search query is required');
                result = await searchProducts(credentials, params.query, params);
                break;

            case 'updatePrice':
                if (!params?.sku || !params?.price) throw new Error('SKU and price are required');
                result = await updatePrice(credentials, params.sku, params.price);
                break;

            case 'refreshToken':
                const accessToken = await getAccessToken(credentials);
                result = { accessToken };
                break;

            case 'estimateDelivery':
                if (!params?.asin) throw new Error('ASIN is required for delivery estimation');
                result = await estimateDelivery(credentials, params.asin);
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
