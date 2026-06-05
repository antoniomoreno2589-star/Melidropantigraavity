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
    hasBuyBox?: boolean | null; // false = Scrape.do confirmed no buybox; null = not checked
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
        if (idx !== -1) return html.slice(idx, idx + 3000);
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

interface ScrapedoProductResult {
    hasBuyBox: boolean | null; // null = could not determine
    days: number | null;
    available: boolean | null;
}

async function fetchScrapedoProductData(asin: string, postalCode?: string | null): Promise<ScrapedoProductResult> {
    const token = Deno.env.get("SCRAPEDO_TOKEN");
    if (!token) {
        console.log(`[fetchScrapedoProduct] asin=${asin} SCRAPEDO_TOKEN not set`);
        return { hasBuyBox: null, days: null, available: null };
    }

    // Use the Amazon plugin endpoint (/plugin/amazon/) which has a ZIP-keyed cookie pool
    // that locks delivery location to the specified postal code. The generic endpoint
    // (api.scrape.do/) uses the rotator IP and shows delivery dates for a random MX city.
    const targetUrl = `https://www.amazon.com.mx/dp/${asin}`;
    const params = new URLSearchParams({ token, url: targetUrl, geocode: 'mx', super: 'true' });
    if (postalCode) params.set('zipcode', postalCode);
    const apiUrl = `https://api.scrape.do/plugin/amazon/?${params.toString()}`;
    console.log(`[fetchScrapedoProduct] asin=${asin} CP=${postalCode ?? 'none'} fetching via Amazon plugin endpoint`);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);

    try {
        const res = await fetch(apiUrl, { signal: ctrl.signal });
        clearTimeout(timer);

        if (!res.ok) {
            console.log(`[fetchScrapedoProduct] asin=${asin} HTTP ${res.status}`);
            return { hasBuyBox: null, days: null, available: null };
        }

        const html = await res.text();
        if (!html || html.length < 100) {
            console.log(`[fetchScrapedoProduct] asin=${asin} empty/short HTML`);
            return { hasBuyBox: null, days: null, available: null };
        }

        // CAPTCHA / robot-check page detection — bail out early, don't save wrong data
        if (/Type the characters you see|robot check|captcha|automated access/i.test(html)) {
            console.log(`[fetchScrapedoProduct] asin=${asin} CAPTCHA/robot-check page detected, skipping`);
            return { hasBuyBox: null, days: null, available: null };
        }

        // Log raw HTML around buy box area for diagnosis when signals are ambiguous
        const buyAreaSnippet = (() => {
            for (const marker of ['buybox', 'add-to-cart', 'buying-choices', 'buy-now', 'actionPanel', 'desktop_buybox']) {
                const idx = html.indexOf(marker);
                if (idx !== -1) return html.slice(Math.max(0, idx - 100), idx + 400).replace(/\s+/g, ' ');
            }
            return html.slice(0, 500).replace(/\s+/g, ' ');
        })();
        console.log(`[fetchScrapedoProduct] asin=${asin} htmlLen=${html.length} buyArea: ${buyAreaSnippet}`);

        // Buybox detection:
        // No buybox   → "Ver opciones de compra" / see-all-buying-choices CTA is shown
        // Has buybox  → "Añadir al carrito" / add-to-cart button is the main CTA
        //
        // IMPORTANT: Amazon includes id="add-to-cart-button" in the DOM even when
        // no seller has the buybox (hidden/disabled state). So the NO-BUYBOX signal
        // always takes priority over the add-to-cart signal.
        const hasNoBuyBoxButton = html.includes('id="see-all-buying-choices"') ||
                                   html.includes('id="see-all-buying-choices-button"') ||
                                   /ver\s+(todas\s+las\s+)?opciones\s+de\s+compra/i.test(html);
        const hasBuyBoxButton  = html.includes('id="add-to-cart-button"') || html.includes('name="submit.add-to-cart"');

        let hasBuyBox: boolean | null = null;
        if (hasNoBuyBoxButton) {
            // No-buybox signal is authoritative — add-to-cart may be present but hidden
            hasBuyBox = false;
        } else if (hasBuyBoxButton) {
            hasBuyBox = true;
        }
        // else: neither signal → null (page may not have loaded properly)

        console.log(`[fetchScrapedoProduct] asin=${asin} noBuyBoxBtn=${hasNoBuyBoxButton} hasBuyBoxBtn=${hasBuyBoxButton} → hasBuyBox=${hasBuyBox}`);

        if (hasBuyBox === false) {
            return { hasBuyBox: false, days: null, available: true };
        }

        // Extract delivery days when buybox is present (or ambiguous)
        const globalMatch = html.match(/(entrega|llega|recibe)[^<\n]{0,150}/gi);
        if (globalMatch) {
            console.log(`[fetchScrapedoProduct] asin=${asin} snippets: ${globalMatch.slice(0, 3).map((s: string) => s.trim()).join(' || ')}`);
        }

        const deliverySection = extractDeliverySection(html);
        const searchText = deliverySection ?? html;

        if (/(llega|entrega|recibe)\s+ma[ñn]ana/i.test(searchText)) {
            console.log(`[fetchScrapedoProduct] asin=${asin} → mañana (1 día)`);
            return { hasBuyBox, days: 1, available: true };
        }
        if (/(llega|entrega|recibe)\s+hoy/i.test(searchText)) {
            console.log(`[fetchScrapedoProduct] asin=${asin} → hoy (0 días)`);
            return { hasBuyBox, days: 0, available: true };
        }

        const dates = findAllSpanishDates(searchText);
        if (dates.length > 0) {
            const max = Math.max(...dates);
            const deliverySnippet = [...searchText.matchAll(/(?:entrega|llega|recibe)[^<\n]{0,120}/gi)].slice(0, 5).map(m => m[0].trim()).join(' || ');
            console.log(`[fetchScrapedoProduct] asin=${asin} hasBuyBox=${hasBuyBox} allDates=${JSON.stringify(dates)} → max=${max} días. delivery text: ${deliverySnippet}`);
            return { hasBuyBox, days: max, available: true };
        }

        const searchSnippet = searchText.slice(0, 600).replace(/\s+/g, ' ');
        console.log(`[fetchScrapedoProduct] asin=${asin} hasBuyBox=${hasBuyBox} but no dates found. searchText start: ${searchSnippet}`);
        return { hasBuyBox, days: null, available: hasBuyBox !== null ? true : null };
    } catch (e) {
        clearTimeout(timer);
        console.log(`[fetchScrapedoProduct] asin=${asin} error: ${e}`);
        return { hasBuyBox: null, days: null, available: null };
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

async function fetchAmazonShippingDays(asin: string, postalCode?: string | null, soldByAmazon?: boolean | null): Promise<ShippingResult> {
    try {
        // Scrape.do (residential IP + JS render) is the primary source for ALL products.
        // Oxylabs datacenter IPs cannot properly resolve postal code for import/cross-border
        // products, so Amazon never shows delivery times to them — regardless of who the seller is.
        console.log(`[fetchAmazonShippingDays] asin=${asin} soldByAmazon=${soldByAmazon} → Scrape.do primary`);
        const scrapedoResult = await fetchScrapedoProductData(asin, postalCode);

        if (scrapedoResult.hasBuyBox === false) {
            console.log(`[fetchAmazonShippingDays] asin=${asin} no buybox → listing will be paused`);
            return { days: null, available: true, hasBuyBox: false };
        }

        if (scrapedoResult.days !== null) {
            console.log(`[fetchAmazonShippingDays] asin=${asin} hasBuyBox=${scrapedoResult.hasBuyBox} → ${scrapedoResult.days} días`);
            return { days: scrapedoResult.days, available: true, hasBuyBox: scrapedoResult.hasBuyBox ?? null };
        }

        // Scrape.do loaded the page but found no delivery dates — try AOD as fallback.
        // The AOD endpoint (/gp/aod/ajax) sometimes exposes dates not visible on the main page.
        const oxylabsUser = Deno.env.get("OXYLABS_USERNAME");
        const oxylabsPass = Deno.env.get("OXYLABS_PASSWORD");
        const auth = (oxylabsUser && oxylabsPass) ? `Basic ${btoa(`${oxylabsUser}:${oxylabsPass}`)}` : null;

        if (postalCode && auth) {
            const aodDays = await fetchAodDeliveryDays(asin, postalCode, auth);
            if (aodDays !== null) {
                console.log(`[fetchAmazonShippingDays] asin=${asin} AOD fallback → ${aodDays} días`);
                return { days: aodDays, available: true };
            }
        }


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
                .select("id, meli_id, sku, price_mxn, stock_meli, status, currency, description_text, shipping_days, shipping_days_updated_at, pause_reason")
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
            // The Amazon plugin endpoint has a concurrency limit of 1 request per token.
            // Process sequentially to avoid 429 errors. 3 × ~30 s = ~90 s, leaving budget
            // for offers API + ML updates within the 150 s function limit.
            const MAX_SCRAPES_PER_RUN = 3;

            const STALE_MS = 7 * 24 * 60 * 60 * 1000;
            const staleForScraping = (products as any[]).filter(p => {
                const ua = p.shipping_days_updated_at;
                return p.shipping_days === null || !ua || (Date.now() - new Date(ua).getTime()) > STALE_MS;
            }).slice(0, MAX_SCRAPES_PER_RUN);

            const scrapeResultMap = new Map<string, ShippingResult>();

            if (staleForScraping.length > 0) {
                console.log(`[amazon-ml-updater] Sequential-scraping ${staleForScraping.length} stale products (plugin concurrency limit: 1)`);
                for (const p of staleForScraping) {
                    try {
                        const soldByAmazon = asinOffers[p.sku]?.soldByAmazon ?? null;
                        const result = await fetchAmazonShippingDays(p.sku, settings.postal_code ?? null, soldByAmazon);
                        scrapeResultMap.set(p.sku, result);
                        const noBuyBox = result.hasBuyBox === false;
                        const currency = p.currency ?? 'USD';
                        if (noBuyBox) {
                            await supabase.from("products").update({ shipping_days_updated_at: new Date().toISOString() }).eq("id", p.id);
                            console.log(`[amazon-ml-updater] ${p.sku} no buybox — pausing`);
                        } else if (result.days !== null) {
                            await supabase.from("products").update({ shipping_days: result.days, shipping_days_updated_at: new Date().toISOString() }).eq("id", p.id);
                        } else if (p.shipping_days !== null) {
                            await supabase.from("products").update({ shipping_days_updated_at: new Date().toISOString() }).eq("id", p.id);
                            console.log(`[amazon-ml-updater] ${p.sku} scrape failed, preserving cached: ${p.shipping_days}`);
                        } else {
                            const fallback = currency === 'MXN' ? (settings.amazon_delivery_mx ?? null) : (settings.amazon_delivery_usa ?? null);
                            if (fallback !== null) {
                                await supabase.from("products").update({ shipping_days: fallback, shipping_days_updated_at: new Date().toISOString() }).eq("id", p.id);
                            }
                            console.log(`[amazon-ml-updater] ${p.sku} scraping failed, fallback: ${fallback}`);
                        }
                    } catch (scrapeErr) {
                        console.error(`[amazon-ml-updater] scrape error for ${p.sku}:`, scrapeErr);
                    }
                }
            }

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
                const isUnavailableOnAmazon = offers !== undefined
                    && offers.price === null
                    && offers.sellerCount === 0
                    && offers.amazonStock === 0;

                const existingPauseReason = (product as any).pause_reason ?? null;
                let cachedShippingDays = (product as any).shipping_days ?? null;
                let scrapedAvailable: boolean | null = null;
                let noBuyBox = false;
                let pauseReasonToWrite: string | null | undefined = undefined;

                const scrapeResult = scrapeResultMap.get(sku) ?? null;
                if (scrapeResult !== null) {
                    debug.scrapeResult = scrapeResult;
                    scrapedAvailable = scrapeResult.available;
                    noBuyBox = scrapeResult.hasBuyBox === false;
                    pauseReasonToWrite = noBuyBox ? 'sin_buybox' : null;
                    if (!noBuyBox && scrapeResult.days !== null) {
                        cachedShippingDays = scrapeResult.days;
                    }
                } else {
                    noBuyBox = (existingPauseReason === 'sin_buybox');
                }

                const currentStatus = (product as any).status ?? 'active';
                const scrapedUnavailable = scrapedAvailable === false;
                if (amazonStock === 0 || isUnavailableOnAmazon || scrapedUnavailable || noBuyBox) {
                    updatePayload.status = "paused";
                    const pauseMsg = noBuyBox ? 'no buybox (Scrape.do)'
                        : scrapedUnavailable ? 'Oxylabs confirms product unavailable on Amazon.com.mx'
                        : isUnavailableOnAmazon ? 'product unavailable on Amazon (SP-API 404/400)'
                        : 'Amazon stock = 0';
                    console.log(`[amazon-ml-updater] meliId=${meliId} pausing — ${pauseMsg}`);
                } else if (currentStatus === 'paused' && offers !== undefined && !isUnavailableOnAmazon && !scrapedUnavailable && !noBuyBox) {
                    // ML rejects status:"active" combined with price/stock in the same payload.
                    // Send reactivation as a standalone PUT, then let the main update handle price/stock.
                    console.log(`[amazon-ml-updater] meliId=${meliId} reactivating — Amazon product available again`);
                    const reactivateResult = await updateMeliItem(meliId, { status: "active" }, mlToken);
                    if (reactivateResult.ok) {
                        await supabase.from("products").update({ status: "active", pause_reason: null }).eq("meli_id", meliId);
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
                if (sellerCount !== null)          metaUpdate.amazon_seller_count = sellerCount;
                if (soldByAmazon !== null)         metaUpdate.sold_by_amazon      = soldByAmazon;
                if (pauseReasonToWrite !== undefined) metaUpdate.pause_reason     = pauseReasonToWrite;
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
