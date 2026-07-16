import { useState, useEffect } from 'react';
import { amazonService } from '../../services/amazonService';
import { aiImporterService, ProcessedProduct } from '../../services/aiImporterService';
import { meliService } from '../../services/meliService';
import { api } from '../../services/api';
import { supabase } from '../../services/supabase';
import { Step, Marketplace, ListingType, LoadedProduct } from './types';

// Sanitizes a raw attribute value against ML's own attribute definition (value_type +
// allowed_units + default_unit, from /categories/{id}/attributes). Shared by
// buildItemPayload (to build the actual publish payload) and getBlockingIssues (to
// warn in Step4 before the user even attempts to publish) so both agree on what
// counts as "valid" for a given attribute.
// Returns null when a number/number_unit attribute has no parseable number at all
// (e.g. the AI extracted "Agua tibia" for a wash-temperature attribute) — sending
// that as-is is a guaranteed ML rejection.
function sanitizeAttributeValue(def: any, rawValue: string): string | null {
    // Fixed-choice attributes (ML returns a `values` list) — the payload must
    // match one of ML's own option strings exactly, or ML rejects it with
    // "not valid, item values [(null:<what we sent>)]" (it tried to resolve
    // our text to one of its value_ids and got nothing). Confirmed live: the
    // AI mapped RECOMMENDED_AGE_GROUP to "12-24 meses", which doesn't exist —
    // the category's real 9 options are "6-12 meses"/"12-18 meses"/"18-24
    // meses"/"0-24 meses"/etc. Snap to the exact match (case/whitespace
    // insensitive) or drop it — an unmatched string is a guaranteed
    // rejection either way, and dropping surfaces it as a normal "missing
    // required attribute" in Step4 (whose dropdown shows the real options)
    // instead of a publish-time failure.
    if (Array.isArray(def?.values) && def.values.length > 0) {
        // catalog_required attributes (BRAND is the common case) are the exception —
        // confirmed live against MLM146240: BRAND's `values` here is only 3 entries
        // (Agratto, Consul, Midea), which is nowhere near the real catalog of brands.
        // ML's own hint text confirms free text is the intended input ("Escribe la
        // marca real del producto o 'Genérica' si no tiene marca"), so snapping to
        // an exact match against this short sample would reject the vast majority
        // of real, valid brand names — pass it through as typed instead.
        if (def.tags?.catalog_required) {
            return rawValue;
        }
        const norm = (s: string) => s.trim().toLowerCase();
        const match = def.values.find((v: any) => norm(v.name) === norm(rawValue));
        return match ? match.name : null;
    }

    const valueType = def?.value_type;
    if (valueType !== 'number_unit' && valueType !== 'number') return rawValue;

    // First number in the value — handles plain numbers ("40"), numbers with a
    // unit already attached ("40 cm"), and ranges the AI sometimes returns
    // ("40-45 cm", which ML rejects outright) by taking the first.
    const numMatch = rawValue.match(/\d+(?:\.\d+)?/);
    if (!numMatch) return null;
    const num = numMatch[0];
    if (valueType === 'number') return num;

    const allowedUnits: Array<{ id: string; name: string }> = def.allowed_units || [];
    if (allowedUnits.length === 0) return num;

    const trailingText = rawValue.slice(numMatch.index! + num.length).trim().toLowerCase();
    const matchedUnit = allowedUnits.find(u =>
        u.name.toLowerCase() === trailingText || u.id.toLowerCase() === trailingText
    );
    const fallbackUnit = allowedUnits.find(u => u.id === def.default_unit) || allowedUnits[0];
    const unit = (matchedUnit || fallbackUnit)?.name;
    return unit ? `${num} ${unit}` : num;
}

// Finds which of a category's real attributes actually carries the product's
// barcode — categories vary (some use GTIN, some EAN/UPC, some none at all;
// confirmed live that MLM189211's ONLY code attribute is GTIN, no UPC exists
// there at all). Sending the barcode under an id the category doesn't have
// does nothing — ML silently ignores it and still reports the real one
// missing. GTIN is checked first since it's the most common in practice.
const CODE_ATTR_PRIORITY = ['GTIN', 'EAN', 'UPC', 'ITEM_BARCODE', 'UNIVERSAL_CODE'];
export function resolveBarcodeAttributeId(categoryAttrs: any[]): string | null {
    for (const id of CODE_ATTR_PRIORITY) {
        if (categoryAttrs.some((a: any) => a.id === id)) return id;
    }
    const loose = categoryAttrs.find((a: any) => a.id.includes('CODE') || a.id.includes('BARCODE'));
    return loose?.id ?? null;
}

// BRAND/MARCA is required + catalog_required on essentially every ML category, so
// it must always resolve to something before publish — it can't be left blank for
// the user to notice and fill in. Amazon's own brand data wins when it's real;
// when it's missing/junk, "Genérica" is ML's own documented convention for "no
// real brand" (straight from the attribute's hint text: "Escribe la marca real
// del producto o 'Genérica' si no tiene marca"). Deliberately not left to the AI
// to guess from a possibly brand-less title — see the exclusion where this is used.
function seedBrand(relevant: any[], productBrand: string | undefined): { id: string; value: string } | null {
    const brandAttr = relevant.find((a: any) => a.id === 'BRAND' || a.id === 'MARCA');
    if (!brandAttr) return null;
    const hasRealBrand = !!productBrand && !['unknown', 'n/a', ''].includes(productBrand.toLowerCase());
    return { id: brandAttr.id, value: hasRealBrand ? productBrand! : 'Genérica' };
}

// Same "is this actually required" check getBlockingIssues uses — kept in
// sync so an attribute Step 4 flags as missing is always one it also renders
// a field for. conditional_required matters in practice: e.g. GTIN_ABSENCE_REASON
// (the "motivo" ML demands when a product has no GTIN) carries only this tag.
function isRequiredAttr(a: any): boolean {
    return !!(a.tags?.required || a.tags?.new_required || a.tags?.conditional_required);
}

// ML's category attribute lists can run well past what's comfortable to show
// at once, so both the fetch and the Step 4 form cap how many render. Sorting
// required attributes first before either cap applies means a required field
// can never be silently cut off while still being demanded by getBlockingIssues.
function pickRelevantAttributes(attrs: any[], limit: number): any[] {
    return attrs
        .filter((a: any) => isRequiredAttr(a) || (!a.tags?.read_only && a.relevance >= 1))
        .sort((a: any, b: any) => Number(isRequiredAttr(b)) - Number(isRequiredAttr(a)))
        .slice(0, limit);
}

export function useAmazonImporter() {
    // ── Step navigation ────────────────────────────────────────────────
    const [step, setStep] = useState<Step>(1);

    // ── Step 1: Config ─────────────────────────────────────────────────
    const [marketplace, setMarketplace] = useState<Marketplace>('MLM');
    const [listingType, setListingType] = useState<ListingType>('gold_special');
    const [autoCategory, setAutoCategory] = useState(true);
    const [cleanImages, setCleanImages] = useState(false);

    // ── Step 2: Load Products ──────────────────────────────────────────
    const [asinInput, setAsinInput] = useState('');
    const [loadedProducts, setLoadedProducts] = useState<LoadedProduct[]>([]);
    const [loadingAsins, setLoadingAsins] = useState(false);

    // ── Step 3: AI Processing ──────────────────────────────────────────
    const [processedProducts, setProcessedProducts] = useState<ProcessedProduct[]>([]);
    const [editedTitles, setEditedTitles] = useState<Record<string, string>>({});
    const [selectedCategories, setSelectedCategories] = useState<Record<string, { id: string; name: string }>>({});
    const [mlCategorySearchResults, setMlCategorySearchResults] = useState<Record<string, any[]>>({});
    const [processingStage, setProcessingStage] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    // Tracks completed/total across the two long-running per-product loops
    // (AI processing, then attribute/duplicate validation) so Step 3 can show
    // a live "X de Y" count instead of a spinner with no sense of progress.
    const [processingProgress, setProcessingProgress] = useState<{ current: number; total: number } | null>(null);
    // Wall-clock timing for the current/last run of any of the long-running
    // loops (ASIN load, AI processing, attribute validation), so the UI can
    // show a live ticking timer plus "última corrida: Xm Ys" afterward.
    const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(null);
    const [lastRunDurationMs, setLastRunDurationMs] = useState<number | null>(null);

    // ── Step 4: Attributes & Validation ───────────────────────────────
    const [categoryAttributes, setCategoryAttributes] = useState<Record<string, any[]>>({});
    const [userAttributes, setUserAttributes] = useState<Record<string, Record<string, string>>>({});
    const [validationResults, setValidationResults] = useState<Record<string, {
        isDuplicate: boolean;
        duplicateId?: string;
        hasForbiddenWords: boolean;
        forbiddenWord?: string;
        isSkipped?: boolean;
    }>>({});

    // ── Step 5: Publish ────────────────────────────────────────────────
    const [publishingStatus, setPublishingStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});
    const [publishResults, setPublishResults] = useState<Record<string, any>>({});
    const [dryRunResults, setDryRunResults] = useState<Record<string, any>>({});
    const [testUserCreds, setTestUserCreds] = useState<any>(null);

    useEffect(() => {
        const fetchTestUser = async () => {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;
            const { data } = await supabase
                .from('user_connections')
                .select('meli_test_user')
                .eq('user_id', user.id)
                .limit(1)
                .maybeSingle();
            if (data?.meli_test_user) setTestUserCreds(data.meli_test_user);
        };
        fetchTestUser();
    }, []);

    // ── Step 2 handler ─────────────────────────────────────────────────
    const handleLoadAsins = async () => {
        const asins = asinInput
            .split(/[\n,\s]+/)
            .map(a => a.trim().toUpperCase())
            .filter(a => /^[A-Z0-9]{10}$/.test(a));
        if (asins.length === 0) return;

        setLoadingAsins(true);
        const initial: LoadedProduct[] = asins.map(asin => ({
            asin, title: '', description: '', brand: '', price: 0, currency: 'USD',
            imageUrl: '', images: [], category: '', attributes: {}, loading: true, error: null
        }));
        setLoadedProducts(initial);
        setProcessingProgress({ current: 0, total: asins.length });
        setProcessingStartedAt(Date.now());

        // Amazon's SP-API has real rate limits — firing every ASIN at once (a bare
        // Promise.all, no cap) got most of a large batch (300+) throttled. Worse,
        // Promise.all rejects the WHOLE batch the instant any single ASIN fails,
        // and the old catch handler then marked every product with that one
        // error — so even ASINs that would have succeeded showed as failed just
        // because one other ASIN in the batch had a problem.
        //
        // A small worker pool keeps a bounded number of requests in flight and
        // gives each ASIN its own try/catch, so one failure can't poison the
        // rest — plus a short retry for the transient rate-limit rejections a
        // large batch will still sometimes hit even at this concurrency.
        const CONCURRENCY = 5;
        const results: any[] = new Array(asins.length);
        let nextIndex = 0;
        let completed = 0;

        const fetchOneWithRetry = async (asin: string): Promise<any> => {
            // 3 attempts capped at ~2.4s total wasn't enough room for a real rate-limit
            // window to clear (confirmed live: amazon-proxy was re-fetching Amazon's LWA
            // token on every call, tripping Amazon's login rate limit under a batch's
            // concurrency — now fixed server-side with token caching, but a genuinely
            // busy moment can still throttle a request, so retries get more time to
            // actually recover instead of exhausting themselves within a couple seconds).
            const MAX_ATTEMPTS = 4;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    return await amazonService.getProduct(asin);
                } catch (e: any) {
                    if (attempt === MAX_ATTEMPTS) throw e;
                    await new Promise(r => setTimeout(r, 1200 * attempt));
                }
            }
        };

        const worker = async () => {
            while (nextIndex < asins.length) {
                const i = nextIndex++;
                const asin = asins[i];
                try {
                    results[i] = { ...(await fetchOneWithRetry(asin)), asin };
                } catch (e: any) {
                    console.error(`[Melidrop] Failed to load ${asin} after retries:`, e.message);
                    results[i] = {
                        asin, title: '', description: '', brand: '', price: 0, currency: 'USD',
                        imageUrl: '', images: [], category: '', attributes: {}, _failed: true, _error: e.message,
                    };
                }
                completed++;
                setProcessingProgress(prev => prev ? { ...prev, current: completed } : prev);
            }
        };

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, asins.length) }, () => worker()));

        setLoadedProducts(results.map(product => ({
            asin: product.asin,
            title: product.title,
            description: product.description,
            brand: product.brand || '',
            price: product.price,
            currency: product.currency,
            imageUrl: product.imageUrl,
            images: product.images || (product.imageUrl ? [product.imageUrl] : []),
            category: product.category || '',
            attributes: product.attributes || {},
            loading: false,
            error: product._failed ? product._error : null
        })));
        setLoadingAsins(false);
        setProcessingProgress(null);
        setProcessingStartedAt(prev => {
            if (prev) setLastRunDurationMs(Date.now() - prev);
            return null;
        });
    };

    // Re-fetches just the price for one ASIN from Amazon and updates it in place.
    // Amazon's pricing API reflects live stock/offers — a single-seller item can
    // briefly show no active offer and come right back, so "sin precio" from the
    // original Step 2 load doesn't always mean the product can't be priced right
    // now. Only touches price/currency; title/images/category stay as reviewed.
    const refetchProductPrice = async (asin: string): Promise<void> => {
        try {
            const product = await amazonService.getProduct(asin);
            setLoadedProducts(prev => prev.map(p =>
                p.asin === asin ? { ...p, price: product.price, currency: product.currency } : p
            ));
        } catch (e: any) {
            console.error(`[Melidrop] refetchProductPrice failed for ${asin}:`, e.message);
        }
    };

    // Drops one ASIN from the whole batch — the escape hatch for a product
    // that can't be fixed in place (e.g. no category found, no valid price)
    // so it stops blocking the rest of the batch from continuing past Step 4.
    // Purely in-memory: nothing has been published yet, so this is just
    // "never mind this one" — re-importing it later is always an option.
    const removeProduct = (asin: string) => {
        setLoadedProducts(prev => prev.filter(p => p.asin !== asin));
        setProcessedProducts(prev => prev.filter(p => p.asin !== asin));
        const dropKey = <T,>(rec: Record<string, T>): Record<string, T> => {
            const { [asin]: _drop, ...rest } = rec;
            return rest;
        };
        setEditedTitles(dropKey);
        setSelectedCategories(dropKey);
        setMlCategorySearchResults(dropKey);
        setCategoryAttributes(dropKey);
        setUserAttributes(dropKey);
        setValidationResults(dropKey);
        setPublishingStatus(dropKey);
        setPublishResults(dropKey);
        setDryRunResults(dropKey);
    };

    // ── Step 3 handler ─────────────────────────────────────────────────
    const handleProcessWithAI = async () => {
        const validProducts = loadedProducts.filter(p => !p.loading && !p.error);
        if (validProducts.length === 0) return;

        setIsProcessing(true);
        setProcessingStage(`Procesando ${validProducts.length} productos...`);
        setProcessingProgress({ current: 0, total: validProducts.length });
        setProcessingStartedAt(Date.now());

        // Same fix as Step 2's ASIN loader: a bare Promise.all fired every
        // product's AI call (Claude) + ML category prediction simultaneously,
        // with no concurrency cap and no per-item isolation — one product
        // failing aborted AI processing for the ENTIRE batch, and at scale this
        // would hammer Claude/ML's rate limits the same way Amazon's got
        // hammered in Step 2. Bounded worker pool + per-item retry instead.
        const CONCURRENCY = 5;
        const results: Array<{ processed: any; mlPredictions: any } | null> = new Array(validProducts.length).fill(null);
        let nextIndex = 0;
        let completed = 0;

        const processOneWithRetry = async (product: LoadedProduct): Promise<{ processed: any; mlPredictions: any } | null> => {
            const MAX_ATTEMPTS = 3;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    const processed = await aiImporterService.processProduct(product, marketplace, [], cleanImages);
                    const mlPredictions = await meliService.predictCategory(
                        processed.categorySuggestion.search_term, marketplace
                    );

                    // Deduplicate images by Amazon image ID (between /images/I/ and first .)
                    const seenImageIds = new Set<string>();
                    const uniqueImages: typeof processed.images = [];
                    for (const img of processed.images) {
                        const idMatch = img.url.match(/\/images\/I\/([^.]+)\./);
                        const imageId = idMatch ? idMatch[1] : null;
                        const dedupeKey = imageId || img.url;
                        if (!seenImageIds.has(dedupeKey)) {
                            seenImageIds.add(dedupeKey);
                            uniqueImages.push(img);
                        }
                    }
                    processed.images = uniqueImages.slice(0, 10);

                    return { processed, mlPredictions };
                } catch (e: any) {
                    if (attempt === MAX_ATTEMPTS) {
                        console.error(`[Melidrop] AI processing failed for ${product.asin} after ${MAX_ATTEMPTS} attempts:`, e.message);
                        return null;
                    }
                    await new Promise(r => setTimeout(r, 800 * attempt));
                }
            }
            return null;
        };

        const worker = async () => {
            while (nextIndex < validProducts.length) {
                const i = nextIndex++;
                results[i] = await processOneWithRetry(validProducts[i]);
                completed++;
                setProcessingProgress(prev => prev ? { ...prev, current: completed } : prev);
            }
        };

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, validProducts.length) }, () => worker()));

        const processedWithCategories = results.filter((r): r is { processed: any; mlPredictions: any } => r !== null);
        const failedCount = validProducts.length - processedWithCategories.length;
        if (failedCount > 0) {
            console.warn(`[Melidrop] ${failedCount} de ${validProducts.length} productos no se pudieron procesar con IA — revisa la consola para el detalle. Puedes volver al Paso 2 y reintentar.`);
        }

        // Update state in batch
        const mlCategoryMap: Record<string, any[]> = {};
        const selectedCategoryMap: Record<string, { id: string; name: string }> = {};

        for (const { processed, mlPredictions } of processedWithCategories) {
            if (mlPredictions?.length > 0) {
                mlCategoryMap[processed.asin] = mlPredictions;
                const topPred = mlPredictions[0];
                selectedCategoryMap[processed.asin] = {
                    id: topPred.category_id || topPred.id,
                    name: topPred.category_name || topPred.domain_name
                };
            }
        }

        setMlCategorySearchResults(prev => ({ ...prev, ...mlCategoryMap }));
        setSelectedCategories(prev => ({ ...prev, ...selectedCategoryMap }));

        const finalResults = processedWithCategories.map(({ processed }) => processed);

        // Clean titles for all products in batch
        const editedTitlesMap: Record<string, string> = {};
        for (const processed of finalResults) {
            const product = validProducts.find(p => p.asin === processed.asin);
            if (!product) continue;
            let finalTitle = processed.optimizedTitle || product.title;
            finalTitle = finalTitle
                .replace(/ni\s+os/gi, 'niños')
                .replace(/ni\s+as/gi, 'niñas');
            if (product.brand) {
                const brandRegex = new RegExp(product.brand, 'gi');
                finalTitle = finalTitle.replace(brandRegex, '').replace(/\s\s+/g, ' ').trim();
            }
            finalTitle = finalTitle.replace(/^[\s\-–—,.:;|]+/, '').trim();
            finalTitle = finalTitle.charAt(0).toUpperCase() + finalTitle.slice(1);
            editedTitlesMap[processed.asin] = finalTitle;
        }

        setEditedTitles(prev => ({ ...prev, ...editedTitlesMap }));
        setProcessedProducts(finalResults);
        setIsProcessing(false);
        setProcessingProgress(null);
        setProcessingStartedAt(prev => {
            if (prev) setLastRunDurationMs(Date.now() - prev);
            return null;
        });
    };

    // ── Step 4 handler ─────────────────────────────────────────────────
    const handleLoadAttributes = async () => {
        const rawFilters = localStorage.getItem('melidrop_global_filters') || "Nike\nAdidas\nReacondicionado";
        const forbiddenWords = rawFilters
            .split('\n')
            .map((w: string) => w.trim().toLowerCase())
            .filter(Boolean);

        setIsProcessing(true);
        setProcessingStage('Validando duplicados y palabras prohibidas...');
        setProcessingProgress({ current: 0, total: processedProducts.length });
        setProcessingStartedAt(Date.now());

        const nextValidations: Record<string, any> = {};
        const nextStatus: Record<string, string> = {};
        const nextResults: Record<string, any> = {};
        const nextCategoryAttrs: Record<string, any[]> = {};
        const nextUserAttrs: Record<string, any> = {};

        for (const processed of processedProducts) {
            const product = loadedProducts.find(p => p.asin === processed.asin);
            if (!product) {
                setProcessingProgress(prev => prev ? { ...prev, current: prev.current + 1 } : prev);
                continue;
            }

            setProcessingStage(`Validando ${editedTitles[product.asin] || product.title || product.asin}...`);
            const catId = selectedCategories[product.asin]?.id;

            const dupCheck = await meliService.checkDuplicate(product.asin);
            const titleToCheck = (editedTitles[product.asin] || processed.optimizedTitle).toLowerCase();
            const hasForbiddenWords = forbiddenWords.some(w => titleToCheck.includes(w));
            const forbiddenWord = forbiddenWords.find(w => titleToCheck.includes(w));

            nextValidations[product.asin] = {
                isDuplicate: dupCheck.isDuplicate,
                duplicateId: dupCheck.existingItem?.id,
                hasForbiddenWords,
                forbiddenWord,
                isSkipped: (dupCheck.isDuplicate && !product.asin.startsWith('TEST')) || hasForbiddenWords
            };

            if (dupCheck.isDuplicate && !product.asin.startsWith('TEST')) {
                nextStatus[product.asin] = 'error';
                nextResults[product.asin] = { error: `Ya publicado en tu cuenta (ID: ${dupCheck.existingItem?.id})` };
            }

            if (catId) {
                try {
                    const attrs = await meliService.getCategoryAttributes(catId);
                    const relevant = pickRelevantAttributes(attrs, 40);

                    nextCategoryAttrs[product.asin] = relevant;

                    if (relevant.length > 0) {
                        // Seed obvious values from Amazon data before calling AI
                        const seed: Record<string, string> = {};
                        const brandSeed = seedBrand(relevant, product.brand);
                        if (brandSeed) seed[brandSeed.id] = brandSeed.value;
                        const conditionAttr = relevant.find((a: any) => a.id === 'ITEM_CONDITION');
                        if (conditionAttr) seed['ITEM_CONDITION'] = 'Nuevo';

                        // Add product code (UPC/EAN/GTIN) from Amazon if available
                        const amazonAttrs = product.attributes || {};
                        const barcode = amazonAttrs.item_barcode?.[0]?.value || amazonAttrs.ean?.[0]?.value;
                        console.log(`[Melidrop] Amazon attrs for ${product.asin}:`, amazonAttrs);
                        console.log(`[Melidrop] Barcode extracted: ${barcode}`);

                        const codeAttrId = resolveBarcodeAttributeId(relevant);
                        console.log(`[Melidrop] Resolved code attribute for this category: ${codeAttrId}`);

                        if (barcode && codeAttrId) {
                            seed[codeAttrId] = barcode;
                            console.log(`[Melidrop] Seeded ${codeAttrId} = ${barcode}`);
                        }

                        const aiMapped = await aiImporterService.mapAttributes(
                            product.title,
                            product.description || '',
                            product.attributes || {},
                            relevant
                        );
                        const defaultAttrs: Record<string, string> = { ...seed };
                        if (Array.isArray(aiMapped)) {
                            aiMapped.forEach((ma: any) => {
                                // BRAND is already deterministically seeded above (real Amazon
                                // brand or "Genérica") — never let the AI's title-guess replace it.
                                if (ma.id && ma.value_name && ma.id !== brandSeed?.id &&
                                    !['genérico', 'generic', 'n/a', 'no aplica', 'unknown']
                                        .includes(ma.value_name.toLowerCase())) {
                                    defaultAttrs[ma.id] = ma.value_name;
                                }
                            });
                        }
                        const current = userAttributes[product.asin] || {};
                        nextUserAttrs[product.asin] = { ...defaultAttrs, ...current };
                    }
                } catch (e) {
                    console.error(`Failed to map attributes for ${product.asin}:`, e);
                }
            }

            setProcessingProgress(prev => prev ? { ...prev, current: prev.current + 1 } : prev);
        }

        setValidationResults(nextValidations);
        setPublishingStatus(nextStatus);
        setPublishResults(nextResults);
        setCategoryAttributes(nextCategoryAttrs);
        setUserAttributes(prev => ({ ...prev, ...nextUserAttrs }));
        setIsProcessing(false);
        setProcessingProgress(null);
        setProcessingStartedAt(prev => {
            if (prev) setLastRunDurationMs(Date.now() - prev);
            return null;
        });
        setStep(4);
    };

    // Lets Step 4 recover from "sin categoría asignada" in place — going back to
    // Step 3 would re-run handleLoadAttributes for the WHOLE batch, discarding
    // every other product's already-checked duplicate/attribute state just to
    // fix one. Reuses mlCategorySearchResults, the same state Step 3's category
    // buttons read from, so the existing UI pattern works unmodified here too.
    const searchCategoryForProduct = async (asin: string, searchTerm: string) => {
        if (!searchTerm.trim()) return;
        const predictions = await meliService.predictCategory(searchTerm.trim(), marketplace);
        setMlCategorySearchResults(prev => ({ ...prev, [asin]: predictions }));
    };

    // Assigns a category to ONE product and loads its attributes — the single-item
    // equivalent of what handleLoadAttributes does for the whole batch, so nothing
    // else already validated on this screen gets touched.
    const selectCategoryForProduct = async (asin: string, categoryId: string, categoryName: string) => {
        setSelectedCategories(prev => ({ ...prev, [asin]: { id: categoryId, name: categoryName } }));

        const processed = processedProducts.find(p => p.asin === asin);
        const product = loadedProducts.find(p => p.asin === asin);
        if (!product) return;

        try {
            const attrs = await meliService.getCategoryAttributes(categoryId);
            const relevant = pickRelevantAttributes(attrs, 40);
            setCategoryAttributes(prev => ({ ...prev, [asin]: relevant }));
            if (relevant.length === 0) { setUserAttributes(prev => ({ ...prev, [asin]: {} })); return; }

            // This isn't only "assign for the first time" anymore — the user can
            // switch an already-categorized product to a totally different one, so
            // prev[asin] may hold values keyed by the OLD category's attribute ids.
            // buildItemPayload sends whatever's in userAttributes without checking
            // it against the current category, so an unrelated id riding along
            // isn't just inert — keep only values whose id still means something here.
            const relevantIds = new Set(relevant.map((a: any) => a.id));

            const seed: Record<string, string> = {};
            const brandSeed = seedBrand(relevant, product.brand);
            if (brandSeed) seed[brandSeed.id] = brandSeed.value;
            const conditionAttr = relevant.find((a: any) => a.id === 'ITEM_CONDITION');
            if (conditionAttr) seed['ITEM_CONDITION'] = 'Nuevo';

            const amazonAttrs = product.attributes || {};
            const barcode = amazonAttrs.item_barcode?.[0]?.value || amazonAttrs.ean?.[0]?.value;
            const codeAttrId = resolveBarcodeAttributeId(relevant);
            if (barcode && codeAttrId) seed[codeAttrId] = barcode;

            if (processed) {
                const aiMapped = await aiImporterService.mapAttributes(
                    product.title, product.description || '', product.attributes || {}, relevant
                );
                const defaultAttrs: Record<string, string> = { ...seed };
                if (Array.isArray(aiMapped)) {
                    aiMapped.forEach((ma: any) => {
                        // BRAND is already deterministically seeded above (real Amazon
                        // brand or "Genérica") — never let the AI's title-guess replace it.
                        if (ma.id && ma.value_name && ma.id !== brandSeed?.id &&
                            !['genérico', 'generic', 'n/a', 'no aplica', 'unknown'].includes(ma.value_name.toLowerCase())) {
                            defaultAttrs[ma.id] = ma.value_name;
                        }
                    });
                }
                setUserAttributes(prev => {
                    const kept = Object.fromEntries(Object.entries(prev[asin] || {}).filter(([id]) => relevantIds.has(id)));
                    return { ...prev, [asin]: { ...defaultAttrs, ...kept } };
                });
            } else {
                setUserAttributes(prev => {
                    const kept = Object.fromEntries(Object.entries(prev[asin] || {}).filter(([id]) => relevantIds.has(id)));
                    return { ...prev, [asin]: { ...seed, ...kept } };
                });
            }
        } catch (e) {
            console.error(`[Melidrop] Failed to load attributes for ${asin} after manual category selection:`, e);
        }
    };

    // ── Pricing helpers ────────────────────────────────────────────────
    const calculateMexicoPrice = (cost: number, currency: string): number => {
        const isUSD = (currency?.toUpperCase() ?? 'USD') !== 'MXN';
        const exchangeRate = parseFloat(localStorage.getItem('melidrop_exchange_rate') || '18.5');
        const rulesKey = isUSD ? 'melidrop_usa_rules' : 'melidrop_mx_rules';
        const savedRulesRaw = localStorage.getItem(rulesKey);
        const defaultRules = isUSD
            ? [{ min: 0, max: 20, margin: 200 }, { min: 21, max: 50, margin: 100 }, { min: 51, max: null, margin: 50 }]
            : [{ min: 0, max: 300, margin: 150 }, { min: 301, max: 600, margin: 130 }, { min: 601, max: null, margin: 80 }];
        const rules: Array<{ min: number; max: number | null; margin: number }> = savedRulesRaw
            ? JSON.parse(savedRulesRaw)
            : defaultRules;
        const rule = rules.find(r => cost >= r.min && (r.max === null || cost <= r.max))
            || rules[rules.length - 1];
        const margin = rule?.margin ?? 50;
        // USD → convert to MXN then apply margin; MXN → apply margin directly
        return isUSD
            ? Math.ceil(cost * exchangeRate * (1 + margin / 100))
            : Math.ceil(cost * (1 + margin / 100));
    };

    const buildItemPayload = (processed: ProcessedProduct, isSandbox: boolean = false) => {
        const product = loadedProducts.find(p => p.asin === processed.asin)!;
        const catId = selectedCategories[processed.asin]?.id;
        const title = editedTitles[processed.asin] || processed.optimizedTitle;
        const attrs = userAttributes[processed.asin] || {};

        // Extract product code from Amazon attributes (UPC, EAN, GTIN)
        const amazonAttrs = product.attributes || {};
        const barcode = amazonAttrs.item_barcode?.[0]?.value || amazonAttrs.ean?.[0]?.value;
        const userHasBarcode = barcode && Object.values(attrs).includes(barcode);
        const barcodeAttrId = resolveBarcodeAttributeId(categoryAttributes[processed.asin] || []);

        // ML tells us exactly how each attribute wants its value via value_type +
        // allowed_units + default_unit (from /categories/{id}/attributes) — use that
        // instead of guessing by attribute name, which silently missed attributes like
        // BACKREST_WIDTH, MIN_HOURS_AUTONOMY, VOLUME_CAPACITY, SELLER_PACKAGE_WEIGHT.
        const attrDefs = categoryAttributes[processed.asin] || [];
        const attrDefById = new Map<string, any>(attrDefs.map((a: any) => [a.id, a]));
        const sanitizeAttrValue = (id: string, value: string): string | null =>
            sanitizeAttributeValue(attrDefById.get(id), value);

        const userAttrIds = new Set(Object.keys(attrs).filter(k => attrs[k]?.toString().trim()));

        // Only inject defaults for attributes the category actually declares
        const catAttrIds = new Set((categoryAttributes[processed.asin] || []).map((a: any) => a.id));

        const finalAttributes = [
            ...Object.entries(attrs)
                .filter(([id, v]) => {
                    if (!v) return false;
                    const strVal = v.toString().trim();
                    if (!strVal) return false;
                    if (id !== 'SELLER_SKU') return true;
                    return false;
                })
                .map(([id, value_name]) => ({ id, value_name: sanitizeAttrValue(id, value_name.toString().trim()) }))
                .filter((a): a is { id: string; value_name: string } => a.value_name !== null),
            { id: 'SELLER_SKU', value_name: processed.asin },
            // Falls back to whatever code attribute this category actually has —
            // confirmed live that some categories (e.g. MLM189211) only accept
            // GTIN and have no UPC attribute at all, so a hardcoded 'UPC' here
            // would get silently ignored and ML would still report it missing.
            ...(barcode && !userHasBarcode && barcodeAttrId ? [{ id: barcodeAttrId, value_name: barcode }] : []),
            // Only add UNITS_PER_PACK / MODEL defaults if the category supports them
            ...(!userAttrIds.has('UNITS_PER_PACK') && catAttrIds.has('UNITS_PER_PACK') ? [{ id: 'UNITS_PER_PACK', value_name: '1' }] : []),
            ...(!userAttrIds.has('MODEL') && catAttrIds.has('MODEL') ? [{ id: 'MODEL', value_name: product.brand || processed.asin }] : []),
        ];

        const currency = product.currency || 'USD';
        const isUSD = currency.toUpperCase() !== 'MXN';
        let priceMXN = calculateMexicoPrice(product.price || 0, currency);

        // For sandbox test products: multiply price by 10 to prevent accidental purchases
        if (isSandbox) {
            priceMXN = priceMXN * 10;
        }

        const availableQty = parseInt(localStorage.getItem('melidrop_default_stock') || '3');
        const warrantyMonths = parseInt(localStorage.getItem('melidrop_warranty_months') || '1');

        // handling_time = días preparación del vendedor + días de entrega Amazon
        // Reads the same keys that SettingsPage writes
        const prepDaysStored = parseInt(localStorage.getItem('melidrop_prep_days') || '3');
        const deliveryDaysStored = isUSD
            ? parseInt(localStorage.getItem('melidrop_delivery_days_usa') || '10')
            : parseInt(localStorage.getItem('melidrop_delivery_days_mx') || '3');
        // Sandbox: ML caps at 30 days for test listings
        const handlingTime = isSandbox ? 30 : (prepDaysStored + deliveryDaysStored);

        // Sanitize title: remove ML-forbidden chars, strip trailing punctuation from truncation
        const safeTitle = title
            .replace(/[<>|\\]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[,;:\-]+$/, '')
            .substring(0, 60)
            .trim();

        const configDescription = localStorage.getItem('melidrop_description_suffix') ||
            `==========================================
IMPORTANTE:
Este producto se importa de Estados Unidos
Por favor revisa la fecha de entrega antes de comprar
==========================================

Este producto ha sido seleccionado cuidadosamente para ofrecerte la mejor calidad y desempeño. Ideal para quienes buscan confiabilidad y funcionalidad en su compra.

¿Por qué elegirnos?

Factura disponible: Al realizar tu compra, solicítanos la factura y con gusto te la enviaremos.
Garantía de ${warrantyMonths} mes${warrantyMonths > 1 ? 'es' : ''}: Si no quedas satisfecho con el producto o presenta algún defecto, puedes realizar devoluciones sin problema.
Compra con confianza, estamos comprometidos en ofrecerte productos de excelente calidad y un servicio de atención al cliente sobresaliente.

¡Haz tu compra ahora y recibe tu producto en la puerta de tu hogar!`;

        const amazonDescription = product.description
            ? product.description.substring(0, 1500)
            : '';

        const descriptionText = amazonDescription
            ? `${configDescription}\n\n${amazonDescription}`.substring(0, 5000)
            : configDescription.substring(0, 5000);
        // Deduplicate by Amazon image ID (unique identifier between /images/I/ and first .)
        const seenAmazonIds = new Set<string>();
        const pictureUrls: string[] = [];
        for (const img of processed.images) {
            const idMatch = img.url.match(/\/images\/I\/([^.]+)\./);
            const amazonId = idMatch ? idMatch[1] : null;
            const dedupeKey = amazonId || img.url;

            if (!seenAmazonIds.has(dedupeKey)) {
                seenAmazonIds.add(dedupeKey);
                // Strip size modifiers so ML receives the full-resolution image
                pictureUrls.push(normalizeAmazonImageUrl(img.url));
            }
        }
        pictureUrls.splice(10);

        const warrantyLabel = warrantyMonths >= 12
            ? `${Math.floor(warrantyMonths / 12)} año${Math.floor(warrantyMonths / 12) > 1 ? 's' : ''}`
            : `${warrantyMonths} mes${warrantyMonths > 1 ? 'es' : ''}`;

        const payload: any = {
            title: safeTitle,
            category_id: catId,
            price: priceMXN,
            currency_id: marketplace === 'MLM' ? 'MXN' : 'USD',
            available_quantity: availableQty,
            buying_mode: 'buy_it_now',
            listing_type_id: listingType,
            condition: 'new',
            description: { plain_text: descriptionText },
            seller_custom_field: processed.asin,
            pictures: pictureUrls.map(url => ({ source: url })),
            attributes: finalAttributes,
            sale_terms: [
                { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' },
                { id: 'WARRANTY_TIME', value_name: warrantyLabel },
            ],
            shipping: isSandbox
                ? {
                    mode: 'me2',
                    free_shipping: true,
                    local_pick_up: false,
                    handling_time: handlingTime,
                  }
                : {
                    mode: 'me2',
                    free_shipping: true,
                    local_pick_up: false,
                    logistic_type: 'drop_off',
                    handling_time: handlingTime,
                  }
        };

        return payload;
    };

    // ── Step 5 handlers ────────────────────────────────────────────────
    // Shared by handleDryRun/handlePublish (server-side guard) and Step4's UI
    // (so the wizard can warn the user before they even try to publish).
    // Returns [] when the ASIN is ready to publish.
    const getBlockingIssues = (asin: string): string[] => {
        const issues: string[] = [];
        const product = loadedProducts.find(p => p.asin === asin);
        const catId = selectedCategories[asin]?.id;

        if (!catId) {
            issues.push('Sin categoría de MercadoLibre asignada (vuelve al Paso 3)');
        }
        if (!product?.price || product.price <= 0) {
            issues.push('Sin precio de Amazon disponible (no se puede calcular el precio de venta)');
        }
        if (catId) {
            const attrs = categoryAttributes[asin] || [];
            const userAttrs = userAttributes[asin] || {};
            const codeAttrId = resolveBarcodeAttributeId(attrs);
            const hasRealCode = !!(codeAttrId && userAttrs[codeAttrId]?.toString().trim());
            const missing = attrs.filter((a: any) => {
                if (!isRequiredAttr(a)) return false;
                // EMPTY_GTIN_REASON's condition is literally "there's no real code" —
                // conditional_required flags that it HAS a condition, not that it's
                // unconditionally required the way required/new_required are. Confirmed
                // live: a product with a real GTIN filled in was still being blocked on
                // this, asking for a reason the code's own presence already answers.
                if (a.id === 'EMPTY_GTIN_REASON' && hasRealCode) return false;
                const raw = userAttrs[a.id]?.toString().trim();
                if (!raw) return true;
                // Also catches values that are present but unusable for this
                // attribute's type — e.g. "Agua tibia" for a number_unit attribute —
                // so the user fixes it here instead of hitting a cryptic ML error.
                return sanitizeAttributeValue(a, raw) === null;
            });
            if (missing.length > 0) {
                issues.push(`Faltan ${missing.length} atributo(s) requerido(s): ${missing.map((a: any) => a.name).join(', ')}`);
            }
        }
        return issues;
    };

    const handleDryRun = async (asin: string) => {
        const processed = processedProducts.find(p => p.asin === asin);
        if (!processed) return;

        // Hard lock #1: already published to sandbox this session. The ML catalog
        // search used further down as a fallback check can lag a few seconds
        // behind a fresh publish, so a same-session repeat click (e.g. retrying
        // "fallidos" before realizing this one already succeeded) could slip
        // past it — this in-memory check is instant and always current.
        if (dryRunResults[asin]?.testMeliId) {
            console.warn(`[Melidrop] ${asin} already published to sandbox this session (${dryRunResults[asin].testMeliId}), skipping`);
            return;
        }

        const blockingIssues = getBlockingIssues(asin);
        if (blockingIssues.length > 0) {
            setDryRunResults(prev => ({ ...prev, [asin]: { dryError: `No se puede probar:\n• ${blockingIssues.join('\n• ')}` } }));
            return;
        }

        setPublishingStatus(prev => ({ ...prev, [asin]: 'loading' }));
        try {
            // Hard lock #2: already published in a PREVIOUS session (survives page
            // reloads). This is our own database write from the moment the sandbox
            // publish succeeded, so — unlike ML's search index — there's no lag.
            const { data: { user: currentUser } } = await supabase.auth.getUser();
            if (currentUser) {
                const { data: existingRow } = await supabase
                    .from('test_products')
                    .select('meli_id')
                    .eq('user_id', currentUser.id)
                    .eq('asin', asin)
                    .maybeSingle();
                if (existingRow?.meli_id) {
                    console.warn(`[Melidrop] ${asin} already in test_products (${existingRow.meli_id}), skipping re-publish`);
                    setDryRunResults(prev => ({
                        ...prev,
                        [asin]: {
                            testMeliId: existingRow.meli_id,
                            testPublish: { id: existingRow.meli_id, alreadyPublished: true },
                            hasTestUser: !!testUserCreds?.access_token,
                        }
                    }));
                    setPublishingStatus(prev => ({ ...prev, [asin]: 'idle' }));
                    return;
                }
            }

            const payload = buildItemPayload(processed, true);
            const validation = await meliService.validateItem(payload);

            let publishResult: any = null;
            let testMeliId: string | null = null;

            // Attempt sandbox publish if we have any test user credentials
            if (testUserCreds?.email && (testUserCreds?.password || testUserCreds?.access_token)) {
                try {
                    let testToken: string | null = null;
                    try {
                        // autoRefreshTestUserToken handles everything: returns the cached
                        // token if fresh, else silently renews via refresh_token (OAuth
                        // connections) or password grant (legacy), persisting the result.
                        testToken = await meliService.autoRefreshTestUserToken();
                    } catch { /* fall back to stored token below */ }
                    if (!testToken) testToken = testUserCreds.access_token ?? null;

                    if (testToken) {
                        // The test user's sandbox catalog is a completely separate ML
                        // account from the real one — checkDuplicate() with no override
                        // only ever looks at the real account, so without this every
                        // "Probar (sandbox)" click published a fresh duplicate listing.
                        let testUserId: number | string | undefined = testUserCreds?.id;
                        if (!testUserId) {
                            const info = await meliService.getUserInfoByToken(testToken);
                            testUserId = info?.id;
                            if (testUserId) {
                                const { data: { user } } = await supabase.auth.getUser();
                                if (user) {
                                    const updated = { ...testUserCreds, id: testUserId };
                                    await supabase.from('user_connections').upsert(
                                        { user_id: user.id, meli_test_user: updated },
                                        { onConflict: 'user_id' }
                                    );
                                    setTestUserCreds(updated);
                                }
                            }
                        }

                        const existing = testUserId
                            ? await meliService.checkDuplicate(asin, { token: testToken, userId: testUserId })
                            : { isDuplicate: false };

                        if (existing.isDuplicate) {
                            console.log(`[Melidrop] ${asin} already in sandbox catalog (${existing.existingItem?.id}), skipping re-publish`);
                            // checkDuplicate already fetched this item's current status
                            // (that's how it decided it was a duplicate) — reuse it instead
                            // of assuming 'active' for an item we didn't just publish.
                            publishResult = { id: existing.existingItem?.id, alreadyPublished: true, status: existing.existingItem?.status };
                            testMeliId = existing.existingItem?.id ?? null;
                        } else {
                        const imageIds: string[] = [];
                        const seenAmazonIds = new Set<string>();
                        for (const img of processed.images.slice(0, 10)) {
                            // Deduplicate by Amazon image ID (unique identifier in URL)
                            const idMatch = img.url.match(/\/images\/I\/([^.]+)\./);
                            const amazonId = idMatch ? idMatch[1] : null;
                            const dedupeKey = amazonId || img.url;

                            if (seenAmazonIds.has(dedupeKey)) continue;
                            seenAmazonIds.add(dedupeKey);

                            const id = await uploadProductImage(img, testToken);
                            if (id && !imageIds.includes(id)) imageIds.push(id);
                        }
                        const testPayload = { ...payload, description: undefined };
                        if (imageIds.length > 0) {
                            (testPayload as any).pictures = imageIds.map((id: string) => ({ id }));
                        }
                        publishResult = await meliService.publishItem(testPayload, false, testToken);

                        // Some categories reject the hardcoded WARRANTY_TYPE free-text
                        // value — they expect one of a fixed set of value_ids instead.
                        // sale_terms are optional enrichment, not required to publish,
                        // so drop them and retry rather than fail the whole listing.
                        if (publishResult?.error && publishResult.cause?.some((c: any) => c.message?.toLowerCase().includes('sale term'))) {
                            console.log(`[Melidrop] Category rejects sale_terms — retrying without them`);
                            const noTermsPayload = { ...testPayload };
                            delete (noTermsPayload as any).sale_terms;
                            publishResult = await meliService.publishItem(noTermsPayload, false, testToken);
                        }

                        if (publishResult?.id) {
                            testMeliId = publishResult.id;
                            console.log(`[Melidrop] Sandbox item published with ID: ${publishResult.id}`);
                            if (payload.description?.plain_text) {
                                console.log(`[Melidrop] Posting description (${payload.description.plain_text.length} chars) for item ${publishResult.id}`);
                                try {
                                    await meliService.postDescription(publishResult.id, payload.description.plain_text, testToken);
                                    console.log(`[Melidrop] ✅ Description posted successfully`);
                                } catch (descErr: any) {
                                    console.error('[Melidrop] ❌ Description post failed:', descErr.message);
                                    publishResult.description_error = descErr.message;
                                }
                            } else {
                                console.warn(`[Melidrop] ⚠️ No description to post (payload.description?.plain_text is empty)`);
                            }
                        } else {
                            console.error(`[Melidrop] ❌ Item publish failed, no ID:`, publishResult);
                        }
                        } // end existing.isDuplicate else (fresh sandbox publish)
                    } else {
                        publishResult = { error: 'No se pudo obtener token del usuario de prueba' };
                    }
                } catch (publishErr: any) {
                    publishResult = { error: publishErr.message };
                }
            }

            // Build production payload to store for "Publicar Real" later
            const productionPayload = buildItemPayload(processed, false);

            await api.testProducts.create({
                title: payload.title,
                asin: processed.asin,
                sku: processed.asin,
                price_mxn: payload.price,
                cost_usd: loadedProducts.find(p => p.asin === processed.asin)?.price || 0,
                image_url: processed.images[0]?.url,
                category: payload.category_id,
                // publishResult IS ML's raw item response on a fresh publish (status
                // included directly), or the real status checkDuplicate already read
                // on a skip — either way this is what ML actually returned, not an
                // assumption. 'active' only as a last resort when nothing published.
                status: publishResult?.status || 'active',
                publish_payload: productionPayload,
                ...(testMeliId ? { meli_id: testMeliId } : {})
            });

            let dryError: string | null = null;
            if (!testMeliId && publishResult !== null) {
                const causeDetails: string[] = [];
                if (publishResult?.cause && Array.isArray(publishResult.cause)) {
                    publishResult.cause.forEach((c: any) => {
                        const field = c.field ? `[${c.field}] ` : '';
                        const msg = c.message || c.description || (c.code ? `código ${c.code}` : null) || JSON.stringify(c);
                        causeDetails.push(`${field}${msg}`);
                    });
                }
                if (publishResult?.error) {
                    dryError = causeDetails.length > 0
                        ? `${publishResult.error}\n• ${causeDetails.join('\n• ')}`
                        : publishResult.error;
                } else if (causeDetails.length > 0) {
                    dryError = causeDetails.join('\n• ');
                } else if (publishResult && !publishResult.id) {
                    dryError = publishResult.message || 'Error desconocido al publicar en sandbox';
                }
            }

            setDryRunResults(prev => ({
                ...prev,
                [asin]: {
                    payload, validation,
                    testPublish: publishResult,
                    hasTestUser: !!testUserCreds?.access_token,
                    testMeliId,
                    dryError,
                }
            }));
            setPublishingStatus(prev => ({ ...prev, [asin]: 'idle' }));
        } catch (err: any) {
            setPublishResults(prev => ({ ...prev, [asin]: { error: `Error en prueba: ${err.message}` } }));
            setPublishingStatus(prev => ({ ...prev, [asin]: 'error' }));
        }
    };

    // Force full-resolution Amazon CDN image: strip size/crop modifiers from URL.
    // "71XxxxxL._AC_SL75_.jpg" → "71XxxxxL.jpg" (Amazon returns full size when no modifier).
    const normalizeAmazonImageUrl = (url: string): string => {
        if (!/media-amazon\.com|images-amazon\.com/i.test(url)) return url;
        return url.replace(/\._[A-Z0-9_]+_\.(jpg|jpeg|png|gif|webp)$/i, '.$1');
    };

    // ML requires minimum 500x250px; upscale smaller images
    const resizeImageIfNeeded = async (imageUrl: string): Promise<string> => {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const MIN_WIDTH = 500;
                const MIN_HEIGHT = 250;

                if (img.width >= MIN_WIDTH && img.height >= MIN_HEIGHT) {
                    console.log(`[Melidrop] Image ${img.width}x${img.height} meets ML requirements`);
                    resolve(imageUrl);
                    return;
                }

                let newWidth = img.width;
                let newHeight = img.height;

                if (newWidth < MIN_WIDTH) {
                    const scale = MIN_WIDTH / newWidth;
                    newWidth = MIN_WIDTH;
                    newHeight = Math.round(newHeight * scale);
                }

                if (newHeight < MIN_HEIGHT) {
                    const scale = MIN_HEIGHT / newHeight;
                    newHeight = MIN_HEIGHT;
                    newWidth = Math.round(newWidth * scale);
                }

                console.log(`[Melidrop] Upscaling ${img.width}x${img.height} → ${newWidth}x${newHeight}`);

                const canvas = document.createElement('canvas');
                canvas.width = newWidth;
                canvas.height = newHeight;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve(imageUrl);
                    return;
                }

                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, newWidth, newHeight);

                const resizedDataUrl = canvas.toDataURL('image/jpeg', 0.95);
                resolve(resizedDataUrl);
            };

            img.onerror = () => {
                console.warn(`[Melidrop] Failed to load image for resizing: ${imageUrl}`);
                resolve(imageUrl);
            };

            img.src = imageUrl;
        });
    };

    // Fetches an image ourselves and returns it as a data: URL, so we can upload
    // the bytes directly instead of asking ML to fetch the URL itself.
    const fetchImageAsBase64 = async (url: string): Promise<string | null> => {
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const blob = await res.blob();
            return await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            console.warn(`[Melidrop] fetchImageAsBase64 failed for ${url}:`, e);
            return null;
        }
    };

    const retryUpload = async (fn: () => Promise<string | null>, attempts: number, label: string, urlForLog: string): Promise<string | null> => {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const id = await fn();
            if (id) return id;
            if (attempt < attempts) {
                console.warn(`[Melidrop] ${label} attempt ${attempt}/${attempts} failed for ${urlForLog}, retrying...`);
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
        return null;
    };

    // Uploads one product image to ML. "Ocurrió un error procesando la foto" on
    // the normal (source-URL) path is ML's own server timing out fetching the
    // image from Amazon's CDN — a hop we don't control. A handful of users saw
    // it take up to 6 manual retries in a row to get through, meaning a short
    // same-strategy retry isn't always enough. So past the first few attempts
    // this switches strategy entirely: fetch the image ourselves (client-side)
    // and upload the bytes directly, removing ML's Amazon-fetch step from the
    // equation rather than just hoping the same thing works on attempt N+1.
    const uploadProductImage = async (img: { url: string; cleanedUrl?: string }, token?: string): Promise<string | null> => {
        if (img.cleanedUrl) {
            const id = await retryUpload(() => meliService.uploadImageBinary(img.cleanedUrl!, token), 4, 'cleaned-image upload', img.url);
            if (!id) console.error(`[Melidrop] Cleaned-image upload failed after all attempts: ${img.url}`);
            return id;
        }

        const fullUrl = normalizeAmazonImageUrl(img.url);

        const uploadNormal = async (): Promise<string | null> => {
            const resizedUrl = await resizeImageIfNeeded(fullUrl);
            return resizedUrl.startsWith('data:')
                ? meliService.uploadImageBinary(resizedUrl, token)
                : meliService.uploadImage(resizedUrl, token);
        };
        let id = await retryUpload(uploadNormal, 3, 'image upload', img.url);
        if (id) return id;

        console.warn(`[Melidrop] Normal upload path exhausted for ${img.url} — switching to direct binary fetch...`);
        const uploadViaDirectFetch = async (): Promise<string | null> => {
            const dataUrl = await fetchImageAsBase64(fullUrl);
            return dataUrl ? meliService.uploadImageBinary(dataUrl, token) : null;
        };
        id = await retryUpload(uploadViaDirectFetch, 3, 'direct-fetch upload', img.url);
        if (!id) console.error(`[Melidrop] Image upload failed after all attempts (normal + direct-fetch): ${img.url}`);
        return id;
    };

    const handlePublish = async (asin: string, isDraft = false) => {
        const processed = processedProducts.find(p => p.asin === asin);
        if (!processed) return;

        // Block if already successfully published in this session
        if (publishResults[asin]?.id) {
            console.warn(`[Melidrop] ${asin} already published this session (${publishResults[asin].id}), skipping`);
            return;
        }

        // Block if flagged as duplicate by step 4 validation
        if (validationResults[asin]?.isDuplicate) {
            console.warn(`[Melidrop] ${asin} is a duplicate (step 4), skipping publish`);
            setPublishResults(prev => ({ ...prev, [asin]: { error: `Ya existe en tus publicaciones (ID: ${validationResults[asin].duplicateId || 'desconocido'})` } }));
            setPublishingStatus(prev => ({ ...prev, [asin]: 'error' }));
            return;
        }

        // Block if category/price/required-attrs aren't resolved — avoids sending ML
        // a payload we already know is invalid (missing category_id, price 0, etc.)
        const blockingIssues = getBlockingIssues(asin);
        if (blockingIssues.length > 0) {
            setPublishResults(prev => ({ ...prev, [asin]: { error: `No se puede publicar:\n• ${blockingIssues.join('\n• ')}` } }));
            setPublishingStatus(prev => ({ ...prev, [asin]: 'error' }));
            return;
        }

        // Supabase check: block if we already have this ASIN in our products table
        setPublishingStatus(prev => ({ ...prev, [asin]: 'loading' }));
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                const { data: existing } = await supabase
                    .from('products')
                    .select('meli_id, status')
                    .eq('user_id', user.id)
                    .eq('sku', asin)
                    .neq('status', 'closed')
                    .limit(1)
                    .maybeSingle();
                if (existing?.meli_id) {
                    console.warn(`[Melidrop] ${asin} found in Supabase (${existing.meli_id}), blocking publish`);
                    setPublishResults(prev => ({ ...prev, [asin]: { error: `Ya publicado anteriormente (${existing.meli_id})` } }));
                    setPublishingStatus(prev => ({ ...prev, [asin]: 'error' }));
                    return;
                }
            }
        } catch (sbCheckErr: any) {
            console.warn(`[Melidrop] Supabase duplicate pre-check failed (non-blocking):`, sbCheckErr.message);
        }

        console.log(`[Melidrop] handlePublish starting for ${asin}: processed.images.length = ${processed.images?.length ?? 0}`);
        try {
            // Real account publishing always uses the real account token (getValidToken).
            // testUserCreds are only used in handleDryRun (sandbox). Never mix them here.
            const publishToken: string | undefined = undefined;

            const imageIds: string[] = [];
            const seenAmazonIds = new Set<string>();
            console.log(`[Melidrop] Starting image upload loop for ${asin}, will iterate through ${Math.min(processed.images.length, 10)} images`);
            for (const img of processed.images.slice(0, 10)) {
                // Deduplicate by Amazon image ID (unique identifier in URL)
                const idMatch = img.url.match(/\/images\/I\/([^.]+)\./);
                const amazonId = idMatch ? idMatch[1] : null;
                const dedupeKey = amazonId || img.url;

                if (seenAmazonIds.has(dedupeKey)) continue;
                seenAmazonIds.add(dedupeKey);

                const id = await uploadProductImage(img, publishToken);
                if (id && !imageIds.includes(id)) {
                    console.log(`[Melidrop] ${asin}: Successfully uploaded image, imageId=${id}`);
                    imageIds.push(id);
                } else if (!id) {
                    console.warn(`[Melidrop] ${asin}: Image upload failed (no ID returned)`);
                }
            }
            console.log(`[Melidrop] ${asin}: Total images uploaded: ${imageIds.length}`);

            const payload = buildItemPayload(processed);
            const descriptionText = payload.description?.plain_text;
            const publishPayload = { ...payload, description: undefined };
            if (imageIds.length > 0) {
                (publishPayload as any).pictures = imageIds.map((id: string) => ({ id }));
                console.log(`[Melidrop] ${asin}: Setting pictures array with ${imageIds.length} images: ${imageIds.join(', ')}`);
            } else {
                console.warn(`[Melidrop] ${asin}: No images to upload! publishPayload.pictures will not be set`);
            }

            // Log attributes being sent for debugging
            console.log(`[Melidrop] Publishing ${asin} with attributes:`, publishPayload.attributes?.map((a: any) => `${a.id}="${a.value_name}"`));

            let result = await meliService.publishItem(publishPayload, isDraft, publishToken);

            // Some ML categories require family_name and reject title when it's provided.
            // Retry without title, using the original title as family_name instead.
            if (result.error && result.cause?.some((c: any) => c.message?.includes('family_name'))) {
                console.log(`[Melidrop] Category requires family_name — retrying without title`);
                const familyPayload = { ...publishPayload };
                const originalTitle = familyPayload.title;
                delete familyPayload.title;
                familyPayload.family_name = originalTitle;
                result = await meliService.publishItem(familyPayload, isDraft, publishToken);
            }

            // Some categories reject the hardcoded WARRANTY_TYPE free-text value —
            // they expect one of a fixed set of value_ids instead. sale_terms are
            // optional enrichment, not required to publish, so drop them and retry
            // rather than fail the whole listing over a warranty label.
            if (result.error && result.cause?.some((c: any) => c.message?.toLowerCase().includes('sale term'))) {
                console.log(`[Melidrop] Category rejects sale_terms — retrying without them`);
                const noTermsPayload = { ...publishPayload };
                delete (noTermsPayload as any).sale_terms;
                result = await meliService.publishItem(noTermsPayload, isDraft, publishToken);
            }

            console.log(`[Melidrop] Publication response for ${asin}:`, result);

            if (result.error) {
                const causes: string[] = [];
                if (result.cause && Array.isArray(result.cause)) {
                    result.cause.forEach((c: any) => {
                        if (typeof c === 'string') {
                            causes.push(c);
                        } else {
                            const field = c.field ? `[${c.field}] ` : '';
                            if (c.message) causes.push(`${field}${c.message}`);
                            else if (c.code || c.description) causes.push(`${field}${c.code ? `[${c.code}] ` : ''}${c.description || ''}`);
                            else causes.push(field + JSON.stringify(c));
                        }
                    });
                }

                let suggestion = '';
                if (result.error.includes('SHEETS_CAPACITY')) {
                    suggestion = '\n\n💡 El atributo SHEETS_CAPACITY podría estar vacío o inválido. Verifica en el Paso 4 que todos los atributos requeridos tengan valores válidos.';
                }

                const msg = causes.length > 0 ? `${result.error}\n• ${causes.join('\n• ')}${suggestion}` : result.error + suggestion;
                console.error(`[Melidrop] Publication error for ${asin}:`, { error: result.error, cause: result.cause, fullPayload: publishPayload });
                setPublishResults(prev => ({ ...prev, [asin]: { error: msg, raw: result } }));
                setPublishingStatus(prev => ({ ...prev, [asin]: 'error' }));
            } else {
                setPublishResults(prev => ({ ...prev, [asin]: result }));
                setPublishingStatus(prev => ({ ...prev, [asin]: 'success' }));

                if (result.id && descriptionText) {
                    console.log(`[Melidrop] Posting description (${descriptionText.length} chars) for item ${result.id}`);
                    try {
                        await meliService.postDescription(result.id, descriptionText, publishToken);
                        console.log(`[Melidrop] ✅ Description posted successfully`);
                    } catch (descErr: any) {
                        console.error('[Melidrop] ❌ Description post failed:', descErr.message);
                        result.description_warning = `Descripción: ${descErr.message}`;
                    }
                } else {
                    if (!result.id) console.warn(`[Melidrop] ⚠️ No result.id, cannot post description`);
                    if (!descriptionText) console.warn(`[Melidrop] ⚠️ No description text`);
                }

                // Persist the product to Supabase so the updater knows its currency
                // and description without having to re-fetch from Amazon.
                if (result.id) {
                    const { data: { user } } = await supabase.auth.getUser();
                    if (user) {
                        const product = loadedProducts.find(p => p.asin === asin);
                        const { error: sbErr } = await supabase.from('products').upsert({
                            user_id:          user.id,
                            meli_id:          result.id,
                            asin:             processed.asin,
                            title:            result.title || publishPayload.title || processed.optimizedTitle,
                            sku:              processed.asin,
                            price_mxn:        publishPayload.price,
                            stock_meli:       publishPayload.available_quantity,
                            status:           isDraft ? 'inactive' : 'active',
                            image_url:        processed.images[0]?.url ?? null,
                            currency:         product?.currency ?? 'USD',
                            description_text: descriptionText ?? null,
                            last_updated:     new Date().toISOString(),
                            in_updater:       !isDraft,
                            published_by_app: true,
                        }, { onConflict: 'meli_id' });
                        if (sbErr) console.warn('[Melidrop] Supabase upsert error:', sbErr.message);

                        // Fire-and-forget: trigger updater to scrape real Amazon delivery days
                        // and update shipping.handling_time immediately after publish
                        if (!isDraft && !sbErr) {
                            supabase.functions.invoke('amazon-ml-updater', {
                                body: { force: true, userId: user.id, asin }
                            }).catch(err => console.warn('[Melidrop] Post-publish updater trigger failed:', err));
                        }
                    }
                }
            }
        } catch (e: any) {
            setPublishResults(prev => ({ ...prev, [asin]: { error: e.message } }));
            setPublishingStatus(prev => ({ ...prev, [asin]: 'error' }));
        }
    };

    return {
        // Navigation
        step, setStep,
        // Step 1
        marketplace, setMarketplace,
        listingType, setListingType,
        autoCategory, setAutoCategory,
        cleanImages, setCleanImages,
        // Step 2
        asinInput, setAsinInput,
        loadedProducts, setLoadedProducts,
        loadingAsins,
        handleLoadAsins,
        refetchProductPrice,
        removeProduct,
        // Step 3
        processedProducts,
        editedTitles, setEditedTitles,
        selectedCategories, setSelectedCategories,
        mlCategorySearchResults,
        processingStage,
        processingProgress,
        processingStartedAt,
        lastRunDurationMs,
        isProcessing,
        handleProcessWithAI,
        // Step 4
        categoryAttributes,
        userAttributes, setUserAttributes,
        validationResults,
        handleLoadAttributes,
        searchCategoryForProduct,
        selectCategoryForProduct,
        // Step 5
        publishingStatus,
        publishResults,
        dryRunResults,
        testUserCreds,
        handleDryRun,
        handlePublish,
        getBlockingIssues,
        // Helpers
        calculateMexicoPrice,
        buildItemPayload,
    };
}
