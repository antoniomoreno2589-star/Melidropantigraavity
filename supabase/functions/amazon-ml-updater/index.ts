// amazon-ml-updater — Edge Function
//
// Processes ONE batch of products per invocation (150 s limit).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MELI_API  = "https://api.mercadolibre.com";
const LWA_URL   = "https://api.amazon.com/auth/o2/token";
const BATCH_SIZE = 200;
const PRICE_CONCURRENCY = 20;

const MARKETPLACE_USA = "ATVPDKIKX0DER";
const MARKETPLACE_MXN = "A1AM78C64UM0Y8";
const AMAZON_SELLER_USA = "A1G99GVHAT2WD8";
const AMAZON_SELLER_MXN = "AVDBXBAVVSXLQ";

async function getAmazonToken(creds: any): Promise<string> {
    const params = new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: creds.refreshToken,
        client_id:     creds.clientId,
        client_secret: creds.clientSecret,
    });
    const res = await fetch(LWA_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    params.toString(),
    });
    if (!res.ok) throw new Error(`Amazon LWA error: ${await res.text()}`);
    const data = await res.json();
    return data.access_token;
}

interface AmazonOffers {
    price: number | null;
    sellerCount: number;
    soldByAmazon: boolean;
    amazonStock: number | null;
    shippingDays: number | null;
}

async function fetchAmazonShippingDays(asin: string): Promise<number | null> {
    try {
        const url = `https://www.amazon.com.mx/dp/${asin}`;
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept-Language": "es-MX,es;q=0.9",
            },
        });
        if (!res.ok) return null;

        const html = await res.text();

        // Buscar "Llega en X a Y días", "Envío en X a Y días"
        const patterns = [
            /Llega en (\d+)\s+a\s+(\d+)\s+días/i,
            /Envío en (\d+)\s+a\s+(\d+)\s+días/i,
            /(\d+)\s+a\s+(\d+)\s+días/i,
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) {
                const min = parseInt(match[1]);
                const max = parseInt(match[2]);
                const days = Math.max(min, max);
                console.log(`[fetchAmazonShippingDays] asin=${asin} found: ${days} days`);
                return days;
            }
        }

        console.log(`[fetchAmazonShippingDays] asin=${asin} no pattern found`);
        return null;
    } catch (e) {
        console.error(`[fetchAmazonShippingDays] asin=${asin}:`, e);
        return null;
    }
}

async function fetchAmazonOffers(
    endpoint: string,
    asin: string,
    accessToken: string,
    marketplaceId: string,
    amazonSellerId: string
): Promise<AmazonOffers> {
    try {
        const url = `${endpoint}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${marketplaceId}&ItemCondition=New`;
        const res = await fetch(url, {
            headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
        });
        if (!res.ok) {
            if (res.status === 404 || res.status === 400) {
                return { price: null, sellerCount: 0, soldByAmazon: false, amazonStock: 0, shippingDays: null };
            }
            return { price: null, sellerCount: 0, soldByAmazon: false, amazonStock: null, shippingDays: null };
        }
        const data = await res.json();
        const summary = data?.payload?.Summary;
        const lowestNew = summary?.LowestPrices?.find(
            (p: any) => p.condition === "new" && p.fulfillmentChannel === "Amazon"
        ) ?? summary?.LowestPrices?.[0];
        const allOffers = data?.payload?.Offers ?? [];
        const amazonOffer = allOffers.find((o: any) => o.SellerId === amazonSellerId);
        const soldByAmazon = !!amazonOffer;
        const amazonStock = amazonOffer?.QuantityOnHand ?? null;
        const sellerCount = (summary?.NumberOfOffers ?? [])
            .reduce((sum: number, o: any) => sum + (o.offerCount ?? 0), 0)
            || allOffers.length;

        // LowestPrices can be empty when Amazon is the sole seller — fall back to the offer's own price
        const price = lowestNew?.ListingPrice?.Amount
            ?? amazonOffer?.ListingPrice?.Amount
            ?? amazonOffer?.BuyingPrice?.ListingPrice?.Amount
            ?? null;

        console.log(`[fetchAmazonOffers] asin=${asin} price=${price} sellerCount=${sellerCount} soldByAmazon=${soldByAmazon} amazonStock=${amazonStock}`);
        return { price, sellerCount, soldByAmazon, amazonStock, shippingDays: null };
    } catch {
        return { price: null, sellerCount: 0, soldByAmazon: false, amazonStock: null, shippingDays: null };
    }
}

async function fetchOffersBatch(
    endpoint: string,
    accessToken: string,
    asins: string[],
    marketplaceId: string,
    amazonSellerId: string
): Promise<Record<string, AmazonOffers>> {
    const offers: Record<string, AmazonOffers> = {};
    for (let i = 0; i < asins.length; i += PRICE_CONCURRENCY) {
        const chunk   = asins.slice(i, i + PRICE_CONCURRENCY);
        const results = await Promise.allSettled(
            chunk.map(asin => fetchAmazonOffers(endpoint, asin, accessToken, marketplaceId, amazonSellerId))
        );
        results.forEach((r, idx) => {
            if (r.status === "fulfilled") {
                offers[chunk[idx]] = r.value;
            }
        });
    }
    return offers;
}

async function refreshMeliToken(creds: any): Promise<string> {
    const res = await fetch(`${MELI_API}/oauth/token`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type:    "refresh_token",
            client_id:     creds.appId,
            client_secret: creds.secret,
            refresh_token: creds.refreshToken,
        }),
    });
    if (!res.ok) throw new Error(`ML token refresh failed: ${await res.text()}`);
    const data = await res.json();
    return data.access_token;
}

async function getValidMeliToken(creds: any): Promise<string> {
    const expiresAt = creds.expiresAt ?? 0;
    if (Date.now() < expiresAt - 5 * 60 * 1000) return creds.token;
    return refreshMeliToken(creds);
}

async function updateMeliItem(
    meliId: string,
    payload: Record<string, unknown>,
    token: string
): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${MELI_API}/items/${meliId}`, {
        method:  "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => `HTTP ${res.status}`);
        console.error(`[amazon-ml-updater] ML update failed for ${meliId}: ${res.status} - ${body}`);
        return { ok: false, error: `ML ${res.status}: ${body.slice(0, 300)}` };
    }
    return { ok: true };
}

async function updateMeliDescription(
    meliId: string,
    plainText: string,
    token: string
): Promise<boolean> {
    const res = await fetch(`${MELI_API}/items/${meliId}/description`, {
        method:  "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ plain_text: plainText }),
    });
    return res.ok;
}

function calculateMxnPrice(
    cost: number,
    currency: string,
    exchangeRate: number,
    usaRules: Array<{ min: number; max: number | null; margin: number }>,
    mxRules:  Array<{ min: number; max: number | null; margin: number }>
): number {
    const isMXN = currency?.toUpperCase() === 'MXN';
    const defaultUsaRules = [
        { min: 0,   max: 20,   margin: 200 },
        { min: 21,  max: 50,   margin: 100 },
        { min: 51,  max: null, margin: 50  },
    ];
    const defaultMxRules = [
        { min: 0,   max: 300,  margin: 150 },
        { min: 301, max: 600,  margin: 130 },
        { min: 601, max: null, margin: 80  },
    ];
    const rules = isMXN
        ? (mxRules?.length  ? mxRules  : defaultMxRules)
        : (usaRules?.length ? usaRules : defaultUsaRules);
    const r = rules.find(rule => cost >= rule.min && (rule.max === null || cost <= rule.max))
        ?? rules[rules.length - 1];
    return isMXN
        ? Math.ceil(cost * (1 + r.margin / 100))
        : Math.ceil(cost * exchangeRate * (1 + r.margin / 100));
}

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
};

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    let forceRun = false;
    let targetUserId: string | null = null;
    try {
        const body = await req.json().catch(() => ({}));
        forceRun = body.force === true;
        targetUserId = body.userId ?? null;
    } catch {
        // Ignore parse errors
    }

    try {
        const { data: connections, error: connErr } = await supabase
            .from("user_connections")
            .select("user_id, meli_credentials, amazon_credentials, exchange_rate, margin_rules")
            .not("meli_credentials",  "is", null)
            .not("amazon_credentials","is", null);

        if (connErr) throw connErr;
        if (!connections?.length) {
            return new Response(JSON.stringify({ message: "No users to sync" }), { headers: corsHeaders });
        }

        const summary: any[] = [];

        for (const conn of connections) {
            const userId        = conn.user_id;

            // When a specific user triggers a manual sync, only process that user
            if (targetUserId && userId !== targetUserId) continue;
            const meliCreds     = conn.meli_credentials as any;
            const amazonCreds   = conn.amazon_credentials as any;
            const settings      = (conn.margin_rules ?? {}) as any;
            const syncParams       = settings.sync_params   ?? { price: true, stock: true };
            const allowDecrease   = settings.allow_price_decrease ?? false;
            const defaultStock    = settings.default_stock ?? 3;
            const exchangeRate    = conn.exchange_rate      ?? settings.exchange_rate ?? 18.5;
            const usaRules        = settings.usa            ?? [];
            const mxRules         = settings.mx             ?? [];
            const freqHours       = settings.sync_frequency_hours ?? 24;
            const prepDays        = settings.prep_days ?? settings.handling_time_mx ?? 3;

            if (!meliCreds?.token || !amazonCreds?.refreshToken) continue;

            // When force=true, abandon stale running jobs so we restart from offset 0
            if (forceRun) {
                await supabase
                    .from("sync_jobs")
                    .update({ status: "abandoned", finished_at: new Date().toISOString() })
                    .eq("user_id", userId)
                    .eq("status", "running");
            }

            const { data: activeJob } = await supabase
                .from("sync_jobs")
                .select("*")
                .eq("user_id", userId)
                .eq("status", "running")
                .order("started_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            let job = activeJob;

            if (!job) {
                const { data: lastJob } = await supabase
                    .from("sync_jobs")
                    .select("finished_at")
                    .eq("user_id", userId)
                    .eq("status", "completed")
                    .order("finished_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();

                const lastFinished  = lastJob?.finished_at ? new Date(lastJob.finished_at).getTime() : 0;
                const nextRunAt     = lastFinished + freqHours * 60 * 60 * 1000;
                if (Date.now() < nextRunAt && !forceRun) {
                    summary.push({ userId, skipped: true, reason: "Not due yet" });
                    continue;
                }

                const { count } = await supabase
                    .from("products")
                    .select("*", { count: "exact", head: true })
                    .eq("user_id", userId)
                    .eq("in_updater", true)
                    .not("meli_id", "is", null)
                    .not("sku", "is", null)
                    .neq("sku",  "");

                const { data: newJob } = await supabase
                    .from("sync_jobs")
                    .insert({ user_id: userId, total_products: count ?? 0, status: "running" })
                    .select()
                    .single();

                job = newJob;
            }

            if (!job) continue;

            const offset = job.next_offset as number;

            const { data: products } = await supabase
                .from("products")
                .select("id, meli_id, sku, price_mxn, stock_meli, currency, description_text, shipping_days, shipping_days_updated_at")
                .eq("user_id", userId)
                .eq("in_updater", true)
                .not("meli_id", "is", null)
                .not("sku", "is", null)
                .neq("sku", "")
                .range(offset, offset + BATCH_SIZE - 1);

            if (!products?.length) {
                await supabase
                    .from("sync_jobs")
                    .update({ status: "completed", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                    .eq("id", job.id);
                summary.push({ userId, completed: true });
                continue;
            }

            const endpoint = {
                na: "https://sellingpartnerapi-na.amazon.com",
                eu: "https://sellingpartnerapi-eu.amazon.com",
                fe: "https://sellingpartnerapi-fe.amazon.com",
            }[amazonCreds.region as string] ?? "https://sellingpartnerapi-na.amazon.com";

            const accessToken = await getAmazonToken(amazonCreds);

            const usdAsins = products.filter((p: any) => (p.currency ?? 'USD') !== 'MXN').map((p: any) => p.sku);
            const mxnAsins = products.filter((p: any) => (p.currency ?? 'USD') === 'MXN').map((p: any) => p.sku);

            const [usdOffers, mxnOffers] = await Promise.all([
                usdAsins.length ? fetchOffersBatch(endpoint, accessToken, usdAsins, MARKETPLACE_USA, AMAZON_SELLER_USA) : Promise.resolve({}),
                mxnAsins.length ? fetchOffersBatch(endpoint, accessToken, mxnAsins, MARKETPLACE_MXN, AMAZON_SELLER_MXN) : Promise.resolve({}),
            ]);
            const asinOffers: Record<string, AmazonOffers> = { ...usdOffers, ...mxnOffers };

            let mlToken: string;
            try {
                mlToken = await getValidMeliToken(meliCreds);
            } catch {
                mlToken = meliCreds.token;
            }

            let updated = 0, errors = 0, firstError: string | undefined;

            console.log(`[amazon-ml-updater] Processing batch: ${products.length} products, syncParams=${JSON.stringify(syncParams)}`);

            for (const product of products) {
                const currency = (product as any).currency ?? 'USD';
                const meliId   = (product as any).meli_id;
                const sku      = (product as any).sku;
                const productId = (product as any).id;
                const updatePayload: Record<string, unknown> = {};

                const offers       = asinOffers[sku];
                const sellerCount   = offers?.sellerCount ?? null;
                const soldByAmazon  = offers?.soldByAmazon ?? null;
                const amazonStock   = offers?.amazonStock ?? null;

                // Shipping days cache logic (7 days TTL)
                let cachedShippingDays = (product as any).shipping_days ?? null;
                const updatedAt = (product as any).shipping_days_updated_at;
                const isStale = !updatedAt || (Date.now() - new Date(updatedAt).getTime()) > 7 * 24 * 60 * 60 * 1000;

                if (cachedShippingDays === null || isStale) {
                    console.log(`[amazon-ml-updater] Fetching shipping days for ${sku} (cache stale=${isStale})`);
                    const scrapedDays = await fetchAmazonShippingDays(sku);
                    if (scrapedDays !== null) {
                        cachedShippingDays = scrapedDays;
                        await supabase.from("products").update({
                            shipping_days: scrapedDays,
                            shipping_days_updated_at: new Date().toISOString()
                        }).eq("id", productId);
                    }
                }

                if (amazonStock === 0) {
                    updatePayload.status = "paused";
                }

                if (syncParams.price) {
                    const amazonPrice = offers?.price ?? null;
                    if (amazonPrice) {
                        const newMxn     = calculateMxnPrice(amazonPrice, currency, exchangeRate, usaRules, mxRules);
                        const currentMxn = (product as any).price_mxn ?? 0;
                        if (newMxn !== currentMxn && (allowDecrease || newMxn > currentMxn)) {
                            updatePayload.price = newMxn;
                        }
                    }
                }

                if (syncParams.stock && amazonStock !== 0) {
                    const stockToSync = amazonStock !== null ? Math.min(amazonStock, defaultStock) : defaultStock;
                    updatePayload.available_quantity = stockToSync;
                }

                if (syncParams.shipping) {
                    if (cachedShippingDays !== null) {
                        const totalHandlingTime = cachedShippingDays + prepDays;
                        updatePayload.sale_terms = [
                            { id: "MANUFACTURING_TIME", value_name: `${totalHandlingTime} días` }
                        ];
                        console.log(`[amazon-ml-updater] meliId=${meliId} shipping=${cachedShippingDays} + prep=${prepDays} = ${totalHandlingTime}`);
                    }
                }

                if (Object.keys(updatePayload).length > 0) {
                    console.log(`[amazon-ml-updater] meliId=${meliId}, sku=${sku}, payload=${JSON.stringify(updatePayload)}`);
                    const result = await updateMeliItem(meliId, updatePayload, mlToken);
                    console.log(`[amazon-ml-updater] meliId=${meliId} result=${result.ok ? 'SUCCESS' : `FAILED: ${result.error}`}`);
                    if (result.ok) {
                        const dbUpdate: any = { last_updated: new Date().toISOString() };
                        if (updatePayload.price)              dbUpdate.price_mxn           = updatePayload.price;
                        if (updatePayload.available_quantity) dbUpdate.stock_meli           = updatePayload.available_quantity;
                        if (updatePayload.status)             dbUpdate.status               = updatePayload.status;
                        if (sellerCount !== null)             dbUpdate.amazon_seller_count  = sellerCount;
                        if (soldByAmazon !== null)            dbUpdate.sold_by_amazon       = soldByAmazon;
                        await supabase.from("products").update(dbUpdate).eq("meli_id", meliId);
                        updated++;
                    } else {
                        errors++;
                        if (!firstError) firstError = result.error;
                    }
                } else {
                    console.log(`[amazon-ml-updater] meliId=${meliId}, sku=${sku} - no changes needed`);
                }

                const metaUpdate: any = { last_updated: new Date().toISOString() };
                if (sellerCount !== null)   metaUpdate.amazon_seller_count = sellerCount;
                if (soldByAmazon !== null)  metaUpdate.sold_by_amazon      = soldByAmazon;
                if (Object.keys(metaUpdate).length > 1) {
                    await supabase.from("products").update(metaUpdate).eq("meli_id", meliId);
                }

                if (syncParams.description && (product as any).description_text) {
                    await updateMeliDescription(meliId, (product as any).description_text, mlToken);
                }
            }

            const newOffset      = offset + products.length;
            const isComplete     = newOffset >= (job.total_products as number);
            const jobUpdate: any = {
                next_offset:     newOffset,
                processed_count: (job.processed_count as number) + products.length,
                updated_count:   (job.updated_count   as number) + updated,
                error_count:     (job.error_count      as number) + errors,
                updated_at:      new Date().toISOString(),
            };
            if (isComplete) {
                jobUpdate.status      = "completed";
                jobUpdate.finished_at = new Date().toISOString();
            }
            await supabase.from("sync_jobs").update(jobUpdate).eq("id", job.id);

            if (isComplete) {
                await supabase.from("sync_logs").insert({
                    status:        "success",
                    finished_at:   new Date().toISOString(),
                    items_synced:  jobUpdate.updated_count,
                    error_message: errors > 0 ? `${errors} update errors` : null,
                });
            }

            summary.push({ userId, updated, errors, firstError, offset: newOffset, complete: isComplete });
        }

        return new Response(JSON.stringify({ success: true, summary }), { headers: corsHeaders });

    } catch (err: any) {
        console.error("amazon-ml-updater error:", err);
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500,
            headers: corsHeaders,
        });
    }
});
