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
const PRICE_CONCURRENCY = 20; // Amazon pricing calls in parallel per sub-chunk

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

// Fetch prices for up to PRICE_CONCURRENCY ASINs in parallel
async function fetchPricesBatch(
    amazonCreds: any,
    asins: string[]
): Promise<Record<string, number>> {
    const endpoint = {
        na: "https://sellingpartnerapi-na.amazon.com",
        eu: "https://sellingpartnerapi-eu.amazon.com",
        fe: "https://sellingpartnerapi-fe.amazon.com",
    }[amazonCreds.region as string] ?? "https://sellingpartnerapi-na.amazon.com";

    const marketplaceId = "A1AM78C64UM0Y8"; // Amazon Mexico
    const accessToken   = await getAmazonToken(amazonCreds);
    const prices: Record<string, number> = {};

    // Process in parallel chunks of PRICE_CONCURRENCY
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
    // Refresh if within 5 min of expiry or already expired
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

// ── Pricing calculation ─────────────────────────────────────────────────────

function calculateMxnPrice(
    costUSD: number,
    exchangeRate: number,
    rules: Array<{ min: number; max: number | null; margin: number }>
): number {
    const defaultRules = [
        { min: 0, max: 20, margin: 200 },
        { min: 21, max: 50, margin: 100 },
        { min: 51, max: null, margin: 50 },
    ];
    const r = (rules?.length ? rules : defaultRules).find(
        rule => costUSD >= rule.min && (rule.max === null || costUSD <= rule.max)
    ) ?? defaultRules[defaultRules.length - 1];
    return Math.ceil(costUSD * exchangeRate * (1 + r.margin / 100));
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
            const priceRules    = settings.usa            ?? [];
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
                // Check when last cycle finished
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

                // Count total products to sync
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

            // 3. Fetch next batch of products
            const { data: products } = await supabase
                .from("products")
                .select("meli_id, sku, price_mxn, stock_meli")
                .eq("user_id", userId)
                .not("sku", "is", null)
                .neq("sku", "")
                .range(offset, offset + BATCH_SIZE - 1);

            if (!products?.length) {
                // Nothing left — mark complete
                await supabase
                    .from("sync_jobs")
                    .update({ status: "completed", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                    .eq("id", job.id);
                summary.push({ userId, completed: true });
                continue;
            }

            // 4. Fetch Amazon prices for this batch
            const asins       = products.map((p: any) => p.sku);
            const asinPrices  = await fetchPricesBatch(amazonCreds, asins);

            // 5. Get a valid ML token
            let mlToken: string;
            try {
                mlToken = await getValidMeliToken(meliCreds);
            } catch {
                mlToken = meliCreds.token;
            }

            let updated = 0, errors = 0;

            for (const product of products) {
                const updatePayload: Record<string, unknown> = {};

                if (syncParams.price) {
                    const amazonUSD = asinPrices[(product as any).sku];
                    if (amazonUSD) {
                        const newMxn     = calculateMxnPrice(amazonUSD, exchangeRate, priceRules);
                        const currentMxn = (product as any).price_mxn ?? 0;
                        // Only update if price changed AND direction is allowed
                        if (newMxn !== currentMxn && (allowDecrease || newMxn > currentMxn)) {
                            updatePayload.price = newMxn;
                        }
                    }
                }

                if (syncParams.stock) {
                    updatePayload.available_quantity = defaultStock;
                }

                if (Object.keys(updatePayload).length === 0) continue;

                const ok = await updateMeliItem((product as any).meli_id, updatePayload, mlToken);
                if (ok) {
                    const dbUpdate: any = { last_updated: new Date().toISOString() };
                    if (updatePayload.price)              dbUpdate.price_mxn   = updatePayload.price;
                    if (updatePayload.available_quantity) dbUpdate.stock_meli  = updatePayload.available_quantity;
                    await supabase.from("products").update(dbUpdate).eq("meli_id", (product as any).meli_id);
                    updated++;
                } else {
                    errors++;
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
                    status:       "success",
                    finished_at:  new Date().toISOString(),
                    items_synced: jobUpdate.updated_count,
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
