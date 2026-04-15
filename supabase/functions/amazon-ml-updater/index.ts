// amazon-ml-updater — Edge Function
//
// Processes ONE batch of products per invocation (150 s limit).
// Enable pg_cron in Supabase Dashboard, then schedule via SQL Editor:
//
//   SELECT cron.schedule(
//     'amazon-ml-updater', '*/10 * * * *',
//     'SELECT net.http_post(
//       url, headers, body
//     ) FROM (VALUES (
//       ''https://<project>.supabase.co/functions/v1/amazon-ml-updater'',
//       jsonb_build_object(''Authorization'', ''Bearer <anon_key>''),
//       ''{}''::jsonb
//     )) t(url, headers, body)'
//   );
//
// Progress is tracked in sync_jobs so each invocation resumes where
// the previous one left off.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MELI_API  = "https://api.mercadolibre.com";
const LWA_URL   = "https://api.amazon.com/auth/o2/token";
const BATCH_SIZE = 200;
const PRICE_CONCURRENCY = 20;

const MARKETPLACE_USA = "ATVPDKIKX0DER"; // Amazon USA  (prices in USD)
const MARKETPLACE_MXN = "A1AM78C64UM0Y8"; // Amazon Mexico (prices in MXN)

// ── Amazon helpers ──────────────────────────────────────────────────────────

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

async function fetchAmazonPrice(
    endpoint: string,
    asin: string,
    accessToken: string,
    marketplaceId: string
): Promise<number | null> {
    try {
        const url = `${endpoint}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${marketplaceId}&ItemCondition=New`;
        const res = await fetch(url, {
            headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const lowestNew = data?.payload?.Summary?.LowestPrices?.find(
            (p: any) => p.condition === "new" && p.fulfillmentChannel === "Amazon"
        ) ?? data?.payload?.Summary?.LowestPrices?.[0];
        return lowestNew?.ListingPrice?.Amount ?? null;
    } catch {
        return null;
    }
}

// Fetch prices for a list of ASINs from the given marketplace, PRICE_CONCURRENCY at a time.
async function fetchPricesBatch(
    endpoint: string,
    accessToken: string,
    asins: string[],
    marketplaceId: string
): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (let i = 0; i < asins.length; i += PRICE_CONCURRENCY) {
        const chunk   = asins.slice(i, i + PRICE_CONCURRENCY);
        const results = await Promise.allSettled(
            chunk.map(asin => fetchAmazonPrice(endpoint, asin, accessToken, marketplaceId))
        );
        results.forEach((r, idx) => {
            if (r.status === "fulfilled" && r.value !== null) {
                prices[chunk[idx]] = r.value;
            }
        });
    }
    return prices;
}

// ── MercadoLibre helpers ────────────────────────────────────────────────────

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

// ── Pricing calculation ─────────────────────────────────────────────────────

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
    // MXN source: Amazon Mexico price is already MXN — apply margin directly.
    // USD source: Amazon USA price → convert to MXN, then apply margin.
    return isMXN
        ? Math.ceil(cost * (1 + r.margin / 100))
        : Math.ceil(cost * exchangeRate * (1 + r.margin / 100));
}

// ── Main handler ────────────────────────────────────────────────────────────

serve(async (_req) => {
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const corsHeaders = { "Content-Type": "application/json" };

    try {
        // 1. Get all users that have both ML and Amazon credentials
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
            const syncParams    = settings.sync_params   ?? { price: true, stock: true };
            const allowDecrease = settings.allow_price_decrease ?? false;
            const defaultStock  = settings.default_stock ?? 3;
            const exchangeRate  = conn.exchange_rate      ?? settings.exchange_rate ?? 18.5;
            const usaRules      = settings.usa            ?? [];
            const mxRules       = settings.mx             ?? [];
            const freqHours     = settings.sync_frequency_hours ?? 24;

            if (!meliCreds?.token || !amazonCreds?.refreshToken) continue;

            // 2. Check for an active job or decide if a new cycle should start
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
                if (Date.now() < nextRunAt) {
                    summary.push({ userId, skipped: true, reason: "Not due yet" });
                    continue;
                }

                const { count } = await supabase
                    .from("products")
                    .select("*", { count: "exact", head: true })
                    .eq("user_id", userId)
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

            // 3. Fetch next batch — includes currency and description_text
            const { data: products } = await supabase
                .from("products")
                .select("meli_id, sku, price_mxn, stock_meli, currency, description_text")
                .eq("user_id", userId)
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

            // 4. Fetch Amazon prices — USD ASINs → Amazon USA, MXN ASINs → Amazon Mexico
            const endpoint = {
                na: "https://sellingpartnerapi-na.amazon.com",
                eu: "https://sellingpartnerapi-eu.amazon.com",
                fe: "https://sellingpartnerapi-fe.amazon.com",
            }[amazonCreds.region as string] ?? "https://sellingpartnerapi-na.amazon.com";

            const accessToken = await getAmazonToken(amazonCreds);

            const usdAsins = products.filter((p: any) => (p.currency ?? 'USD') !== 'MXN').map((p: any) => p.sku);
            const mxnAsins = products.filter((p: any) => (p.currency ?? 'USD') === 'MXN').map((p: any) => p.sku);

            const [usdPrices, mxnPrices] = await Promise.all([
                usdAsins.length ? fetchPricesBatch(endpoint, accessToken, usdAsins, MARKETPLACE_USA) : Promise.resolve({}),
                mxnAsins.length ? fetchPricesBatch(endpoint, accessToken, mxnAsins, MARKETPLACE_MXN) : Promise.resolve({}),
            ]);
            const asinPrices = { ...usdPrices, ...mxnPrices };

            // 5. Get a valid ML token
            let mlToken: string;
            try {
                mlToken = await getValidMeliToken(meliCreds);
            } catch {
                mlToken = meliCreds.token;
            }

            let updated = 0, errors = 0;

            for (const product of products) {
                const currency = (product as any).currency ?? 'USD';
                const meliId   = (product as any).meli_id;
                const updatePayload: Record<string, unknown> = {};

                if (syncParams.price) {
                    const amazonPrice = asinPrices[(product as any).sku];
                    if (amazonPrice) {
                        const newMxn     = calculateMxnPrice(amazonPrice, currency, exchangeRate, usaRules, mxRules);
                        const currentMxn = (product as any).price_mxn ?? 0;
                        if (newMxn !== currentMxn && (allowDecrease || newMxn > currentMxn)) {
                            updatePayload.price = newMxn;
                        }
                    }
                }

                if (syncParams.stock) {
                    updatePayload.available_quantity = defaultStock;
                }

                if (Object.keys(updatePayload).length > 0) {
                    const ok = await updateMeliItem(meliId, updatePayload, mlToken);
                    if (ok) {
                        const dbUpdate: any = { last_updated: new Date().toISOString() };
                        if (updatePayload.price)              dbUpdate.price_mxn  = updatePayload.price;
                        if (updatePayload.available_quantity) dbUpdate.stock_meli = updatePayload.available_quantity;
                        await supabase.from("products").update(dbUpdate).eq("meli_id", meliId);
                        updated++;
                    } else {
                        errors++;
                    }
                }

                // Description lives on a separate ML endpoint — update independently
                if (syncParams.description && (product as any).description_text) {
                    await updateMeliDescription(meliId, (product as any).description_text, mlToken);
                }
            }

            // 6. Update job progress
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

            // 7. Log to sync_logs when complete
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
