import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Fills in the Catálogo listings transfer_listings handed to another account:
// test_products rows with a source_meli_id and no publish_payload. The
// Catálogo never stored category, attributes or the full picture set — those
// only lived on the Mercado Libre listing — so this reads the original listing
// with its owner's token and builds the payload buildItemPayload would have
// (same shape, so the Sandbox's "Publicar Real" takes it as is).
//
// The owner's token is only read, never renewed: a renewal here would rotate
// the refresh token out from under the owner's own Melidrop session. If it is
// about to expire, the run stops and says so.

const ML = "https://api.mercadolibre.com";
const BATCH = 20;            // ML multiget limit
const CONCURRENCY = 4;
// Under the cron's 1-minute interval, so runs don't overlap.
const TIME_BUDGET_MS = 50_000;
const PAGE = 1000;           // PostgREST's max rows per request
const ITEM_FIELDS = "id,title,category_id,price,currency_id,listing_type_id,pictures,attributes,sale_terms";
const KEPT_SALE_TERMS = new Set(["WARRANTY_TYPE", "WARRANTY_TIME", "MANUFACTURING_TIME"]);

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Settings = { defaultStock: number; warrantyMonths: number; prepDays: number; deliveryUsa: number; deliveryMx: number };

function settingsFrom(rules: any): Settings {
    const n = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    return {
        defaultStock: n(rules?.default_stock, 3),
        warrantyMonths: n(rules?.warranty_months, 1),
        prepDays: n(rules?.prep_days ?? rules?.handling_time_mx, 3),
        deliveryUsa: n(rules?.amazon_delivery_usa, 10),
        deliveryMx: n(rules?.amazon_delivery_mx, 3),
    };
}

function buildPayload(item: any, row: any, s: Settings) {
    const pictures = (item.pictures ?? [])
        .map((p: any) => ({ source: p?.secure_url ?? p?.url }))
        .filter((p: any) => p.source)
        .slice(0, 10);

    // As listed on ML; SELLER_SKU is the ASIN, as the importer sets it.
    const attributes = (item.attributes ?? [])
        .filter((a: any) => a?.id && a.id !== "SELLER_SKU" && (a.value_name != null || a.value_id != null))
        .map((a: any) => ({
            id: a.id,
            ...(a.value_id != null ? { value_id: a.value_id } : {}),
            ...(a.value_name != null ? { value_name: a.value_name } : {}),
        }));
    attributes.push({ id: "SELLER_SKU", value_name: row.asin });

    const saleTerms = (item.sale_terms ?? [])
        .filter((t: any) => KEPT_SALE_TERMS.has(t?.id) && t.value_name)
        .map((t: any) => ({ id: t.id, value_name: t.value_name }));
    if (!saleTerms.some((t: any) => t.id === "WARRANTY_TYPE")) {
        const w = s.warrantyMonths;
        saleTerms.push(
            { id: "WARRANTY_TYPE", value_name: "Garantía del vendedor" },
            { id: "WARRANTY_TIME", value_name: w >= 12 ? `${Math.floor(w / 12)} año${w >= 24 ? "s" : ""}` : `${w} mes${w > 1 ? "es" : ""}` },
        );
    }

    // The listing's own preparation time when it had one, else the settings'
    // prep + Amazon delivery days, like buildItemPayload.
    const manufacturingDays = parseInt(saleTerms.find((t: any) => t.id === "MANUFACTURING_TIME")?.value_name ?? "", 10);
    const isUsd = (row.currency ?? "").toUpperCase() === "USD";
    const handlingTime = Number.isFinite(manufacturingDays) && manufacturingDays > 0
        ? manufacturingDays
        : s.prepDays + (isUsd ? s.deliveryUsa : s.deliveryMx);

    // buildItemPayload's safeTitle cleanup. Confirmed live: listings carry
    // titles up to ~85 characters, and ML caps title (and family_name, which
    // publishItemWithFallbacks sends instead for accounts that need it) at 60 —
    // over that, /items/validate answered 400 or even a 500.
    const title = String(item.title ?? row.title ?? "")
        .replace(/[<>|\\]/g, "").replace(/\s+/g, " ").trim()
        .substring(0, 60).trim().replace(/[,;:\-]+$/, "").trim();

    return {
        title,
        category_id: item.category_id,
        price: item.price ?? row.price_mxn,
        currency_id: item.currency_id ?? "MXN",
        available_quantity: s.defaultStock,
        buying_mode: "buy_it_now",
        listing_type_id: item.listing_type_id ?? "gold_special",
        condition: "new",
        ...(row.source_description ? { description: { plain_text: String(row.source_description).slice(0, 5000) } } : {}),
        seller_custom_field: row.asin,
        pictures,
        attributes,
        sale_terms: saleTerms,
        shipping: { mode: "me2", free_shipping: true, local_pick_up: false, logistic_type: "drop_off", handling_time: handlingTime },
    };
}

async function recover(supabase: any, fromUserId: string, toUserId: string, limit: number) {
    const startedAt = Date.now();

    const { data: owner } = await supabase.from("user_connections")
        .select("meli_credentials, margin_rules").eq("user_id", fromUserId).maybeSingle();
    const token = owner?.meli_credentials?.token;
    const expiresAt = Number(owner?.meli_credentials?.expiresAt ?? 0);
    if (!token) return { error: "owner has no Mercado Libre token" };
    if (expiresAt < Date.now() + 5 * 60_000) {
        return { error: "owner's Mercado Libre token expires within 5 minutes; open Melidrop as the owner to renew it, then run again" };
    }
    const settings = settingsFrom(owner?.margin_rules);

    let recovered = 0, failed = 0, processed = 0, stoppedOn: string | null = null;
    // Page after page until the time budget, the limit, or nothing is left:
    // each page is the next pending rows, since finished ones drop out.
    while (!stoppedOn && processed < limit && Date.now() - startedAt < TIME_BUDGET_MS) {
        const { data: rows, error: rowsErr } = await supabase.from("test_products")
            .select("id,user_id,title,asin,price_mxn,currency,source_meli_id,source_description")
            .eq("user_id", toUserId).is("publish_payload", null).is("recovery_error", null)
            .not("source_meli_id", "is", null).order("id").limit(Math.min(PAGE, limit - processed));
        if (rowsErr) return { error: rowsErr.message };
        if (!rows?.length) break;
        processed += rows.length;

        const chunks: any[][] = [];
        for (let i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH));

        let next = 0;
        const worker = async () => {
            while (next < chunks.length && !stoppedOn && Date.now() - startedAt < TIME_BUDGET_MS) {
                const chunk = chunks[next++];
                const ids = chunk.map(r => r.source_meli_id).join(",");
                const res = await fetch(`${ML}/items?ids=${ids}&attributes=${ITEM_FIELDS}`, { headers: { Authorization: `Bearer ${token}` } });
                if (!res.ok) {
                    // Auth or rate-limit trouble applies to every chunk: stop and leave
                    // the rest pending for the next run.
                    stoppedOn = `ML multiget HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
                    return;
                }
                const results: any[] = await res.json();
                const byId = new Map(results.map((r: any) => [r?.body?.id, r]));
                const updates = chunk.map(row => {
                    const r: any = byId.get(row.source_meli_id);
                    const item = r?.code === 200 ? r.body : null;
                    if (!item?.category_id) {
                        failed++;
                        return { id: row.id, user_id: row.user_id, title: row.title,
                            recovery_error: `ML ${r?.code ?? "sin respuesta"}: ${String(r?.body?.message ?? r?.body?.error ?? "sin categoría").slice(0, 120)}` };
                    }
                    recovered++;
                    return { id: row.id, user_id: row.user_id, title: row.title, category: item.category_id,
                        publish_payload: buildPayload(item, row, settings) };
                });
                const { error: upErr } = await supabase.from("test_products").upsert(updates, { onConflict: "id" });
                if (upErr) { stoppedOn = `could not save: ${upErr.message}`; return; }
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    }

    const { count: remaining } = await supabase.from("test_products")
        .select("*", { count: "exact", head: true })
        .eq("user_id", toUserId).is("publish_payload", null).is("recovery_error", null).not("source_meli_id", "is", null);
    console.log(`[listing-recovery] recovered=${recovered} failed=${failed} remaining=${remaining}${stoppedOn ? ` stopped: ${stoppedOn}` : ""}`);
    return { recovered, failed, remaining, ...(stoppedOn ? { stoppedOn } : {}) };
}

Deno.serve(async (req) => {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    // Same gate as amazon-offer-scan: a shared secret only the database holds
    // (edge_function_config, RLS on with no policies).
    const { data: cfg } = await supabase.from("edge_function_config")
        .select("value").eq("name", "amazon_offer_scan_secret").maybeSingle();
    if (!cfg?.value || req.headers.get("x-scan-secret") !== cfg.value) return json({ error: "forbidden" }, 403);

    const { fromUserId, toUserId, limit, wait } = await req.json().catch(() => ({}));
    if (!fromUserId || !toUserId) return json({ error: "fromUserId and toUserId required" }, 400);
    const work = recover(supabase, fromUserId, toUserId, Math.min(Number(limit) || 50_000, 50_000)).catch(e => {
        console.error("[listing-recovery] run failed:", e);
        return { error: String(e) };
    });
    // wait=true answers with the result (small test runs); otherwise reply
    // right away and keep going in the background, so a caller's HTTP timeout
    // can't cut a run short.
    const edgeRuntime = (globalThis as any).EdgeRuntime;
    if (!wait && edgeRuntime?.waitUntil) {
        edgeRuntime.waitUntil(work);
        return json({ started: true }, 202);
    }
    return json(await work);
});
