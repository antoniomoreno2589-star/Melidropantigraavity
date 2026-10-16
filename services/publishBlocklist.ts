import { supabase } from './supabase';

// Brands and ASINs this user must never publish (table publish_blocklist).
// The importer drops them before spending on AI, and meliService refuses to
// publish them on every path. Brands are compared exactly after brandKey(),
// not searched for in titles like the "Filtro Global" words.

export interface BlocklistEntry {
    kind: 'brand' | 'asin';
    value: string;
    display: string | null;
    source: string;
    note: string | null;
}

// Mirrors public.blocklist_brand_key (supabase/migrations/20261016_publish_blocklist.sql):
// "Melissa & Doug" and "MELISSA AND DOUG" are the same brand; "..." is none.
export function brandKey(brand?: string | null): string | null {
    const key = (brand ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    return key || null;
}

// Mirrors public.blocklist_is_generic_brand: placeholders sellers use for
// "no brand". Blocking one would block every unbranded product.
const GENERIC_BRANDS = new Set([
    'generic', 'generico', 'generica', 'genericos', 'genericas', 'marca generica',
    'sin marca', 'unbranded', 'no brand', 'n a', 'na', 'none', 'oem', 'unknown',
    'sin especificar', 'no especificada', 'no especificado', 'no aplica',
    'otros', 'otro', 'otra', 'varios', 'brand', 'marca', 'desconocida', 'desconocido',
]);
export const isGenericBrand = (key: string | null): boolean => !key || GENERIC_BRANDS.has(key);

type Loaded = { userId: string; brands: Map<string, BlocklistEntry>; asins: Map<string, BlocklistEntry> };
let cache: { userId: string; promise: Promise<Loaded> } | null = null;

async function currentUserId(): Promise<string | null> {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user?.id ?? null;
}

async function fetchAll(userId: string): Promise<Loaded> {
    const brands = new Map<string, BlocklistEntry>();
    const asins = new Map<string, BlocklistEntry>();
    // PostgREST returns at most 1000 rows per request.
    for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
            .from('publish_blocklist')
            .select('kind,value,display,source,note')
            .eq('user_id', userId)
            .order('kind').order('value')
            .range(from, from + 999);
        if (error) throw new Error(`No se pudo leer la lista de bloqueo: ${error.message}`);
        for (const row of (data ?? []) as BlocklistEntry[]) {
            if (row.kind === 'asin') {
                asins.set(row.value.toUpperCase(), row);
            } else {
                // Keyed by this file's normalization of the brand as written, so it
                // always matches brandKey() of a product's brand.
                for (const key of [brandKey(row.display), brandKey(row.value)]) {
                    if (key) brands.set(key, row);
                }
            }
        }
        if (!data || data.length < 1000) return { userId, brands, asins };
    }
}

async function load(): Promise<Loaded> {
    const userId = await currentUserId();
    if (!userId) return { userId: '', brands: new Map(), asins: new Map() };
    if (!cache || cache.userId !== userId) {
        const promise = fetchAll(userId);
        cache = { userId, promise };
        // A failed load must not stick: the next check retries.
        promise.catch(() => { if (cache?.promise === promise) cache = null; });
    }
    return cache.promise;
}

// The ASIN and brand a Mercado Libre item payload carries (buildItemPayload
// puts the ASIN in seller_custom_field and SELLER_SKU, the brand in BRAND).
function payloadAsinAndBrand(payload: any): { asin: string | null; brand: string | null } {
    const attrs: any[] = Array.isArray(payload?.attributes) ? payload.attributes : [];
    const attr = (...ids: string[]) => attrs.find(a => ids.includes(a?.id))?.value_name ?? null;
    return {
        asin: payload?.seller_custom_field ?? attr('SELLER_SKU'),
        brand: attr('BRAND', 'MARCA'),
    };
}

export const publishBlocklist = {
    // Why this product is blocked, or null. Throws if the list can't be read,
    // so callers fail closed instead of publishing unchecked.
    async check(item: { asin?: string | null; brand?: string | null }): Promise<BlocklistEntry | null> {
        const { brands, asins } = await load();
        const asin = item.asin?.trim().toUpperCase();
        if (asin && asins.has(asin)) return asins.get(asin)!;
        const key = brandKey(item.brand);
        if (!isGenericBrand(key) && brands.has(key!)) return brands.get(key!)!;
        return null;
    },

    async checkPayload(payload: any): Promise<BlocklistEntry | null> {
        return this.check(payloadAsinAndBrand(payload));
    },

    describe(entry: BlocklistEntry): string {
        return entry.kind === 'brand'
            ? `la marca "${entry.display ?? entry.value}" está en tu lista de bloqueo`
            : `el ASIN ${entry.value} está en tu lista de bloqueo`;
    },

    async counts(): Promise<{ brands: number; asins: number }> {
        const { brands, asins } = await load();
        return { brands: new Set([...brands.values()].map(e => e.value)).size, asins: asins.size };
    },

    // Up to `limit` entries whose brand or ASIN contains `query`.
    async search(query: string, limit = 50): Promise<BlocklistEntry[]> {
        const { brands, asins } = await load();
        const q = brandKey(query);
        const upper = query.trim().toUpperCase();
        if (!q && !upper) return [];
        const seen = new Set<string>();
        const out: BlocklistEntry[] = [];
        for (const e of [...brands.values(), ...asins.values()]) {
            const id = `${e.kind}:${e.value}`;
            if (seen.has(id)) continue;
            const hit = e.kind === 'asin' ? e.value.includes(upper) : !!q && (brandKey(e.display) ?? e.value).includes(q);
            if (hit) { seen.add(id); out.push(e); }
            if (out.length >= limit) break;
        }
        return out;
    },

    async addBrands(names: string[]): Promise<{ added: number; skippedGeneric: string[] }> {
        const userId = await currentUserId();
        if (!userId) throw new Error('Inicia sesión para editar la lista de bloqueo.');
        const skippedGeneric: string[] = [];
        const rows = new Map<string, any>();
        for (const name of names.map(n => n.trim()).filter(Boolean)) {
            const key = brandKey(name);
            if (isGenericBrand(key)) { skippedGeneric.push(name); continue; }
            rows.set(key!, { user_id: userId, kind: 'brand', value: key, display: name, source: 'manual' });
        }
        if (rows.size > 0) {
            const { error } = await supabase.from('publish_blocklist')
                .upsert([...rows.values()], { onConflict: 'user_id,kind,value', ignoreDuplicates: true });
            if (error) throw new Error(`No se pudieron agregar las marcas: ${error.message}`);
        }
        cache = null;
        return { added: rows.size, skippedGeneric };
    },

    async remove(entry: BlocklistEntry): Promise<void> {
        const userId = await currentUserId();
        if (!userId) throw new Error('Inicia sesión para editar la lista de bloqueo.');
        const { error } = await supabase.from('publish_blocklist')
            .delete().eq('user_id', userId).eq('kind', entry.kind).eq('value', entry.value);
        if (error) throw new Error(`No se pudo quitar de la lista: ${error.message}`);
        cache = null;
    },
};
