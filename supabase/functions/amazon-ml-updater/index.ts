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

function findAllSpanishDates(text: string): number[] {
    const monthMap: Record<string, number> = {
        'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4,
        'junio': 5, 'julio': 6, 'agosto': 7, 'septiembre': 8,
        'octubre': 9, 'noviembre': 10, 'diciembre': 11,
    };
    const regex = /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/gi;
    const results: number[] = [];
    const now = new Date();
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        const day = parseInt(m[1]);
        const month = monthMap[m[2].toLowerCase()];
        if (month === undefined) continue;
        const year = now.getFullYear();
        const deliveryDate = new Date(year, month, day);
        if (deliveryDate < now) deliveryDate.setFullYear(year + 1);
        const diffMs = deliveryDate.getTime() - now.getTime();
        const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
        if (days >= 0 && days <= 60) results.push(days);
    }
    return results;
}

async function fetchAmazonShippingDays(asin: string, postalCode?: string | null): Promise<number | null> {
    try {
        const oxylabsUser = Deno.env.get("OXYLABS_USERNAME");
        const oxylabsPass = Deno.env.get("OXYLABS_PASSWORD");

        if (!oxylabsUser || !oxylabsPass) {
            console.log(`[fetchAmazonShippingDays] asin=${asin} OXYLABS_USERNAME/PASSWORD not set`);
            return null;
        }

        const auth = `Basic ${btoa(`${oxylabsUser}:${oxylabsPass}`)}`;

        // Use amazon_product source with parse:true.
        // Oxylabs' Amazon-specific scraper renders JavaScript and extracts structured
        // data from the product page, including the actual delivery field from the buy-box.
        // This avoids the false positives produced by "universal" source, which picks up
        // Amazon's static Prime promotional banners ("Entrega GRATIS el domingo") that
        // appear on every page regardless of actual seller delivery time.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);

        const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": auth,
            },
            body: JSON.stringify({
                source: "amazon_product",
                domain: "com.mx",
                query: asin,
                parse: true,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            console.log(`[fetchAmazonShippingDays] asin=${asin} amazon_product HTTP ${res.status}`);
            return null;
        }

        const data = await res.json();
        const content = data?.results?.[0]?.content;

        if (content && typeof content === 'object') {
            // Log the delivery-relevant fields so we can see what Oxylabs extracts
            const relevant: Record<string, unknown> = {};
            for (const key of ['delivery', 'shipping', 'availability', 'price', 'buybox', 'delivery_info', 'seller']) {
                if (content[key] !== undefined) relevant[key] = content[key];
            }
            console.log(`[fetchAmazonShippingDays] asin=${asin} parsed fields: ${JSON.stringify(relevant).slice(0, 800)}`);

            // Build flat list of text fragments to search for delivery dates.
            // Oxylabs returns delivery as an array of {date: {by: "11 de junio"}, type: "Entrega GRATIS el"}
            // objects rather than a plain string — extract date.by from each entry.
            const texts: string[] = [];

            if (Array.isArray(content?.delivery)) {
                for (const entry of content.delivery) {
                    const dateBy = entry?.date?.by ?? '';
                    const type   = entry?.type   ?? '';
                    if (dateBy) texts.push(`${type} ${dateBy}`.trim());
                }
            } else if (typeof content?.delivery === 'string') {
                texts.push(content.delivery);
            }

            // buybox may also carry delivery_details with the same shape
            if (Array.isArray(content?.buybox)) {
                for (const box of content.buybox) {
                    if (Array.isArray(box?.delivery_details)) {
                        for (const entry of box.delivery_details) {
                            const dateBy = entry?.date?.by ?? '';
                            const type   = entry?.type   ?? '';
                            if (dateBy) texts.push(`${type} ${dateBy}`.trim());
                        }
                    }
                }
            }

            // String fallbacks for other Oxylabs response shapes
            for (const v of [
                content?.delivery?.primary,
                content?.delivery?.secondary,
                content?.delivery_info,
                content?.price?.delivery,
                content?.shipping,
            ]) {
                if (typeof v === 'string') texts.push(v);
            }

            for (const text of texts) {
                if (/(llega|entrega|recibe|env[ií]o)\s+hoy/i.test(text)) {
                    console.log(`[fetchAmazonShippingDays] asin=${asin} hoy → 0`);
                    return 0;
                }
                if (/(llega|entrega|recibe|env[ií]o)\s+ma[ñn]ana/i.test(text)) {
                    console.log(`[fetchAmazonShippingDays] asin=${asin} mañana → 1`);
                    return 1;
                }
                const dates = findAllSpanishDates(text);
                if (dates.length > 0) {
                    const max = Math.max(...dates);
                    console.log(`[fetchAmazonShippingDays] asin=${asin} delivery="${text}" → ${max} días`);
                    return max;
                }
                const rangeM = text.match(/(\d+)\s+a\s+(\d+)\s+d[ií]as/i);
                if (rangeM) {
                    const max = Math.max(parseInt(rangeM[1]), parseInt(rangeM[2]));
                    console.log(`[fetchAmazonShippingDays] asin=${asin} range "${text}" → ${max} días`);
                    return max;
                }
                const singleM = text.match(/en (\d+)\s+d[ií]as/i);
                if (singleM) {
                    const d = parseInt(singleM[1]);
                    console.log(`[fetchAmazonShippingDays] asin=${asin} single "${text}" → ${d} días`);
                    return d;
                }
            }

            // delivery:[] means no buy-box — the product is only sold by external sellers
            // accessible via "Ver opciones de compra". Scrape that offer-listing page with
            // JavaScript rendering to get the actual seller delivery dates.
            if (Array.isArray(content?.delivery) && content.delivery.length === 0) {
                console.log(`[fetchAmazonShippingDays] asin=${asin} delivery=[] (no buy-box), scraping offer-listing with JS`);
                const offerCtrl = new AbortController();
                const offerTimer = setTimeout(() => offerCtrl.abort(), 30000);
                try {
                    const offerRes = await fetch("https://realtime.oxylabs.io/v1/queries", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": auth },
                        body: JSON.stringify({
                            source: "universal",
                            url: `https://www.amazon.com.mx/gp/offer-listing/${asin}/?condition=new`,
                            render: "html",
                        }),
                        signal: offerCtrl.signal,
                    });
                    clearTimeout(offerTimer);
                    if (offerRes.ok) {
                        const offerData = await offerRes.json();
                        const html = offerData?.results?.[0]?.content;
                        if (typeof html === 'string' && html.length > 100) {
                            const dates = findAllSpanishDates(html);
                            if (dates.length > 0) {
                                // Use min: the first/cheapest seller's delivery date, which is
                                // what we'd use to fulfill the order.
                                const min = Math.min(...dates);
                                console.log(`[fetchAmazonShippingDays] asin=${asin} offer-listing JS dates=${JSON.stringify(dates)} → ${min} días`);
                                return min;
                            }
                            console.log(`[fetchAmazonShippingDays] asin=${asin} offer-listing JS: no dates found`);
                        }
                    } else {
                        console.log(`[fetchAmazonShippingDays] asin=${asin} offer-listing JS HTTP ${offerRes.status}`);
                    }
                } catch (e2) {
                    clearTimeout(offerTimer);
                    console.log(`[fetchAmazonShippingDays] asin=${asin} offer-listing JS error: ${e2}`);
                }
            }

            console.log(`[fetchAmazonShippingDays] asin=${asin} parsed content: no delivery date in known fields`);
            return null;

        } else if (typeof content === 'string' && content.length > 100) {
            // Structured parsing was off — got raw HTML.
            // Only match specific calendar dates ("11 de junio") — NOT weekday names.
            // Weekday-name patterns ("domingo", "lunes", etc.) are intentionally excluded:
            // Amazon's static Prime promotional banners use them on every page and always
            // produce false positives regardless of the actual seller delivery window.
            const snippets = [...content.matchAll(/(?:llega|entrega|recibe)[^<\n]{0,100}/gi)].slice(0, 5);
            console.log(`[fetchAmazonShippingDays] asin=${asin} HTML snippets: ${snippets.map(s => s[0].trim()).join(' || ')}`);

            const dates = findAllSpanishDates(content);
            if (dates.length > 0) {
                const max = Math.max(...dates);
                console.log(`[fetchAmazonShippingDays] asin=${asin} HTML dates=${JSON.stringify(dates)} → ${max} días`);
                return max;
            }
            console.log(`[fetchAmazonShippingDays] asin=${asin} HTML: no specific dates found`);
            return null;
        }

        console.log(`[fetchAmazonShippingDays] asin=${asin} empty/null content from Oxylabs`);
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

        // ShippingTime.maximumHours: 0 means FBA Prime (ships immediately from warehouse),
        // which doesn't tell us customer delivery time — treat as null and use configured default.
        // Only use positive values (non-FBA merchants who declare a ship window).
        const shippingOffer = amazonOffer ?? allOffers[0] ?? null;
        const maxHours = shippingOffer?.ShippingTime?.maximumHours;
        const shippingDays = (maxHours !== undefined && maxHours !== null && maxHours > 0)
            ? Math.ceil(maxHours / 24)
            : null;

        console.log(`[fetchAmazonOffers] asin=${asin} price=${price} sellerCount=${sellerCount} soldByAmazon=${soldByAmazon} amazonStock=${amazonStock} shippingDays=${shippingDays}(maxHours=${maxHours})`);
        return { price, sellerCount, soldByAmazon, amazonStock, shippingDays };
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
            const debugItems: any[] = [];

            console.log(`[amazon-ml-updater] Processing batch: ${products.length} products, syncParams=${JSON.stringify(syncParams)}`);

            for (const product of products) {
                const currency = (product as any).currency ?? 'USD';
                const meliId   = (product as any).meli_id;
                const sku      = (product as any).sku;
                const productId = (product as any).id;
                const updatePayload: Record<string, unknown> = {};
                const debug: any = { sku, meliId, currency };

                const offers       = asinOffers[sku];
                const sellerCount   = offers?.sellerCount ?? null;
                const soldByAmazon  = offers?.soldByAmazon ?? null;
                const amazonStock   = offers?.amazonStock ?? null;
                // True when Amazon responded but the product has no listing (404, removed, no offers)
                const isUnavailableOnAmazon = offers !== undefined
                    && offers.price === null
                    && offers.sellerCount === 0;

                // Shipping days: scrape Amazon.com.mx for actual delivery time, cache 7 days
                let cachedShippingDays = (product as any).shipping_days ?? null;
                const updatedAt = (product as any).shipping_days_updated_at;
                const isStale = !updatedAt || (Date.now() - new Date(updatedAt).getTime()) > 7 * 24 * 60 * 60 * 1000;

                if (cachedShippingDays === null || isStale) {
                    const scrapedDays = await fetchAmazonShippingDays(sku, settings.postal_code ?? null);
                    if (scrapedDays !== null) {
                        cachedShippingDays = scrapedDays;
                        await supabase.from("products").update({
                            shipping_days: scrapedDays,
                            shipping_days_updated_at: new Date().toISOString()
                        }).eq("id", productId);
                    } else {
                        // Scraping failed (bot block or no pattern) — use configured default
                        const fallback = currency === 'MXN'
                            ? (settings.amazon_delivery_mx ?? null)
                            : (settings.amazon_delivery_usa ?? null);
                        cachedShippingDays = fallback;
                        // Persist fallback so we don't re-scrape every run (TTL still applies)
                        if (fallback !== null) {
                            await supabase.from("products").update({
                                shipping_days: fallback,
                                shipping_days_updated_at: new Date().toISOString()
                            }).eq("id", productId);
                        }
                        console.log(`[amazon-ml-updater] ${sku} scraping failed, fallback: ${fallback}`);
                    }
                }

                if (amazonStock === 0 || isUnavailableOnAmazon) {
                    updatePayload.status = "paused";
                    console.log(`[amazon-ml-updater] meliId=${meliId} pausing — ${isUnavailableOnAmazon ? 'product unavailable on Amazon' : 'Amazon stock = 0'}`);
                }

                if (syncParams.price) {
                    const amazonPrice = offers?.price ?? null;
                    debug.amazonPrice = amazonPrice;
                    if (amazonPrice) {
                        const newMxn     = calculateMxnPrice(amazonPrice, currency, exchangeRate, usaRules, mxRules);
                        const currentMxn = (product as any).price_mxn ?? 0;
                        debug.newMxn     = newMxn;
                        debug.currentMxn = currentMxn;
                        if (newMxn !== currentMxn && (allowDecrease || newMxn > currentMxn)) {
                            updatePayload.price = newMxn;
                        } else {
                            debug.priceBlocked = newMxn < currentMxn ? "decrease_blocked" : "same_value";
                        }
                    } else {
                        debug.priceBlocked = "no_amazon_price";
                    }
                }

                if (syncParams.stock && amazonStock !== 0 && !isUnavailableOnAmazon) {
                    const stockToSync = amazonStock !== null ? Math.min(amazonStock, defaultStock) : defaultStock;
                    updatePayload.available_quantity = stockToSync;
                }
                debug.amazonStock   = amazonStock;
                debug.shippingDays  = cachedShippingDays;

                if (syncParams.shipping) {
                    if (cachedShippingDays !== null) {
                        const totalHandlingTime = cachedShippingDays + prepDays;
                        updatePayload.sale_terms = [
                            { id: "MANUFACTURING_TIME", value_name: `${totalHandlingTime} días` }
                        ];
                        console.log(`[amazon-ml-updater] meliId=${meliId} shipping=${cachedShippingDays} + prep=${prepDays} = ${totalHandlingTime}`);
                    }
                }
                debug.payloadKeys = Object.keys(updatePayload);

                if (Object.keys(updatePayload).length > 0) {
                    console.log(`[amazon-ml-updater] meliId=${meliId}, sku=${sku}, payload=${JSON.stringify(updatePayload)}`);
                    const result = await updateMeliItem(meliId, updatePayload, mlToken);
                    debug.mlResult = result.ok ? "ok" : `error: ${result.error}`;
                    console.log(`[amazon-ml-updater] meliId=${meliId} result=${result.ok ? 'SUCCESS' : `FAILED: ${result.error}`}`);
                    if (result.ok) {
                        const dbUpdate: any = { last_updated: new Date().toISOString() };
                        if (updatePayload.price)              dbUpdate.price_mxn           = updatePayload.price;
                        if (updatePayload.available_quantity) dbUpdate.stock_meli           = updatePayload.available_quantity;
                        if (updatePayload.status)             dbUpdate.status               = updatePayload.status;
                        if (sellerCount !== null)             dbUpdate.amazon_seller_count  = sellerCount;
                        if (soldByAmazon !== null)            dbUpdate.sold_by_amazon       = soldByAmazon;
                        dbUpdate.amazon_available = !isUnavailableOnAmazon;
                        await supabase.from("products").update(dbUpdate).eq("meli_id", meliId);
                        updated++;
                    } else {
                        errors++;
                        if (!firstError) firstError = result.error;
                    }
                } else {
                    debug.mlResult = "skipped_no_changes";
                    console.log(`[amazon-ml-updater] meliId=${meliId}, sku=${sku} - no changes needed`);
                }
                debugItems.push(debug);

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

            summary.push({ userId, updated, errors, firstError, offset: newOffset, complete: isComplete, debug: debugItems });
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
