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

const MONTHS: Record<string, number> = {
    'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
    'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11,
};

function dateToShippingDays(day: number, month: number): number {
    const now = new Date();
    const delivery = new Date(now.getFullYear(), month, day, 23, 59, 59);
    if (delivery < now) delivery.setFullYear(now.getFullYear() + 1);
    return Math.ceil((delivery.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

async function buildAmazonSession(postalCode: string): Promise<string> {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const baseHeaders = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
    };

    const cookies: Map<string, string> = new Map();
    const parseCookies = (header: string | null) => {
        if (!header) return;
        header.split(/,(?=[A-Za-z_-]+=)/).forEach(c => {
            const [nameVal] = c.split(';');
            const eq = nameVal.indexOf('=');
            if (eq > 0) cookies.set(nameVal.substring(0, eq).trim(), nameVal.substring(eq + 1).trim());
        });
    };

    try {
        const homeRes = await fetch("https://www.amazon.com.mx/", { headers: baseHeaders, redirect: "follow" });
        parseCookies(homeRes.headers.get("set-cookie"));

        const zipRes = await fetch(
            `https://www.amazon.com.mx/gp/delivery/ajax/address-change.html?addressID=&isCosmetic=0&postalCode=${postalCode}&stateOrRegionCode=VER&countryCode=MX`,
            {
                headers: {
                    ...baseHeaders,
                    "Cookie": Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; '),
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": "https://www.amazon.com.mx/",
                },
            }
        );
        parseCookies(zipRes.headers.get("set-cookie"));
    } catch { /* ignore */ }

    return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchAmazonShippingDays(asin: string, postalCode = "06600"): Promise<number | null> {
    try {
        const cookieStr = await buildAmazonSession(postalCode);
        const res = await fetch(`https://www.amazon.com.mx/dp/${asin}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "es-MX,es;q=0.9",
                "Referer": "https://www.amazon.com.mx/",
                "Cookie": cookieStr,
            },
        });
        console.log(`[scrape] asin=${asin} status=${res.status} cookies=${cookieStr.length}`);
        if (!res.ok) return null;

        const html = await res.text();
        console.log(`[scrape] asin=${asin} htmlLen=${html.length} snippet=${html.substring(0, 300).replace(/\s+/g, ' ')}`);

        // Pattern 1: date range "entre el martes 27 de mayo y el miércoles 11 de junio"
        const rangeDate = html.match(
            /entre\s+el\s+(?:\w+,?\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)[^<]{0,30}y\s+el\s+(?:\w+,?\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i
        );
        if (rangeDate) {
            const d1 = dateToShippingDays(parseInt(rangeDate[1]), MONTHS[rangeDate[2].toLowerCase()] ?? 0);
            const d2 = dateToShippingDays(parseInt(rangeDate[3]), MONTHS[rangeDate[4].toLowerCase()] ?? 0);
            const days = Math.max(d1, d2);
            console.log(`[scrape] asin=${asin} date-range → ${days} days`);
            return days;
        }

        // Pattern 2: single date "Lo recibirás el martes 20 de mayo" / "Recíbelo el ..."
        const singleDate = html.match(
            /(?:recibir[aá]s?|recibes|llegar[aá]|recibe|Rec[ií]belo)\s+(?:el\s+)?(?:\w+,?\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i
        );
        if (singleDate) {
            const days = dateToShippingDays(parseInt(singleDate[1]), MONTHS[singleDate[2].toLowerCase()] ?? 0);
            console.log(`[scrape] asin=${asin} single-date → ${days} days`);
            return days;
        }

        // Pattern 3: "X a Y días" range
        const dayRanges = [
            /Llega en (\d+)\s+a\s+(\d+)\s+d[ií]as/i,
            /Env[ií]o en (\d+)\s+a\s+(\d+)\s+d[ií]as/i,
            /(\d+)\s+a\s+(\d+)\s+d[ií]as/i,
        ];
        for (const p of dayRanges) {
            const m = html.match(p);
            if (m) {
                const days = Math.max(parseInt(m[1]), parseInt(m[2]));
                console.log(`[scrape] asin=${asin} days-range → ${days} days`);
                return days;
            }
        }

        // Debug: show context near delivery words
        const idx = html.search(/recibir[aá]|recibes|entrega|llegará|d[ií]as h[aá]bil/i);
        if (idx >= 0) {
            console.log(`[scrape] asin=${asin} context: ${html.substring(Math.max(0, idx - 50), idx + 300).replace(/\s+/g, ' ')}`);
        } else {
            console.log(`[scrape] asin=${asin} NO delivery keywords in HTML`);
        }
        return null;
    } catch (e) {
        console.error(`[scrape] asin=${asin}:`, e);
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
        const price = lowestNew?.ListingPrice?.Amount ?? null;
        const sellerCount = (summary?.NumberOfOffers ?? [])
            .reduce((sum: number, o: any) => sum + (o.offerCount ?? 0), 0);
        const allOffers = data?.payload?.Offers ?? [];
        const amazonOffer = allOffers.find((o: any) => o.SellerId === amazonSellerId);
        const soldByAmazon = !!amazonOffer;
        const amazonStock = amazonOffer?.QuantityOnHand ?? null;

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
): Promise<boolean> {
    const res = await fetch(`${MELI_API}/items/${meliId}`, {
        method:  "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
    });
    return res.ok;
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
    let debugScrape = false;
    let debugAsin = "";
    let debugPostalCode = "06600";
    try {
        const body = await req.json().catch(() => ({}));
        forceRun = body.force === true;
        debugScrape = body.debug_scrape === true;
        if (body.asin) debugAsin = body.asin;
        if (body.postal_code) debugPostalCode = body.postal_code;
    } catch { /* ignore */ }

    // Debug mode: scrape a single ASIN and return raw result without running full update
    if (debugScrape) {
        const asin = debugAsin || "B09JYC1VR4";
        const cookieStr = await buildAmazonSession(debugPostalCode);
        const res = await fetch(`https://www.amazon.com.mx/dp/${asin}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "es-MX,es;q=0.9",
                "Referer": "https://www.amazon.com.mx/",
                "Cookie": cookieStr,
            },
        });
        const html = await res.text();
        const idx = html.search(/recibir[aá]|recibes|entrega|llegará|d[ií]as h[aá]bil/i);
        const deliveryContext = idx >= 0 ? html.substring(Math.max(0, idx - 100), idx + 500) : "";
        const shippingDays = await fetchAmazonShippingDays(asin, debugPostalCode);
        return new Response(JSON.stringify({
            asin,
            postal_code: debugPostalCode,
            status: res.status,
            htmlLen: html.length,
            snippet: html.substring(0, 500).replace(/\s+/g, ' '),
            delivery_context: deliveryContext.replace(/\s+/g, ' '),
            parsed_shipping_days: shippingDays,
            cookies_set: cookieStr.length,
        }), { headers: corsHeaders });
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
            const postalCode      = settings.postal_code ?? "06600";

            if (!meliCreds?.token || !amazonCreds?.refreshToken) continue;

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

            let updated = 0, errors = 0;

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
                    const scrapedDays = await fetchAmazonShippingDays(sku, postalCode);
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
                    const ok = await updateMeliItem(meliId, updatePayload, mlToken);
                    console.log(`[amazon-ml-updater] meliId=${meliId} result=${ok ? 'SUCCESS' : 'FAILED'}`);
                    if (ok) {
                        const dbUpdate: any = { last_updated: new Date().toISOString() };
                        if (updatePayload.price)              dbUpdate.price_mxn           = updatePayload.price;
                        if (updatePayload.available_quantity) dbUpdate.stock_meli           = updatePayload.available_quantity;
                        if (updatePayload.status)             dbUpdate.status               = updatePayload.status;
                        if (sellerCount !== null)             dbUpdate.amazon_seller_count  = sellerCount;
                        if (soldByAmazon !== null)            dbUpdate.sold_by_amazon       = soldByAmazon;
                        if (amazonStock !== null)             dbUpdate.amazon_stock         = amazonStock;
                        await supabase.from("products").update(dbUpdate).eq("meli_id", meliId);
                        updated++;
                    } else {
                        errors++;
                    }
                } else {
                    console.log(`[amazon-ml-updater] meliId=${meliId}, sku=${sku} - no changes needed`);
                }

                const metaUpdate: any = { last_updated: new Date().toISOString() };
                if (sellerCount !== null)   metaUpdate.amazon_seller_count = sellerCount;
                if (soldByAmazon !== null)  metaUpdate.sold_by_amazon      = soldByAmazon;
                if (amazonStock !== null)   metaUpdate.amazon_stock        = amazonStock;
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

            summary.push({ userId, updated, errors, offset: newOffset, complete: isComplete });
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
