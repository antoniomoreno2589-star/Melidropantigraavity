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

interface ShippingResult {
    days: number | null;
    available: boolean | null; // false = Oxylabs confirmed unavailable; null = unknown
}

function findAllSpanishDates(text: string): number[] {
    const monthMap: Record<string, number> = {
        // Full names
        'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4,
        'junio': 5, 'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9,
        'noviembre': 10, 'diciembre': 11,
        // Abbreviated (Amazon uses "jun.", "dic.", etc.)
        'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3,
        'jun': 5, 'jul': 6, 'ago': 7, 'sep': 8, 'sept': 8,
        'oct': 9, 'nov': 10, 'dic': 11,
    };
    // Match full month names first (longer → shorter) to avoid partial matches
    const regex = /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|sept|ene|feb|mar|abr|jun|jul|ago|sep|oct|nov|dic)\.?/gi;
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

function buildAmazonLocationCookies(postalCode: string) {
    // Amazon's LSEXSAV cookie stores the last selected delivery location set via
    // the "Deliver to" glow widget. Injecting it lets Amazon render cross-border
    // delivery dates without a full authenticated session.
    const locationJson = JSON.stringify({
        zipCode: postalCode,
        countryCode: "MX",
        addressType: "RESIDENTIAL",
    });
    return [
        { key: "LSEXSAV", value: encodeURIComponent(locationJson), domain: ".amazon.com.mx" },
        { key: "i18n-prefs",  value: "MXN",   domain: ".amazon.com.mx" },
        { key: "lc-acbmx",    value: "es_MX", domain: ".amazon.com.mx" },
    ];
}

function extractDeliverySection(html: string): string | null {
    // Extract only the delivery/dispatch block from Amazon's HTML to avoid
    // false positives from product carousels further down the page.
    const markers = [
        'deliveryMessageMirId',
        'ddm_feature_div',
        'mir-layout-DELIVERY_BLOCK',
        'delivery-message',
        'ddmDeliveryMessage',
    ];
    for (const id of markers) {
        const idx = html.indexOf(`id="${id}"`);
        if (idx !== -1) return html.slice(idx, idx + 800);
    }
    return null;
}

function extractAodTopOffer(html: string): string | null {
    // The AOD (All Offers Display) HTML has a pinned (top/recommended) offer.
    // Its delivery promise is in a specific section we want to isolate from other offers.
    const markers = [
        'aod-pinned-offer-delivery-promise',
        'aod-pinned-offer',
        'aod-offer-soldBy',
        'aod-delivery-promise',
        'aod-offer',
    ];
    for (const id of markers) {
        const idx = html.indexOf(`id="${id}"`);
        if (idx !== -1) return html.slice(idx, idx + 2500);
    }
    // Class-based fallback (some AOD elements use class instead of id)
    for (const cls of ['aod-pinned-offer', 'aod-offer']) {
        const idx = html.indexOf(`class="${cls}`);
        if (idx !== -1) return html.slice(idx, idx + 2500);
    }
    return null;
}

async function fetchDirectProductPageDaysNoInteraction(asin: string, postalCode: string, auth: string): Promise<number | null> {
    const productUrl = `https://www.amazon.com.mx/dp/${asin}`;
    console.log(`[fetchDirectProductPageDaysNoInteraction] asin=${asin} fetching without browser interaction`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
        const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": auth },
            body: JSON.stringify({ source: "amazon", url: productUrl, geo_location: postalCode, render: "html", parse: false }),
            signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) { console.log(`[fetchDirectProductPageDaysNoInteraction] asin=${asin} HTTP ${res.status}`); return null; }
        const data = await res.json();
        const html = data?.results?.[0]?.content;
        if (typeof html !== 'string' || html.length < 100) { return null; }
        const deliverySection = extractDeliverySection(html);
        console.log(`[fetchDirectProductPageDaysNoInteraction] asin=${asin} deliverySection=${deliverySection !== null}. HTML[0:3000]: ${html.slice(0, 3000)}`);
        if (!deliverySection) return null;
        if (/(llega|entrega|recibe)\s+ma[ñn]ana/i.test(deliverySection)) return 1;
        if (/(llega|entrega|recibe)\s+hoy/i.test(deliverySection)) return 0;
        const dates = findAllSpanishDates(deliverySection);
        if (dates.length > 0) { const max = Math.max(...dates); console.log(`[fetchDirectProductPageDaysNoInteraction] asin=${asin} → ${max} días`); return max; }
        console.log(`[fetchDirectProductPageDaysNoInteraction] asin=${asin} section found but no dates: ${deliverySection.slice(0, 400)}`);
        return null;
    } catch (e) { clearTimeout(timer); console.log(`[fetchDirectProductPageDaysNoInteraction] asin=${asin} error: ${e}`); return null; }
}

async function fetchDirectProductPageDays(asin: string, postalCode: string, auth: string): Promise<number | null> {
    // browser_instructions text input (fill/type) not supported by Oxylabs amazon source.
    // Try passing the postal code as a ?zip= URL parameter — Amazon may pre-populate
    // the delivery section when this parameter is present.
    const productUrl = `https://www.amazon.com.mx/dp/${asin}?zip=${postalCode}`;
    console.log(`[fetchDirectProductPageDays] asin=${asin} fetching with ?zip=${postalCode}`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);

    try {
        const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": auth },
            body: JSON.stringify({
                source: "amazon",
                url: productUrl,
                geo_location: postalCode,
                render: "html",
                parse: false,
                cookies: buildAmazonLocationCookies(postalCode),
                context: [{ key: "force_cookies", value: true }],
            }),
            signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
            console.log(`[fetchDirectProductPageDays] asin=${asin} HTTP ${res.status}`);
            return null;
        }

        const data = await res.json();
        const html = data?.results?.[0]?.content;

        if (typeof html !== 'string' || html.length < 100) {
            console.log(`[fetchDirectProductPageDays] asin=${asin} empty/short HTML`);
            return null;
        }

        const deliverySection = extractDeliverySection(html);
        console.log(`[fetchDirectProductPageDays] asin=${asin} deliverySection=${deliverySection !== null}`);
        if (!deliverySection) return null;

        if (/(llega|entrega|recibe)\s+ma[ñn]ana/i.test(deliverySection)) return 1;
        if (/(llega|entrega|recibe)\s+hoy/i.test(deliverySection)) return 0;

        const dates = findAllSpanishDates(deliverySection);
        if (dates.length > 0) {
            const max = Math.max(...dates);
            console.log(`[fetchDirectProductPageDays] asin=${asin} → ${max} días. section: ${deliverySection.slice(0, 400)}`);
            return max;
        }

        console.log(`[fetchDirectProductPageDays] asin=${asin} section found but no dates: ${deliverySection.slice(0, 400)}`);
        return null;
    } catch (e) {
        clearTimeout(timer);
        console.log(`[fetchDirectProductPageDays] asin=${asin} error: ${e}`);
        return null;
    }
}

async function fetchScrapedoDeliveryDays(asin: string): Promise<number | null> {
    // Scrape.do uses real residential IPs + headless Chromium rendering.
    // Unlike Oxylabs (datacenter IPs), Amazon shows delivery dates to residential IPs
    // even without a session — the same way it works in the user's incognito browser.
    const token = Deno.env.get("SCRAPEDO_TOKEN");
    if (!token) {
        console.log(`[fetchScrapedo] asin=${asin} SCRAPEDO_TOKEN not set, skipping`);
        return null;
    }

    const targetUrl = `https://www.amazon.com.mx/dp/${asin}`;
    const apiUrl = `https://api.scrape.do/?token=${token}&url=${encodeURIComponent(targetUrl)}&render=true&super=true&geoCode=mx`;
    console.log(`[fetchScrapedo] asin=${asin} fetching with residential IP + JS render`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000);

    try {
        const res = await fetch(apiUrl, { signal: ctrl.signal });
        clearTimeout(timer);

        if (!res.ok) {
            console.log(`[fetchScrapedo] asin=${asin} HTTP ${res.status}`);
            return null;
        }

        const html = await res.text();

        if (!html || html.length < 100) {
            console.log(`[fetchScrapedo] asin=${asin} empty/short HTML`);
            return null;
        }

        // Log global delivery snippets to confirm residential IP is working
        const globalMatch = html.match(/(entrega|llega|recibe)[^<\n]{0,150}/gi);
        if (globalMatch) {
            console.log(`[fetchScrapedo] asin=${asin} delivery snippets: ${globalMatch.slice(0, 3).map(s => s.trim()).join(' || ')}`);
        } else {
            console.log(`[fetchScrapedo] asin=${asin} NO delivery keywords in HTML (${html.length} chars)`);
        }

        const deliverySection = extractDeliverySection(html);
        console.log(`[fetchScrapedo] asin=${asin} deliverySection=${deliverySection !== null}`);

        const searchText = deliverySection ?? html;

        if (/(llega|entrega|recibe)\s+ma[ñn]ana/i.test(searchText)) {
            console.log(`[fetchScrapedo] asin=${asin} → mañana (1 día)`);
            return 1;
        }
        if (/(llega|entrega|recibe)\s+hoy/i.test(searchText)) {
            console.log(`[fetchScrapedo] asin=${asin} → hoy (0 días)`);
            return 0;
        }

        const dates = findAllSpanishDates(searchText);
        if (dates.length > 0) {
            const max = Math.max(...dates);
            const snippet = [...searchText.matchAll(/(?:entrega|llega|recibe)[^<\n]{0,120}/gi)].slice(0, 2).map(m => m[0].trim()).join(' || ');
            console.log(`[fetchScrapedo] asin=${asin} → ${max} días. snippet: ${snippet}`);
            return max;
        }

        if (deliverySection) {
            console.log(`[fetchScrapedo] asin=${asin} section found but no dates: ${deliverySection.slice(0, 400)}`);
        } else {
            console.log(`[fetchScrapedo] asin=${asin} no delivery dates found`);
        }
        return null;
    } catch (e) {
        clearTimeout(timer);
        console.log(`[fetchScrapedo] asin=${asin} error: ${e}`);
        return null;
    }
}

async function fetchSearchPageDeliveryDays(asin: string, postalCode: string, auth: string): Promise<number | null> {
    // Search for the ASIN on Amazon's search page.
    // Search result cards show delivery dates as static text based on geo_location (IP),
    // unlike the product detail page which requires CP widget interaction.
    // Each card has data-asin="XXXX" — sponsored products have different ASINs,
    // so matching on the exact ASIN isolates the organic result for this product.
    const searchUrl = `https://www.amazon.com.mx/s?k=${asin}`;
    console.log(`[fetchSearchPageDelivery] asin=${asin} searching with geo_location=${postalCode}`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);

    try {
        const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": auth },
            body: JSON.stringify({
                source: "amazon",
                url: searchUrl,
                geo_location: postalCode,
                render: "html",
                parse: false,
                cookies: buildAmazonLocationCookies(postalCode),
                context: [{ key: "force_cookies", value: true }],
            }),
            signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (!res.ok) { console.log(`[fetchSearchPageDelivery] asin=${asin} HTTP ${res.status}`); return null; }

        const data = await res.json();
        const html = data?.results?.[0]?.content;

        if (typeof html !== 'string' || html.length < 100) {
            console.log(`[fetchSearchPageDelivery] asin=${asin} empty/short HTML`);
            return null;
        }

        // Global scan: check if delivery keywords appear ANYWHERE in the full HTML
        const globalDeliveryMatch = html.match(/(entrega|llega|recibe)[^<\n]{0,120}/gi);
        if (globalDeliveryMatch) {
            console.log(`[fetchSearchPageDelivery] asin=${asin} global delivery snippets: ${globalDeliveryMatch.slice(0,3).map(s=>s.trim()).join(' || ')}`);
        } else {
            console.log(`[fetchSearchPageDelivery] asin=${asin} NO delivery keywords anywhere in HTML (${html.length} chars)`);
        }

        // Find ALL occurrences of data-asin="ASIN" — iterate them all and return the
        // first card that contains a delivery date. Sponsored results for the same ASIN
        // may appear first but typically lack delivery text; the organic card has it.
        const cardMarker = `data-asin="${asin}"`;
        let searchFrom = 0;
        let found = false;
        let cardCount = 0;

        while (true) {
            const cardIdx = html.indexOf(cardMarker, searchFrom);
            if (cardIdx === -1) break;
            found = true;
            cardCount++;

            // Expand window to 8000 chars to capture more of the card
            const cardSection = html.slice(cardIdx, cardIdx + 8000);

            // Log first 600 chars of the first card for diagnostics
            if (cardCount === 1) {
                console.log(`[fetchSearchPageDelivery] asin=${asin} card#1 preview: ${cardSection.slice(0, 600).replace(/\s+/g, ' ')}`);
            }

            if (/(llega|entrega|recibe)\s+ma[ñn]ana/i.test(cardSection)) {
                console.log(`[fetchSearchPageDelivery] asin=${asin} → mañana (1 día)`);
                return 1;
            }
            if (/(llega|entrega|recibe)\s+hoy/i.test(cardSection)) {
                console.log(`[fetchSearchPageDelivery] asin=${asin} → hoy (0 días)`);
                return 0;
            }

            const dates = findAllSpanishDates(cardSection);
            if (dates.length > 0) {
                const max = Math.max(...dates);
                const snippet = [...cardSection.matchAll(/(?:entrega|llega|recibe)[^<\n]{0,120}/gi)].slice(0, 2).map(m => m[0].trim()).join(' || ');
                console.log(`[fetchSearchPageDelivery] asin=${asin} → ${max} días. snippet: ${snippet}`);
                return max;
            }

            searchFrom = cardIdx + cardMarker.length;
        }

        if (!found) {
            console.log(`[fetchSearchPageDelivery] asin=${asin} product card (data-asin) not found in search HTML (${html.length} chars)`);
        } else {
            console.log(`[fetchSearchPageDelivery] asin=${asin} ${cardCount} cards found but no delivery dates`);
        }
        return null;
    } catch (e) {
        clearTimeout(timer);
        console.log(`[fetchSearchPageDelivery] asin=${asin} error: ${e}`);
        return null;
    }
}

async function fetchAmazonAjaxDeliveryDays(asin: string, postalCode: string, auth: string): Promise<number | null> {
    // Amazon's internal delivery message AJAX endpoint — the same XHR request that the
    // product page fires to populate the delivery widget. Returns an HTML fragment with
    // the delivery promise text ("Recíbelo el martes, 3 de junio") without requiring a
    // full page render or CP widget interaction.
    const ajaxUrl = `https://www.amazon.com.mx/gp/product/ajax?asin=${asin}&deviceType=web&qty=1&experienceId=deliveryMessageDesktop`;
    console.log(`[fetchAmazonAjaxDelivery] asin=${asin} fetching internal AJAX delivery endpoint`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);

    try {
        const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": auth },
            body: JSON.stringify({
                source: "amazon",
                url: ajaxUrl,
                geo_location: postalCode,
                render: "html",
                parse: false,
                cookies: buildAmazonLocationCookies(postalCode),
                context: [{ key: "force_cookies", value: true }],
            }),
            signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
            console.log(`[fetchAmazonAjaxDelivery] asin=${asin} HTTP ${res.status}`);
            return null;
        }

        const data = await res.json();
        const html = data?.results?.[0]?.content;

        if (typeof html !== 'string' || html.length < 50) {
            console.log(`[fetchAmazonAjaxDelivery] asin=${asin} empty/short response (len=${typeof html === 'string' ? html.length : 0})`);
            return null;
        }

        console.log(`[fetchAmazonAjaxDelivery] asin=${asin} HTML[0:2000]: ${html.slice(0, 2000)}`);

        if (/(llega|entrega|recibe)\s+ma[ñn]ana/i.test(html)) return 1;
        if (/(llega|entrega|recibe)\s+hoy/i.test(html)) return 0;

        const dates = findAllSpanishDates(html);
        if (dates.length > 0) {
            const max = Math.max(...dates);
            console.log(`[fetchAmazonAjaxDelivery] asin=${asin} → ${max} días`);
            return max;
        }

        console.log(`[fetchAmazonAjaxDelivery] asin=${asin} no dates found`);
        return null;
    } catch (e) {
        clearTimeout(timer);
        console.log(`[fetchAmazonAjaxDelivery] asin=${asin} error: ${e}`);
        return null;
    }
}

async function fetchAodDeliveryDays(asin: string, postalCode: string, auth: string): Promise<number | null> {
    // Scrape the AOD (All Offers Display) endpoint that Amazon loads when the user
    // clicks "Ver opciones de compra". This is the only reliable way to get delivery
    // dates for cross-border sellers (Amazon Estados Unidos, Amazon Europa) since
    // their buy-box doesn't render directly on the product page for Oxylabs.
    const aodUrl = `https://www.amazon.com.mx/gp/aod/ajax?asin=${asin}&pc=dp`;
    console.log(`[fetchAodDeliveryDays] asin=${asin} fetching AOD with CP=${postalCode}`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);

    try {
        const res = await fetch("https://realtime.oxylabs.io/v1/queries", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": auth },
            body: JSON.stringify({
                source: "amazon",
                url: aodUrl,
                geo_location: postalCode,
                render: "html",
                parse: false,
                cookies: buildAmazonLocationCookies(postalCode),
                context: [{ key: "force_cookies", value: true }],
            }),
            signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            console.log(`[fetchAodDeliveryDays] asin=${asin} HTTP ${res.status}: ${errBody.slice(0, 300)}`);
            return null;
        }

        const data = await res.json();
        const html = data?.results?.[0]?.content;

        if (typeof html !== 'string' || html.length < 100) {
            console.log(`[fetchAodDeliveryDays] asin=${asin} empty/short HTML (length=${typeof html === 'string' ? html.length : 0})`);
            return null;
        }

        // Extract top offer section to isolate from other offers
        const topOffer = extractAodTopOffer(html);
        const searchText = topOffer ?? html;

        const snippets = [...searchText.matchAll(/(?:llega|rec[ií]b|entrega)[^<\n]{0,200}/gi)].slice(0, 5);
        console.log(`[fetchAodDeliveryDays] asin=${asin} snippets (topOffer=${topOffer !== null}): ${snippets.map(s => s[0].trim()).join(' || ')}`);

        // Handle "mañana" / "hoy" patterns in delivery text
        if (/(llega|entrega|recibe)\s+ma[ñn]ana/i.test(searchText)) return 1;
        if (/(llega|entrega|recibe)\s+hoy/i.test(searchText)) return 0;

        const dates = findAllSpanishDates(searchText);
        console.log(`[fetchAodDeliveryDays] asin=${asin} dates=${JSON.stringify(dates)}`);

        if (dates.length > 0) {
            // Use the MAX date — for date ranges like "30-31 de mayo", the
            // findAllSpanishDates returns multiple values and we want the worst case
            const max = Math.max(...dates);
            console.log(`[fetchAodDeliveryDays] asin=${asin} → ${max} días`);
            return max;
        }

        console.log(`[fetchAodDeliveryDays] asin=${asin} no dates found in AOD. HTML[0:2500]: ${html.slice(0, 2500)}`);
        return null;
    } catch (e) {
        clearTimeout(timer);
        console.log(`[fetchAodDeliveryDays] asin=${asin} error: ${e}`);
        return null;
    }
}

async function fetchAmazonShippingDays(asin: string, postalCode?: string | null): Promise<ShippingResult> {
    try {
        const oxylabsUser = Deno.env.get("OXYLABS_USERNAME");
        const oxylabsPass = Deno.env.get("OXYLABS_PASSWORD");

        if (!oxylabsUser || !oxylabsPass) {
            console.log(`[fetchAmazonShippingDays] asin=${asin} OXYLABS_USERNAME/PASSWORD not set`);
            return { days: null, available: null };
        }

        const auth = `Basic ${btoa(`${oxylabsUser}:${oxylabsPass}`)}`;

        // Use amazon_product source with parse:true.
        // Oxylabs' Amazon-specific scraper renders JavaScript and extracts structured
        // data from the product page, including the actual delivery field from the buy-box.
        // This avoids the false positives produced by "universal" source, which picks up
        // Amazon's static Prime promotional banners ("Entrega GRATIS el domingo") that
        // appear on every page regardless of actual seller delivery time.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 35000);

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
                render: "html",
                ...(postalCode ? {
                    geo_location: postalCode,
                    cookies: buildAmazonLocationCookies(postalCode),
                    context: [{ key: "force_cookies", value: true }],
                } : {}),
            }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            console.log(`[fetchAmazonShippingDays] asin=${asin} amazon_product HTTP ${res.status}`);
            return { days: null, available: null };
        }

        const data = await res.json();
        const content = data?.results?.[0]?.content;

        if (content && typeof content === 'object') {
            // Log all content keys and relevant fields for diagnosis
            console.log(`[fetchAmazonShippingDays] asin=${asin} content keys: ${JSON.stringify(Object.keys(content))}`);
            const relevant: Record<string, unknown> = {};
            for (const key of ['delivery', 'shipping', 'availability', 'price', 'buybox', 'delivery_info', 'seller']) {
                if (content[key] !== undefined) relevant[key] = content[key];
            }
            console.log(`[fetchAmazonShippingDays] asin=${asin} parsed fields: ${JSON.stringify(relevant).slice(0, 1500)}`);
            if (Array.isArray(content?.buybox)) {
                console.log(`[fetchAmazonShippingDays] asin=${asin} full buybox: ${JSON.stringify(content.buybox).slice(0, 2000)}`);
            }

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

            // Collect dates from ALL entries before deciding — for cross-border dropshipping
            // we need the MAXIMUM delivery time. Amazon may return a fast Prime option first
            // (e.g. 2 days) followed by the actual cross-border seller (e.g. 21 days).
            // Returning at the first match would silently pick the wrong entry.
            const allCollectedDays: number[] = [];
            for (const text of texts) {
                if (/(llega|entrega|recibe|env[ií]o)\s+hoy/i.test(text)) {
                    allCollectedDays.push(0);
                    continue;
                }
                if (/(llega|entrega|recibe|env[ií]o)\s+ma[ñn]ana/i.test(text)) {
                    allCollectedDays.push(1);
                    continue;
                }
                const dates = findAllSpanishDates(text);
                if (dates.length > 0) {
                    console.log(`[fetchAmazonShippingDays] asin=${asin} delivery="${text}" dates=${JSON.stringify(dates)}`);
                    allCollectedDays.push(...dates);
                    continue;
                }
                const rangeM = text.match(/(\d+)\s+a\s+(\d+)\s+d[ií]as/i);
                if (rangeM) {
                    allCollectedDays.push(Math.max(parseInt(rangeM[1]), parseInt(rangeM[2])));
                    continue;
                }
                const singleM = text.match(/en (\d+)\s+d[ií]as/i);
                if (singleM) {
                    allCollectedDays.push(parseInt(singleM[1]));
                }
            }
            if (allCollectedDays.length > 0) {
                const max = Math.max(...allCollectedDays);
                console.log(`[fetchAmazonShippingDays] asin=${asin} allDays=${JSON.stringify(allCollectedDays)} → ${max} días`);
                return { days: max, available: true };
            }

            // delivery:[] means Oxylabs' structured parser didn't extract a delivery date.
            // This happens for cross-border sellers (Amazon Estados Unidos, Amazon Europa):
            // their buy-box doesn't render directly on the product page for Oxylabs.
            // Fix: scrape the AOD (All Offers Display) endpoint — the same one that loads
            // when the user clicks "Ver opciones de compra". The top offer in AOD always
            // has the delivery promise text ("Entrega GRATIS el martes, 16 de junio").
            if (Array.isArray(content?.delivery) && content.delivery.length === 0) {
                const sellerName: string = content?.buybox?.[0]?.seller_name ?? '';
                console.log(`[fetchAmazonShippingDays] asin=${asin} delivery=[] seller="${sellerName}", trying fallbacks`);
                if (postalCode) {
                    // 1st: Scrape.do — residential IP + JS render, sees dates like a real browser
                    const scrapedoDays = await fetchScrapedoDeliveryDays(asin);
                    if (scrapedoDays !== null) return { days: scrapedoDays, available: true };
                    // 2nd–5th: Oxylabs fallbacks (kept as backup)
                    const searchDays = await fetchSearchPageDeliveryDays(asin, postalCode, auth);
                    if (searchDays !== null) return { days: searchDays, available: true };
                    const pageDays = await fetchDirectProductPageDays(asin, postalCode, auth);
                    if (pageDays !== null) return { days: pageDays, available: true };
                    const ajaxDays = await fetchAmazonAjaxDeliveryDays(asin, postalCode, auth);
                    if (ajaxDays !== null) return { days: ajaxDays, available: true };
                    const aodDays = await fetchAodDeliveryDays(asin, postalCode, auth);
                    if (aodDays !== null) return { days: aodDays, available: true };
                    // All fallbacks exhausted — if Oxylabs also shows no buybox/price, the
                    // product is genuinely not available on Amazon.com.mx (suppressed ASIN).
                    const hasBuyBox = Array.isArray(content?.buybox) && content.buybox.length > 0;
                    const hasPrice = content?.price !== null && content?.price !== undefined;
                    if (!hasBuyBox && !hasPrice) {
                        console.log(`[fetchAmazonShippingDays] asin=${asin} unavailable — no buybox, no price, all fallbacks failed`);
                        return { days: null, available: false };
                    }
                } else {
                    console.log(`[fetchAmazonShippingDays] asin=${asin} no postal code — cannot fetch delivery pages`);
                }
            }

            console.log(`[fetchAmazonShippingDays] asin=${asin} parsed content: no delivery date in known fields`);
            return { days: null, available: null };

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
                return { days: max, available: true };
            }
            console.log(`[fetchAmazonShippingDays] asin=${asin} HTML: no specific dates found`);
            return { days: null, available: null };
        }

        console.log(`[fetchAmazonShippingDays] asin=${asin} empty/null content from Oxylabs`);
        return { days: null, available: null };

    } catch (e) {
        console.error(`[fetchAmazonShippingDays] asin=${asin}:`, e);
        return { days: null, available: null };
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
                .select("id, meli_id, sku, price_mxn, stock_meli, status, currency, description_text, shipping_days, shipping_days_updated_at")
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
                // True only when Amazon's API explicitly confirmed the product doesn't exist (404/400).
                // Error responses (network failures, auth errors) return amazonStock:null — excluded here
                // to avoid incorrectly pausing products when the SP-API is temporarily unavailable.
                const isUnavailableOnAmazon = offers !== undefined
                    && offers.price === null
                    && offers.sellerCount === 0
                    && offers.amazonStock === 0;

                // Shipping days: scrape Amazon.com.mx for actual delivery time, cache 7 days
                let cachedShippingDays = (product as any).shipping_days ?? null;
                const updatedAt = (product as any).shipping_days_updated_at;
                const isStale = !updatedAt || (Date.now() - new Date(updatedAt).getTime()) > 7 * 24 * 60 * 60 * 1000;

                let scrapedAvailable: boolean | null = null;
                if (cachedShippingDays === null || isStale) {
                    const scrapeResult = await fetchAmazonShippingDays(sku, settings.postal_code ?? null);
                    scrapedAvailable = scrapeResult.available;
                    const scrapedDays = scrapeResult.days;
                    if (scrapedDays !== null) {
                        cachedShippingDays = scrapedDays;
                        await supabase.from("products").update({
                            shipping_days: scrapedDays,
                            shipping_days_updated_at: new Date().toISOString()
                        }).eq("id", productId);
                    } else if ((product as any).shipping_days !== null) {
                        // Scrape failed but we have a previous value (possibly manually set)
                        // — preserve it instead of overwriting with the generic fallback.
                        // Refresh timestamp so we don't re-scrape on every run.
                        cachedShippingDays = (product as any).shipping_days;
                        await supabase.from("products").update({
                            shipping_days_updated_at: new Date().toISOString()
                        }).eq("id", productId);
                        console.log(`[amazon-ml-updater] ${sku} scrape failed, preserving cached value: ${cachedShippingDays}`);
                    } else {
                        // No previous value and scrape failed — use configured default
                        const fallback = currency === 'MXN'
                            ? (settings.amazon_delivery_mx ?? null)
                            : (settings.amazon_delivery_usa ?? null);
                        cachedShippingDays = fallback;
                        if (fallback !== null) {
                            await supabase.from("products").update({
                                shipping_days: fallback,
                                shipping_days_updated_at: new Date().toISOString()
                            }).eq("id", productId);
                        }
                        console.log(`[amazon-ml-updater] ${sku} scraping failed, fallback: ${fallback}`);
                    }
                }

                const currentStatus = (product as any).status ?? 'active';
                const scrapedUnavailable = scrapedAvailable === false;
                if (amazonStock === 0 || isUnavailableOnAmazon || scrapedUnavailable) {
                    updatePayload.status = "paused";
                    const pauseReason = scrapedUnavailable
                        ? 'Oxylabs confirms product unavailable on Amazon.com.mx'
                        : isUnavailableOnAmazon ? 'product unavailable on Amazon (SP-API 404/400)'
                        : 'Amazon stock = 0';
                    console.log(`[amazon-ml-updater] meliId=${meliId} pausing — ${pauseReason}`);
                } else if (currentStatus === 'paused' && offers !== undefined && !isUnavailableOnAmazon && !scrapedUnavailable) {
                    // ML rejects status:"active" combined with price/stock in the same payload.
                    // Send reactivation as a standalone PUT, then let the main update handle price/stock.
                    console.log(`[amazon-ml-updater] meliId=${meliId} reactivating — Amazon product available again`);
                    const reactivateResult = await updateMeliItem(meliId, { status: "active" }, mlToken);
                    if (reactivateResult.ok) {
                        await supabase.from("products").update({ status: "active" }).eq("meli_id", meliId);
                        console.log(`[amazon-ml-updater] meliId=${meliId} reactivation succeeded`);
                    } else {
                        // ML may block reactivation for quality/health reasons — do not hard-fail
                        console.log(`[amazon-ml-updater] meliId=${meliId} ML blocked reactivation (continuing): ${reactivateResult.error}`);
                    }
                    // Do NOT put status in updatePayload — reactivation already handled above
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

                if (syncParams.stock && amazonStock !== 0 && !isUnavailableOnAmazon && !scrapedUnavailable) {
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
