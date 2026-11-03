import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// One pass over a user's listings that only ever RAISES a price, to what the
// margin rules give for today's Amazon cost (offer price + shipping), compared
// with the seller's own price on Mercado Libre; stock, status, promotions and
// preparation time are left alone. Asked for by the owner after a check found
// 17 of 93 sampled listings under their rule. Progress lives in price_passes
// (one row per user; inserting it starts a pass); each invocation takes the
// next listings by id under a lease, so the cron that pokes it can't process
// the same ones twice. Pricing is the Actualizador's (amazon-ml-updater):
// same rules, same winning offer, same cost.
//
// A listing whose stored origin (products.currency) disagrees with its
// catalog row's (test_products.currency) is looked up on both marketplaces
// and gets, in both tables, the one that actually sells it — the catalog's
// when both do. Confirmed live that neither side was reliable there:
// publishing recorded Mercado Libre's currency (always MXN) as the origin,
// and of 23 sampled listings stored as Amazon USA in the catalog, 10 don't
// exist on Amazon USA. Nothing is decided from a marketplace that didn't
// answer this time (throttled): those listings count as unanswered and stay
// as they are.

const MELI_API = "https://api.mercadolibre.com";
const LEASE_FREE = new Date(0).toISOString();
const MARKETPLACE_USA = "ATVPDKIKX0DER";
const MARKETPLACE_MXN = "A1AM78C64UM0Y8";
const AMAZON_SELLER_USA = "A1G99GVHAT2WD8";
const AMAZON_SELLER_MXN = "AVDBXBAVVSXLQ";
const PAGE = 120;
// getItemOffersBatch calls per invocation, 10.5 s apart: about a minute of
// Amazon, inside the edge function's 150 s.
const AMAZON_CALLS = 6;
const TIME_BUDGET_MS = 115_000;
const LEASE_MS = 4 * 60 * 1000;
const WORKERS = 4;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
};

interface Offers { price: number | null; winningOfferPrice: number | null }

async function getAmazonToken(creds: any): Promise<string> {
    const res = await fetch("https://api.amazon.com/auth/o2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: creds.refreshToken,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
        }).toString(),
    });
    if (!res.ok) throw new Error(`Amazon LWA error: ${await res.text()}`);
    return (await res.json()).access_token;
}

// The Actualizador's "Valores Fijos" winning offer: buy box → ships from
// MX, then US → Prime → FBA.
function pickWinningOffer(offers: any[]): any | null {
    if (!offers?.length) return null;
    let c = offers.filter(o => o.IsBuyBoxWinner);
    if (c.length === 0) c = offers;
    if (c.length === 1) return c[0];
    for (const country of ["MX", "US"]) {
        const inCountry = c.filter(o => o.ShipsFrom?.Country === country);
        if (inCountry.length > 0) { c = inCountry; break; }
    }
    if (c.length === 1) return c[0];
    const prime = c.filter(o => !!(o?.PrimeInformation?.IsNationalPrime ?? o?.PrimeInformation?.IsPrime));
    if (prime.length > 0) c = prime;
    if (c.length === 1) return c[0];
    const fba = c.filter(o => o.IsFulfilledByAmazon);
    if (fba.length > 0) c = fba;
    return c[0];
}

// Offer price plus its shipping (LowestPrices entries carry the sum as LandedPrice).
function offerCost(o: any): number | null {
    const landed = o?.LandedPrice?.Amount ?? o?.BuyingPrice?.LandedPrice?.Amount;
    if (typeof landed === "number") return landed;
    const price = o?.ListingPrice?.Amount ?? o?.BuyingPrice?.ListingPrice?.Amount;
    return typeof price === "number" ? price + (o?.Shipping?.Amount ?? o?.BuyingPrice?.Shipping?.Amount ?? 0) : null;
}

let nextAmazonSlot = 0;
async function paceAmazon() {
    const now = Date.now();
    const slot = Math.max(now, nextAmazonSlot);
    nextAmazonSlot = slot + 10_500;
    if (slot > now) await new Promise(r => setTimeout(r, slot - now));
}

// 20 ASINs per call. An ASIN Amazon didn't answer for is left out
// (undetermined); 404/400 means it has no offers on that marketplace.
async function fetchOffers(endpoint: string, token: string, asins: string[], marketplaceId: string, amazonSellerId: string): Promise<Record<string, Offers>> {
    const offers: Record<string, Offers> = {};
    for (let i = 0; i < asins.length; i += 20) {
        const chunk = asins.slice(i, i + 20);
        try {
            const call = async () => {
                await paceAmazon();
                return fetch(`${endpoint}/batches/products/pricing/v0/itemOffers`, {
                    method: "POST",
                    headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        requests: chunk.map(asin => ({ uri: `/products/pricing/v0/items/${asin}/offers`, method: "GET", MarketplaceId: marketplaceId, ItemCondition: "New" })),
                    }),
                });
            };
            let res = await call();
            if (res.status === 429) res = await call();
            if (!res.ok) {
                console.log(`[price-pass] Amazon ${marketplaceId} HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
                continue;
            }
            const responses: any[] = (await res.json())?.responses ?? [];
            // None OK is far likelier a request problem than every product gone.
            if (!responses.some(r => r?.status?.statusCode === 200)) continue;
            responses.forEach((resp: any, idx: number) => {
                const asin = resp?.request?.Asin ?? resp?.body?.payload?.ASIN ?? chunk[idx];
                const status = resp?.status?.statusCode ?? 0;
                if (!asin) return;
                if (status === 404 || status === 400) {
                    offers[asin] = { price: null, winningOfferPrice: null };
                    return;
                }
                const payload = resp?.body?.payload;
                if (status !== 200 || !payload) return;
                const all: any[] = payload.Offers ?? [];
                const lowestNew = payload.Summary?.LowestPrices?.find((p: any) => p.condition === "new" && p.fulfillmentChannel === "Amazon")
                    ?? payload.Summary?.LowestPrices?.[0];
                offers[asin] = {
                    price: offerCost(lowestNew) ?? offerCost(all.find(o => o.SellerId === amazonSellerId)),
                    winningOfferPrice: offerCost(pickWinningOffer(all)),
                };
            });
        } catch (e) {
            console.error(`[price-pass] Amazon ${marketplaceId} error:`, e);
        }
    }
    return offers;
}

// What buyers pay now (the promotional price during a promotion), 20 per call.
async function fetchMeliPrices(meliIds: string[], token: string): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    for (let i = 0; i < meliIds.length; i += 20) {
        try {
            const res = await fetch(`${MELI_API}/items?ids=${meliIds.slice(i, i + 20).join(",")}&attributes=id,price`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) continue;
            for (const r of await res.json()) {
                if (r?.code === 200 && typeof r.body?.price === "number") prices.set(r.body.id, r.body.price);
            }
        } catch (e) {
            console.error("[price-pass] ML multiget error:", e);
        }
    }
    return prices;
}

// The seller's own (standard) price; null when ML doesn't answer.
async function fetchMeliStandardPrice(meliId: string, token: string): Promise<number | null> {
    try {
        const res = await fetch(`${MELI_API}/items/${meliId}/prices`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return null;
        const standard = ((await res.json())?.prices ?? []).filter((p: any) => p?.type === "standard");
        const restrictions = (p: any): string[] => p?.conditions?.context_restrictions ?? [];
        const pick = standard.find((p: any) => restrictions(p).length === 0)
            ?? standard.find((p: any) => restrictions(p).includes("channel_marketplace"))
            ?? standard[0];
        return typeof pick?.amount === "number" ? pick.amount : null;
    } catch {
        return null;
    }
}

// Same as amazon-ml-updater's calculateMxnPrice.
function calculateMxnPrice(cost: number, currency: string, exchangeRate: number, usaRules: any[], mxRules: any[]): number {
    const isMXN = currency?.toUpperCase() === "MXN";
    const defaultUsaRules = [{ min: 0, max: 20, margin: 200 }, { min: 21, max: 50, margin: 100 }, { min: 51, max: null, margin: 50 }];
    const defaultMxRules = [{ min: 0, max: 300, margin: 150 }, { min: 301, max: 600, margin: 130 }, { min: 601, max: null, margin: 80 }];
    const rules = isMXN ? (mxRules?.length ? mxRules : defaultMxRules) : (usaRules?.length ? usaRules : defaultUsaRules);
    const r = rules.find(rule => cost >= rule.min && (rule.max === null || cost <= rule.max)) ?? rules[rules.length - 1];
    return isMXN ? Math.ceil(cost * (1 + r.margin / 100)) : Math.ceil(cost * exchangeRate * (1 + r.margin / 100));
}

async function runPricePass(supabase: any, userId: string): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const { data: pass } = await supabase.from("price_passes")
        .update({ locked_until: new Date(startedAt + LEASE_MS).toISOString() })
        .eq("user_id", userId).is("finished_at", null).lt("locked_until", new Date(startedAt).toISOString())
        .select().maybeSingle();
    if (!pass) return { skipped: true, reason: "no pass due (finished, or another invocation holds it)" };
    const release = (patch: Record<string, unknown>) =>
        supabase.from("price_passes").update({ ...patch, locked_until: LEASE_FREE }).eq("user_id", userId);

    try {
        const { data: conn } = await supabase.from("user_connections")
            .select("meli_credentials, amazon_credentials, exchange_rate, margin_rules")
            .eq("user_id", userId).maybeSingle();
        if (!conn?.meli_credentials?.token || !conn?.amazon_credentials?.refreshToken) throw new Error("missing Mercado Libre or Amazon credentials");
        // The stored token only: refreshing it here would use up Mercado Libre's
        // single-use refresh token behind the app's back and sign it out. The
        // app renews and saves it whenever it's open.
        const mlToken: string = conn.meli_credentials.token;
        if (Number(conn.meli_credentials.expiresAt ?? 0) < startedAt + 10 * 60_000) {
            await release({});
            return { skipped: true, reason: "Mercado Libre token expires within 10 minutes; open Melidrop to renew it" };
        }
        const settings = (conn.margin_rules ?? {}) as any;
        const exchangeRate = conn.exchange_rate ?? settings.exchange_rate ?? 18.5;
        const fixedMode = settings.update_mode === "fixed";

        let query = supabase.from("products").select("id, meli_id, sku, price_mxn, currency")
            .eq("user_id", userId).eq("in_updater", true)
            .not("meli_id", "is", null).not("sku", "is", null).neq("sku", "")
            .order("id").limit(PAGE);
        if (pass.last_id) query = query.gt("id", pass.last_id);
        const { data: page, error: pageErr } = await query;
        if (pageErr) throw new Error(pageErr.message);
        if (!page?.length) {
            await release({ finished_at: new Date().toISOString() });
            return { finished: true };
        }

        const { data: catalogRows } = await supabase.from("test_products").select("meli_id, currency")
            .eq("user_id", userId).in("meli_id", page.map((p: any) => p.meli_id));
        const catalogOrigin = new Map<string, string>((catalogRows ?? []).map((r: any) => [r.meli_id, r.currency === "USD" ? "USD" : "MXN"]));
        // The Actualizador's convention: no currency means Amazon USA.
        const storedOrigin = (p: any): string => (p.currency ?? "USD") === "MXN" ? "MXN" : "USD";
        const candidates = (p: any): string[] => {
            const stored = storedOrigin(p);
            const catalog = catalogOrigin.get(p.meli_id) ?? stored;
            return catalog === stored ? [stored] : [catalog, stored];
        };

        // As many listings as fit in AMAZON_CALLS batch calls.
        const products: any[] = [];
        let usdCount = 0, mxnCount = 0;
        for (const p of page) {
            const c = candidates(p);
            const usd = usdCount + (c.includes("USD") ? 1 : 0);
            const mxn = mxnCount + (c.includes("MXN") ? 1 : 0);
            if (Math.ceil(usd / 20) + Math.ceil(mxn / 20) > AMAZON_CALLS) break;
            usdCount = usd;
            mxnCount = mxn;
            products.push(p);
        }

        const endpoint = ({
            na: "https://sellingpartnerapi-na.amazon.com",
            eu: "https://sellingpartnerapi-eu.amazon.com",
            fe: "https://sellingpartnerapi-fe.amazon.com",
        } as Record<string, string>)[conn.amazon_credentials.region] ?? "https://sellingpartnerapi-na.amazon.com";
        const amazonToken = await getAmazonToken(conn.amazon_credentials);
        const usdAsins = products.filter(p => candidates(p).includes("USD")).map(p => p.sku);
        const mxnAsins = products.filter(p => candidates(p).includes("MXN")).map(p => p.sku);
        const [usdOffers, mxnOffers] = await Promise.all([
            fetchOffers(endpoint, amazonToken, usdAsins, MARKETPLACE_USA, AMAZON_SELLER_USA),
            fetchOffers(endpoint, amazonToken, mxnAsins, MARKETPLACE_MXN, AMAZON_SELLER_MXN),
        ]);
        const livePrices = await fetchMeliPrices(products.map(p => p.meli_id), mlToken);

        let raised = 0, kept = 0, noAmazon = 0, unanswered = 0, originFixed = 0, errors = 0;
        const processOne = async (p: any) => {
            let origin: string | null = null;
            let cost: number | null = null;
            let answered = true;
            for (const c of candidates(p)) {
                const o = (c === "USD" ? usdOffers : mxnOffers)[p.sku];
                if (o === undefined) { answered = false; break; }
                const v = fixedMode ? o.winningOfferPrice : o.price;
                if (typeof v === "number" && v > 0) { origin = c; cost = v; break; }
            }

            const dbUpdate: Record<string, unknown> = {};
            const catalog = catalogOrigin.get(p.meli_id);
            if (origin && (origin !== storedOrigin(p) || (catalog !== undefined && origin !== catalog))) {
                originFixed++;
                if (origin !== storedOrigin(p)) dbUpdate.currency = origin;
                if (catalog !== undefined && origin !== catalog) {
                    await supabase.from("test_products").update({ currency: origin }).eq("user_id", userId).eq("meli_id", p.meli_id);
                }
            }

            const livePrice = livePrices.get(p.meli_id);
            if (!answered) {
                unanswered++;
            } else if (origin === null || cost === null) {
                noAmazon++;
            } else if (livePrice === undefined) {
                errors++;
                console.log(`[price-pass] ${p.meli_id}: no current price from Mercado Libre, left alone`);
            } else {
                const rulePrice = calculateMxnPrice(cost, origin, exchangeRate, settings.usa ?? [], settings.mx ?? []);
                if (rulePrice <= livePrice) {
                    kept++;
                } else {
                    // During a promotion livePrice is the promotional price; the
                    // seller's own price may already meet the rule.
                    const standard = await fetchMeliStandardPrice(p.meli_id, mlToken);
                    if (standard === null) {
                        errors++;
                        console.log(`[price-pass] ${p.meli_id}: no standard price from Mercado Libre, left alone`);
                    } else if (rulePrice <= standard) {
                        kept++;
                        if (standard !== Number(p.price_mxn)) dbUpdate.price_mxn = standard;
                    } else {
                        const res = await fetch(`${MELI_API}/items/${p.meli_id}`, {
                            method: "PUT",
                            headers: { Authorization: `Bearer ${mlToken}`, "Content-Type": "application/json" },
                            body: JSON.stringify({ price: rulePrice }),
                        });
                        if (res.ok) {
                            raised++;
                            dbUpdate.price_mxn = rulePrice;
                            console.log(`[price-pass] ${p.meli_id} sku=${p.sku}: ${standard} → ${rulePrice} (cost ${cost} ${origin})`);
                        } else {
                            errors++;
                            console.log(`[price-pass] ${p.meli_id}: ML kept ${standard} — HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
                        }
                    }
                }
            }
            if (dbUpdate.price_mxn === undefined && livePrice !== undefined && livePrice !== Number(p.price_mxn)) {
                dbUpdate.price_mxn = livePrice;
            }
            if (Object.keys(dbUpdate).length > 0) {
                await supabase.from("products").update(dbUpdate).eq("id", p.id);
            }
        };

        // Taken in id order, so everything before `next` is done once the
        // workers stop. The first few always run, so a slow Amazon part can't
        // stall the pass on the same listings.
        let next = 0;
        const worker = async () => {
            while (next < products.length && (next < WORKERS || Date.now() - startedAt < TIME_BUDGET_MS)) {
                const p = products[next++];
                try {
                    await processOne(p);
                } catch (e) {
                    errors++;
                    console.error(`[price-pass] ${p.meli_id}:`, e);
                }
            }
        };
        await Promise.all(Array.from({ length: WORKERS }, worker));

        const done = next === page.length && page.length < PAGE;
        await release({
            last_id: products[next - 1].id,
            processed: pass.processed + next,
            raised: pass.raised + raised,
            kept: pass.kept + kept,
            no_amazon: pass.no_amazon + noAmazon,
            unanswered: pass.unanswered + unanswered,
            origin_fixed: pass.origin_fixed + originFixed,
            errors: pass.errors + errors,
            ...(done ? { finished_at: new Date().toISOString() } : {}),
        });
        return { processed: next, raised, kept, noAmazon, unanswered, originFixed, errors, done };
    } catch (e) {
        // Lease released so the next poke retries the same listings.
        await release({});
        throw e;
    }
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    let userId: string | null = null;
    try { userId = (await req.json())?.userId ?? null; } catch { /* no body */ }
    if (!userId) return new Response(JSON.stringify({ success: false, error: "userId required" }), { status: 400, headers: corsHeaders });
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    try {
        return new Response(JSON.stringify({ success: true, ...(await runPricePass(supabase, userId)) }), { headers: corsHeaders });
    } catch (err: any) {
        console.error("price-pass error:", err);
        return new Response(JSON.stringify({ success: false, error: err?.message ?? String(err) }), { status: 500, headers: corsHeaders });
    }
});
