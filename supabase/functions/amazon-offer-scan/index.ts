import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Finds which ASINs have exactly one seller on Amazon México, and whether that
// seller is Amazon itself. The work queue is asin_offer_scan: a row with
// scanned_at IS NULL is pending. Each run scans as many as fit in its time
// budget, so a cron can call it repeatedly until the queue is empty.

const LWA_URL = "https://api.amazon.com/auth/o2/token";
const MARKETPLACE_MXN = "A1AM78C64UM0Y8";
// Amazon's own retail seller IDs: the two amazon-ml-updater treats as Amazon
// México and Amazon USA, Amazon.com's own merchant ID, and Amazon Europe —
// identified by the owner from its seller page; it is on 3,618 of the owner's
// ASINs, third only to the other two Amazon sellers.
const AMAZON_SELLER_IDS = new Set(["AVDBXBAVVSXLQ", "A1G99GVHAT2WD8", "ATVPDKIKX0DER", "A1F023WJX36N4W"]);
const BATCH = 20;
// getItemOffersBatch is limited to 0.1 requests per second (burst 1).
const BATCH_INTERVAL_MS = 10_500;
// Well inside the edge function wall-clock limit; the cron fires every 2 minutes.
const TIME_BUDGET_MS = 100_000;

const ENDPOINTS: Record<string, string> = {
    na: "https://sellingpartnerapi-na.amazon.com",
    eu: "https://sellingpartnerapi-eu.amazon.com",
    fe: "https://sellingpartnerapi-fe.amazon.com",
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function getAmazonToken(creds: any): Promise<string> {
    const res = await fetch(LWA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: creds.refreshToken,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
        }).toString(),
    });
    if (!res.ok) throw new Error(`Amazon LWA error ${res.status}: ${await res.text()}`);
    return (await res.json()).access_token;
}

function summarize(asin: string, resp: any) {
    const itemStatus: number = resp?.status?.statusCode ?? 0;
    const base = { asin, item_status: itemStatus, scanned_at: new Date().toISOString() };
    if (itemStatus !== 200) {
        return { ...base, offer_count: null, seller_ids: [] as string[], buybox_seller_id: null, sold_by_amazon: null, single_non_amazon_seller: false };
    }
    const payload = resp?.body?.payload ?? {};
    const offers: any[] = payload.Offers ?? [];
    const offerCount: number = payload.Summary?.TotalOfferCount ?? offers.length;
    const sellers = [...new Set(offers.map(o => o?.SellerId).filter(Boolean))] as string[];
    const soldByAmazon = sellers.some(s => AMAZON_SELLER_IDS.has(s));
    // Offers holds at most 20 entries. When it holds every offer, its distinct
    // SellerIds are the complete seller list (one seller may have two offers).
    const single = offerCount > 0 && offerCount <= offers.length && sellers.length === 1 && !soldByAmazon;
    return {
        ...base,
        offer_count: offerCount,
        seller_ids: sellers,
        buybox_seller_id: offers.find(o => o?.IsBuyBoxWinner)?.SellerId ?? null,
        sold_by_amazon: soldByAmazon,
        single_non_amazon_seller: single,
    };
}

async function runScan(supabase: any, userId: string) {
    const startedAt = Date.now();

    const { data: conn } = await supabase.from("user_connections").select("amazon_credentials").eq("user_id", userId).maybeSingle();
    const creds = conn?.amazon_credentials as any;
    if (!creds?.refreshToken) {
        console.error("[amazon-offer-scan] no Amazon credentials for this user");
        return { error: "no_credentials" };
    }

    const maxBatches = Math.floor(TIME_BUDGET_MS / BATCH_INTERVAL_MS);
    const { data: pending, error: pendingErr } = await supabase
        .from("asin_offer_scan")
        .select("asin")
        .eq("user_id", userId)
        .eq("marketplace_id", MARKETPLACE_MXN)
        .is("scanned_at", null)
        .order("asin")
        .limit(maxBatches * BATCH);
    if (pendingErr) {
        console.error("[amazon-offer-scan] could not read the queue:", pendingErr.message);
        return { error: pendingErr.message };
    }
    if (!pending?.length) {
        console.log("[amazon-offer-scan] queue empty, nothing left to scan");
        return { done: true };
    }

    // Until at least one ASIN has come back 200, a batch where every item
    // failed is treated as a request problem and left pending, not recorded.
    // Once the request shape is proven, an all-404/400 batch is just 20 ASINs
    // Amazon México doesn't sell.
    const { count: okSoFar } = await supabase
        .from("asin_offer_scan")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("item_status", 200);
    let requestShapeProven = (okSoFar ?? 0) > 0;

    const endpoint = ENDPOINTS[creds.region] ?? ENDPOINTS.na;
    const accessToken = await getAmazonToken(creds);
    const asins = pending.map((r: any) => r.asin as string);

    let scanned = 0;
    let singles = 0;
    let nextSlotAt = 0;
    for (let i = 0; i < asins.length; i += BATCH) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) break;
        const chunk = asins.slice(i, i + BATCH);
        const callBatch = async () => {
            const wait = nextSlotAt - Date.now();
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            nextSlotAt = Date.now() + BATCH_INTERVAL_MS;
            return fetch(`${endpoint}/batches/products/pricing/v0/itemOffers`, {
                method: "POST",
                headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
                body: JSON.stringify({
                    requests: chunk.map(asin => ({
                        uri: `/products/pricing/v0/items/${asin}/offers`,
                        method: "GET",
                        MarketplaceId: MARKETPLACE_MXN,
                        ItemCondition: "New",
                        CustomerType: "Consumer",
                    })),
                }),
            });
        };
        let res = await callBatch();
        if (res.status === 429) res = await callBatch();
        if (!res.ok) {
            console.error(`[amazon-offer-scan] batch HTTP ${res.status}: ${(await res.text()).slice(0, 400)} - stopping this run`);
            break;
        }

        const responses: any[] = (await res.json())?.responses ?? [];
        const rows = chunk.map((asin, idx) => {
            const resp = responses.find(r => (r?.request?.Asin ?? r?.body?.payload?.ASIN) === asin) ?? responses[idx];
            return { user_id: userId, marketplace_id: MARKETPLACE_MXN, ...summarize(asin, resp) };
        });
        if (rows.some(r => r.item_status === 200)) requestShapeProven = true;
        if (!requestShapeProven) {
            console.error(`[amazon-offer-scan] no item in batch came back 200 (statuses ${rows.map(r => r.item_status).join(",")}): ${JSON.stringify(responses[0] ?? null).slice(0, 400)} - stopping this run`);
            break;
        }

        const { error: upsertErr } = await supabase
            .from("asin_offer_scan")
            .upsert(rows, { onConflict: "user_id,asin,marketplace_id" });
        if (upsertErr) {
            console.error("[amazon-offer-scan] could not save results:", upsertErr.message);
            break;
        }
        scanned += rows.length;
        singles += rows.filter(r => r.single_non_amazon_seller).length;
    }

    const { count: remaining } = await supabase
        .from("asin_offer_scan")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("marketplace_id", MARKETPLACE_MXN)
        .is("scanned_at", null);
    console.log(`[amazon-offer-scan] scanned=${scanned} single_non_amazon=${singles} remaining=${remaining}`);
    return { scanned, singles, remaining };
}

// PostgREST returns at most 1000 rows per request.
async function selectAll(build: (from: number, to: number) => any): Promise<any[]> {
    const rows: any[] = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await build(from, from + 999);
        if (error) throw new Error(error.message);
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) return rows;
    }
}

// Excel runs a cell that starts with = + - @ as a formula, and titles are
// written by third-party sellers, so those get a leading apostrophe.
function csvField(value: unknown): string {
    let s = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The scan's answer as a spreadsheet: every ASIN whose only seller is not
// Amazon, with the owner's listing title and ML IDs, uploaded to a private
// bucket and handed back as a signed download link.
async function exportSingleSellerCsv(supabase: any, userId: string) {
    const scans = await selectAll((from, to) => supabase
        .from("asin_offer_scan")
        .select("asin,seller_ids,buybox_seller_id,offer_count")
        .eq("user_id", userId)
        .eq("marketplace_id", MARKETPLACE_MXN)
        .eq("single_non_amazon_seller", true)
        .order("asin")
        .range(from, to));
    const products = await selectAll((from, to) => supabase
        .from("products").select("asin,sku,title,meli_id,status,last_updated").eq("user_id", userId).order("id").range(from, to));
    const testProducts = await selectAll((from, to) => supabase
        .from("test_products").select("asin,title,meli_id,status,updated_at").eq("user_id", userId).order("id").range(from, to));

    // Same ASIN normalization the queue was built with: products fall back to
    // the SKU when the ASIN column is empty.
    const listings = new Map<string, { title: string | null; at: string; meliIds: Set<string>; statuses: Set<string> }>();
    const addListing = (rawAsin: string | null, title: string | null, meliId: string | null, status: string | null, at: string | null) => {
        const asin = (rawAsin ?? "").trim().toUpperCase();
        if (!asin) return;
        const l = listings.get(asin) ?? { title: null, at: "", meliIds: new Set<string>(), statuses: new Set<string>() };
        if (title && (!l.title || (at ?? "") > l.at)) { l.title = title; l.at = at ?? ""; }
        if (meliId) l.meliIds.add(meliId);
        if (status) l.statuses.add(status);
        listings.set(asin, l);
    };
    for (const p of products) addListing(p.asin ? p.asin : p.sku, p.title, p.meli_id, p.status, p.last_updated);
    for (const t of testProducts) addListing(t.asin, t.title, t.meli_id, t.status, t.updated_at);

    const perSeller = new Map<string, number>();
    for (const s of scans) perSeller.set(s.seller_ids[0], (perSeller.get(s.seller_ids[0]) ?? 0) + 1);
    scans.sort((a, b) => (perSeller.get(b.seller_ids[0])! - perSeller.get(a.seller_ids[0])!)
        || a.seller_ids[0].localeCompare(b.seller_ids[0]) || a.asin.localeCompare(b.asin));

    const header = ["ASIN", "Vendedor (Seller ID)", "ASINs de este vendedor en la lista", "Tiene Buy Box", "Ofertas nuevas",
        "Título", "Publicaciones ML", "Estado ML", "Link Amazon", "Link vendedor"];
    const lines = [header.map(csvField).join(",")];
    for (const s of scans) {
        const seller = s.seller_ids[0];
        const l = listings.get(s.asin);
        lines.push([
            s.asin, seller, perSeller.get(seller), s.buybox_seller_id === seller ? "Sí" : "No", s.offer_count,
            l?.title ?? "", [...(l?.meliIds ?? [])].join(" "), [...(l?.statuses ?? [])].join("/"),
            `https://www.amazon.com.mx/dp/${s.asin}`, `https://www.amazon.com.mx/sp?seller=${seller}`,
        ].map(csvField).join(","));
    }
    // The BOM makes Excel read the file as UTF-8 (accents in titles).
    const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";

    const fileName = `vendedor-unico-${new Date().toISOString().slice(0, 10)}.csv`;
    const path = `${userId}/${fileName}`;
    // Private: only the service role and signed links can read it. Creating
    // an existing bucket just returns an error, which is fine to ignore.
    await supabase.storage.createBucket("exports", { public: false });
    const { error: uploadErr } = await supabase.storage.from("exports")
        .upload(path, new Blob([csv], { type: "text/csv" }), { upsert: true, contentType: "text/csv; charset=utf-8" });
    if (uploadErr) throw new Error(`upload failed: ${uploadErr.message}`);
    const { data: signed, error: signErr } = await supabase.storage.from("exports")
        .createSignedUrl(path, 7 * 24 * 3600, { download: fileName });
    if (signErr) throw new Error(`signed URL failed: ${signErr.message}`);

    console.log(`[amazon-offer-scan] exported ${scans.length} ASINs from ${perSeller.size} sellers to exports/${path}`);
    return { rows: scans.length, sellers: perSeller.size, url: signed.signedUrl };
}

Deno.serve(async (req) => {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    // The anon key (public, shipped in the web app) passes verify_jwt, so the
    // real gate is a shared secret only the cron has. It lives in a table that
    // has RLS on and no policies: readable by the service role, nobody else.
    const { data: cfg } = await supabase
        .from("edge_function_config")
        .select("value")
        .eq("name", "amazon_offer_scan_secret")
        .maybeSingle();
    const secret = cfg?.value as string | undefined;
    if (!secret || req.headers.get("x-scan-secret") !== secret) return json({ error: "forbidden" }, 403);

    const { userId, action } = await req.json().catch(() => ({}));
    if (!userId) return json({ error: "userId required" }, 400);

    if (action === "export") {
        try {
            return json(await exportSingleSellerCsv(supabase, userId));
        } catch (e) {
            console.error("[amazon-offer-scan] export failed:", e);
            return json({ error: String(e) }, 500);
        }
    }

    const work = runScan(supabase, userId).catch(e => {
        console.error("[amazon-offer-scan] run failed:", e);
        return { error: String(e) };
    });
    // Respond right away and keep scanning in the background, so the caller's
    // HTTP timeout can't cut a run short.
    const edgeRuntime = (globalThis as any).EdgeRuntime;
    if (edgeRuntime?.waitUntil) {
        edgeRuntime.waitUntil(work);
        return json({ started: true }, 202);
    }
    return json(await work);
});
