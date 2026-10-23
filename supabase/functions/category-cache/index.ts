import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Caches Mercado Libre's definitions for every category an account's test
// products use, in ml_category_cache: each attribute's name, type, tags,
// units and closed-list values, plus settings.max_title_length. Reading them
// once here (3,500+ categories for an account handed a whole catalog) lets
// the database tell which attribute values are just the attribute's own name
// ("Color: Color") and how long each category's titles may be, without a
// Mercado Libre call per product.
//
// Category data is public; the account's test-user token is sent when there
// is one, in case ML asks for a token. Nothing is written to Mercado Libre.

const ML = "https://api.mercadolibre.com";
const CONCURRENCY = 6;
const TIME_BUDGET_MS = 50_000;
const PAGE = 1000;           // PostgREST's max rows per request
const MAX_VALUES = 300;      // closed lists longer than this are kept truncated

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function selectAll<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
    const rows: T[] = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await query(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...(data ?? []));
        if ((data ?? []).length < PAGE) return rows;
    }
}

async function getJson(url: string, token?: string): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
        if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        return await res.json();
    }
    throw new Error(`429 ${url}`);
}

// Only what Melidrop reads: tags as a list of the ones that are set, and
// values only for closed lists (list/boolean), where they're the whole
// allowed set rather than suggestions.
function compact(attr: any) {
    const tags = Object.entries(attr?.tags ?? {}).filter(([, v]) => v === true).map(([k]) => k);
    const closed = attr?.value_type === "list" || attr?.value_type === "boolean";
    return {
        id: attr?.id,
        name: attr?.name,
        value_type: attr?.value_type,
        tags,
        ...(attr?.allowed_units?.length ? { allowed_units: attr.allowed_units.map((u: any) => u.id ?? u.name) } : {}),
        ...(attr?.default_unit ? { default_unit: attr.default_unit } : {}),
        ...(closed && attr?.values?.length
            ? { values: attr.values.slice(0, MAX_VALUES).map((v: any) => ({ id: v.id, name: v.name })) }
            : {}),
    };
}

async function run(supabase: any, userId: string) {
    const started = Date.now();
    const { data: conn } = await supabase.from("user_connections").select("meli_test_user").eq("user_id", userId).maybeSingle();
    const token: string | undefined = conn?.meli_test_user?.access_token ?? undefined;

    const used = await selectAll<{ category: string | null }>((from, to) => supabase
        .from("test_products").select("category").eq("user_id", userId).not("category", "is", null).order("id").range(from, to));
    const cached = await selectAll<{ category_id: string }>((from, to) => supabase
        .from("ml_category_cache").select("category_id").order("category_id").range(from, to));
    const have = new Set(cached.map(c => c.category_id));
    const pending = [...new Set(used.map(u => u.category).filter((c): c is string => !!c && /^MLM\d+$/.test(c)))]
        .filter(c => !have.has(c));

    let done = 0, failed = 0, next = 0;
    const rows: any[] = [];
    const flush = async () => {
        if (rows.length === 0) return;
        const batch = rows.splice(0, rows.length);
        const { error } = await supabase.from("ml_category_cache").upsert(batch, { onConflict: "category_id" });
        if (error) throw error;
    };
    const worker = async () => {
        while (next < pending.length && Date.now() - started < TIME_BUDGET_MS) {
            const id = pending[next++];
            try {
                const [category, attributes] = await Promise.all([
                    getJson(`${ML}/categories/${id}`, token),
                    getJson(`${ML}/categories/${id}/attributes`, token),
                ]);
                rows.push({
                    category_id: id,
                    max_title_length: category?.settings?.max_title_length ?? null,
                    attributes: (Array.isArray(attributes) ? attributes : []).map(compact),
                    fetched_at: new Date().toISOString(),
                });
                done++;
                if (rows.length >= 50) await flush();
            } catch (e) {
                failed++;
                console.warn(`[category-cache] ${id}:`, String(e));
            }
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await flush();
    const remaining = pending.length - done;
    console.log(`[category-cache] cached=${done} failed=${failed} remaining=${remaining}`);
    return { cached: done, failed, remaining };
}

Deno.serve(async (req) => {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    // Same gate as amazon-offer-scan and listing-recovery: a shared secret only
    // the database holds (edge_function_config, RLS on with no policies).
    const { data: cfg } = await supabase.from("edge_function_config")
        .select("value").eq("name", "amazon_offer_scan_secret").maybeSingle();
    if (!cfg?.value || req.headers.get("x-scan-secret") !== cfg.value) return json({ error: "forbidden" }, 403);

    const { userId, wait } = await req.json().catch(() => ({}));
    if (!userId) return json({ error: "userId required" }, 400);
    const work = run(supabase, userId).catch(e => {
        console.error("[category-cache] run failed:", e);
        return { error: String(e) };
    });
    // wait=true answers with the result; otherwise reply right away and keep
    // going in the background, so a caller's HTTP timeout can't cut it short.
    const edgeRuntime = (globalThis as any).EdgeRuntime;
    if (!wait && edgeRuntime?.waitUntil) {
        edgeRuntime.waitUntil(work);
        return json({ started: true }, 202);
    }
    return json(await work);
});
