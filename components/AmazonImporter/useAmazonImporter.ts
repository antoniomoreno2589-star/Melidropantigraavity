import { useState, useEffect } from 'react';
import { amazonService } from '../../services/amazonService';
import { aiImporterService, ProcessedProduct } from '../../services/aiImporterService';
import { meliService } from '../../services/meliService';
import { api } from '../../services/api';
import { supabase } from '../../services/supabase';
import { Step, Marketplace, ListingType, LoadedProduct } from './types';

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

        for (const asin of asins) {
            try {
                const product = await amazonService.getProduct(asin);
                setLoadedProducts(prev => prev.map(p => p.asin === asin ? {
                    ...p,
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
                    error: null
                } : p));
            } catch (e: any) {
                setLoadedProducts(prev => prev.map(p =>
                    p.asin === asin ? { ...p, loading: false, error: e.message } : p
                ));
            }
        }
        setLoadingAsins(false);
    };

    // ── Step 3 handler ─────────────────────────────────────────────────
    const handleProcessWithAI = async () => {
        const validProducts = loadedProducts.filter(p => !p.loading && !p.error);
        if (validProducts.length === 0) return;

        setIsProcessing(true);
        const results: ProcessedProduct[] = [];

        for (const product of validProducts) {
            setProcessingStage(`Procesando "${product.title.substring(0, 30)}..."`);

            const processed = await aiImporterService.processProduct(product, marketplace, [], cleanImages);

            setProcessingStage('Buscando categoría en MercadoLibre...');
            const mlPredictions = await meliService.predictCategory(
                processed.categorySuggestion.search_term, marketplace
            );

            if (mlPredictions && mlPredictions.length > 0) {
                setMlCategorySearchResults(prev => ({ ...prev, [product.asin]: mlPredictions }));
                const topPred = mlPredictions[0];
                setSelectedCategories(prev => ({
                    ...prev,
                    [product.asin]: {
                        id: topPred.category_id || topPred.id,
                        name: topPred.category_name || topPred.domain_name
                    }
                }));
            }

            // Deduplicate images by Amazon image hash
            const seenHashes = new Set<string>();
            const uniqueImages: typeof processed.images = [];
            for (const img of processed.images) {
                const hashMatch = img.url.match(/\/images\/I\/([^./]+)/);
                const key = hashMatch ? hashMatch[1] : img.url.split('?')[0];
                if (!seenHashes.has(key)) {
                    seenHashes.add(key);
                    uniqueImages.push(img);
                }
            }
            processed.images = uniqueImages.slice(0, 10);
            results.push(processed);

            // Clean title: remove brand, fix encoding artifacts, strip leading punctuation
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
            setEditedTitles(prev => ({ ...prev, [product.asin]: finalTitle }));
        }

        setProcessedProducts(results);
        setIsProcessing(false);
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

        const nextValidations: Record<string, any> = {};
        const nextStatus: Record<string, string> = {};
        const nextResults: Record<string, any> = {};
        const nextCategoryAttrs: Record<string, any[]> = {};
        const nextUserAttrs: Record<string, any> = {};

        for (const processed of processedProducts) {
            const product = loadedProducts.find(p => p.asin === processed.asin);
            if (!product) continue;

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
                    const relevant = attrs
                        .filter((a: any) =>
                            a.tags?.required || a.tags?.new_required ||
                            (!a.tags?.read_only && a.relevance >= 1)
                        )
                        .slice(0, 40);

                    nextCategoryAttrs[product.asin] = relevant;

                    if (relevant.length > 0) {
                        // Seed obvious values from Amazon data before calling AI
                        const seed: Record<string, string> = {};
                        const brandAttr = relevant.find((a: any) => a.id === 'BRAND' || a.id === 'MARCA');
                        if (brandAttr && product.brand && !['unknown', 'n/a', ''].includes(product.brand.toLowerCase())) {
                            seed[brandAttr.id] = product.brand;
                        }
                        const conditionAttr = relevant.find((a: any) => a.id === 'ITEM_CONDITION');
                        if (conditionAttr) seed['ITEM_CONDITION'] = 'Nuevo';

                        // Add product code (UPC/EAN/GTIN) from Amazon if available
                        const amazonAttrs = product.attributes || {};
                        const barcode = amazonAttrs.item_barcode?.[0]?.value || amazonAttrs.ean?.[0]?.value;
                        console.log(`[Melidrop] Amazon attrs for ${product.asin}:`, amazonAttrs);
                        console.log(`[Melidrop] Barcode extracted: ${barcode}`);

                        const codeAttrOptions = relevant.filter((a: any) =>
                            a.id === 'EAN' || a.id === 'UPC' || a.id === 'GTIN' ||
                            a.id === 'ITEM_BARCODE' || a.id === 'UNIVERSAL_CODE' ||
                            a.id.includes('CODE') || a.id.includes('BARCODE')
                        );
                        console.log(`[Melidrop] Available code attributes:`, codeAttrOptions.map((a: any) => a.id));

                        if (barcode && codeAttrOptions.length > 0) {
                            seed[codeAttrOptions[0].id] = barcode;
                            console.log(`[Melidrop] Seeded ${codeAttrOptions[0].id} = ${barcode}`);
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
                                if (ma.id && ma.value_name &&
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
        }

        setValidationResults(nextValidations);
        setPublishingStatus(nextStatus);
        setPublishResults(nextResults);
        setCategoryAttributes(nextCategoryAttrs);
        setUserAttributes(prev => ({ ...prev, ...nextUserAttrs }));
        setIsProcessing(false);
        setStep(4);
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

    const buildItemPayload = (processed: ProcessedProduct) => {
        const product = loadedProducts.find(p => p.asin === processed.asin)!;
        const catId = selectedCategories[processed.asin]?.id;
        const title = editedTitles[processed.asin] || processed.optimizedTitle;
        const attrs = userAttributes[processed.asin] || {};

        // Extract product code from Amazon attributes (UPC, EAN, GTIN)
        const amazonAttrs = product.attributes || {};
        const barcode = amazonAttrs.item_barcode?.[0]?.value || amazonAttrs.ean?.[0]?.value;
        const userHasBarcode = barcode && Object.values(attrs).includes(barcode);

        const finalAttributes = [
            ...Object.entries(attrs)
                .filter(([id, v]) => v && id !== 'SELLER_SKU')
                .map(([id, value_name]) => ({ id, value_name })),
            { id: 'SELLER_SKU', value_name: processed.asin },
            ...(barcode && !userHasBarcode ? [{ id: 'UPC', value_name: barcode }] : [])
        ];

        const currency = product.currency || 'USD';
        const isUSD = currency.toUpperCase() !== 'MXN';
        const priceMXN = calculateMexicoPrice(product.price || 0, currency);

        // handling_time = días que Amazon tarda en entregar a tu bodega + días de preparación
        const prepKey     = isUSD ? 'melidrop_handling_time_usa'     : 'melidrop_handling_time_mx';
        const deliveryKey = isUSD ? 'melidrop_amazon_delivery_usa'   : 'melidrop_amazon_delivery_mx';
        const prepDays     = parseInt(localStorage.getItem(prepKey)     || (isUSD ? '7' : '3'));
        const deliveryDays = parseInt(localStorage.getItem(deliveryKey) || (isUSD ? '5' : '3'));
        const handlingTime = prepDays + deliveryDays;
        const availableQty = parseInt(localStorage.getItem('melidrop_default_stock') || '3');
        const warrantyMonths = parseInt(localStorage.getItem('melidrop_warranty_months') || '1');

        // Sanitize title: remove ML-forbidden chars, strip trailing punctuation from truncation
        const safeTitle = title
            .replace(/[<>|\\]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[,;:\-]+$/, '')
            .substring(0, 60)
            .trim();

        // Derive family_name for categories that require it
        const withHoodAttr = finalAttributes.find(a => a.id === 'WITH_HOOD')?.value_name;
        const familyName = withHoodAttr === 'Sí'
            ? 'Toalla con Capucha'
            : undefined;

        const baseDescription = product.description
            ? product.description.substring(0, 2000)
            : `${product.title}. Producto nuevo, condición original de fábrica.`;
        const descriptionSuffix = localStorage.getItem('melidrop_description_suffix') ||
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
        const descriptionText = descriptionSuffix
            ? `${baseDescription}\n\n${descriptionSuffix}`.substring(0, 5000)
            : baseDescription;
        // Deduplicate by normalized URL (strip size tokens + query strings)
        const seenNormalized = new Set<string>();
        const pictureUrls: string[] = [];
        for (const img of processed.images) {
            const norm = img.url.replace(/\._[A-Za-z0-9_,]+\./, '.').split('?')[0];
            if (!seenNormalized.has(norm)) { seenNormalized.add(norm); pictureUrls.push(img.url); }
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
                { id: 'MANUFACTURING_TIME', value_name: `${handlingTime} días` }
            ],
            shipping: {
                mode: 'me2',
                free_shipping: true,
                local_pick_up: false
            }
        };

        return payload;
    };

    // ── Step 5 handlers ────────────────────────────────────────────────
    const handleDryRun = async (asin: string) => {
        const processed = processedProducts.find(p => p.asin === asin);
        if (!processed) return;

        setPublishingStatus(prev => ({ ...prev, [asin]: 'loading' }));
        try {
            const payload = buildItemPayload(processed);
            const validation = await meliService.validateItem(payload);

            let publishResult: any = null;
            let testMeliId: string | null = null;

            if (testUserCreds?.access_token) {
                try {
                    // ML tokens expire in 6h — always refresh before using test user token
                    let testToken = testUserCreds.access_token;
                    if (testUserCreds.email && testUserCreds.password) {
                        try {
                            const fresh = await meliService.loginTestUser(testUserCreds.email, testUserCreds.password);
                            if (fresh) {
                                testToken = fresh;
                                const { data: { user } } = await supabase.auth.getUser();
                                if (user) {
                                    const updated = { ...testUserCreds, access_token: fresh };
                                    await supabase.from('user_connections').upsert(
                                        { user_id: user.id, meli_test_user: updated },
                                        { onConflict: 'user_id' }
                                    );
                                    setTestUserCreds(updated);
                                }
                            }
                        } catch { /* use existing token */ }
                    }
                    const imageIds: string[] = [];
                    const seenUploadUrls = new Set<string>();
                    for (const img of processed.images.slice(0, 10)) {
                        const dedupeKey = img.cleanedUrl || img.url;
                        if (seenUploadUrls.has(dedupeKey)) continue;
                        seenUploadUrls.add(dedupeKey);
                        const id = img.cleanedUrl
                            ? await meliService.uploadImageBinary(img.cleanedUrl, testToken)
                            : await meliService.uploadImage(img.url, testToken);
                        if (id && !imageIds.includes(id)) imageIds.push(id);
                    }
                    const testPayload = { ...payload };
                    if (imageIds.length > 0) {
                        (testPayload as any).pictures = imageIds.map((id: string) => ({ id }));
                    }
                    publishResult = await meliService.publishItem(testPayload, false, testToken);
                    if (publishResult?.id) {
                        testMeliId = publishResult.id;
                    }
                } catch (publishErr: any) {
                    publishResult = { error: publishErr.message };
                }
            }

            await api.testProducts.create({
                title: payload.title,
                asin: processed.asin,
                sku: processed.asin,
                price_mxn: payload.price,
                cost_usd: loadedProducts.find(p => p.asin === processed.asin)?.price || 0,
                image_url: processed.images[0]?.url,
                category: payload.category_id,
                status: 'active',
                ...(testMeliId ? { meli_id: testMeliId } : {})
            });

            const dryError = !testMeliId && testUserCreds?.access_token
                ? (publishResult?.error ?? 'Error desconocido al publicar en sandbox')
                : null;

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

    const handlePublish = async (asin: string, isDraft = false) => {
        const processed = processedProducts.find(p => p.asin === asin);
        if (!processed) return;

        setPublishingStatus(prev => ({ ...prev, [asin]: 'loading' }));
        try {
            // ML tokens expire in 6h — always refresh test user token before publishing
            let publishToken: string | undefined;
            if (testUserCreds?.access_token) {
                try {
                    if (testUserCreds.email && testUserCreds.password) {
                        const fresh = await meliService.loginTestUser(testUserCreds.email, testUserCreds.password);
                        if (fresh) {
                            publishToken = fresh;
                            const { data: { user } } = await supabase.auth.getUser();
                            if (user) {
                                const updated = { ...testUserCreds, access_token: fresh };
                                await supabase.from('user_connections').upsert(
                                    { user_id: user.id, meli_test_user: updated },
                                    { onConflict: 'user_id' }
                                );
                                setTestUserCreds(updated);
                            }
                        }
                    }
                } catch (refreshErr: any) {
                    console.warn('[Melidrop] Test user token refresh failed:', refreshErr.message);
                    publishToken = testUserCreds.access_token;
                }
            }

            const imageIds: string[] = [];
            const seenUploadUrls = new Set<string>();
            for (const img of processed.images.slice(0, 10)) {
                const dedupeKey = img.cleanedUrl || img.url;
                if (seenUploadUrls.has(dedupeKey)) continue;
                seenUploadUrls.add(dedupeKey);
                const id = img.cleanedUrl
                    ? await meliService.uploadImageBinary(img.cleanedUrl, publishToken)
                    : await meliService.uploadImage(img.url, publishToken);
                if (id && !imageIds.includes(id)) imageIds.push(id);
            }

            const payload = buildItemPayload(processed);
            if (imageIds.length > 0) {
                (payload as any).pictures = imageIds.map((id: string) => ({ id }));
            }

            const result = await meliService.publishItem(payload, isDraft, publishToken);

            console.log(`[Melidrop] Publication response for ${asin}:`, result);

            if (result.error) {
                const causes: string[] = [];
                if (result.cause && Array.isArray(result.cause)) {
                    result.cause.forEach((c: any) => {
                        const field = c.field ? `[${c.field}] ` : '';
                        if (c.message) causes.push(`${field}${c.message}`);
                        else if (c.code || c.description) causes.push(`${field}${c.code ? `[${c.code}] ` : ''}${c.description || ''}`);
                        else causes.push(field + JSON.stringify(c));
                    });
                }
                const msg = causes.length > 0 ? `${result.error}\n• ${causes.join('\n• ')}` : result.error;
                setPublishResults(prev => ({ ...prev, [asin]: { error: msg, raw: result } }));
                setPublishingStatus(prev => ({ ...prev, [asin]: 'error' }));
            } else {
                setPublishResults(prev => ({ ...prev, [asin]: result }));
                setPublishingStatus(prev => ({ ...prev, [asin]: 'success' }));

                // Persist the product to Supabase so the updater knows its currency
                // and description without having to re-fetch from Amazon.
                if (result.id) {
                    const { data: { user } } = await supabase.auth.getUser();
                    if (user) {
                        const product = loadedProducts.find(p => p.asin === asin);
                        const { error: sbErr } = await supabase.from('products').upsert({
                            user_id:          user.id,
                            meli_id:          result.id,
                            title:            result.title || payload.title || processed.optimizedTitle,
                            sku:              processed.asin,
                            price_mxn:        payload.price,
                            stock_meli:       payload.available_quantity,
                            status:           isDraft ? 'inactive' : 'active',
                            image_url:        processed.images[0]?.url ?? null,
                            currency:         product?.currency ?? 'USD',
                            description_text: payload.description?.plain_text ?? null,
                            last_updated:     new Date().toISOString(),
                        }, { onConflict: 'meli_id' });
                        if (sbErr) console.warn('[Melidrop] Supabase upsert error:', sbErr.message);
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
        // Step 3
        processedProducts,
        editedTitles, setEditedTitles,
        selectedCategories, setSelectedCategories,
        mlCategorySearchResults,
        processingStage,
        isProcessing,
        handleProcessWithAI,
        // Step 4
        categoryAttributes,
        userAttributes, setUserAttributes,
        validationResults,
        handleLoadAttributes,
        // Step 5
        publishingStatus,
        publishResults,
        dryRunResults,
        testUserCreds,
        handleDryRun,
        handlePublish,
        // Helpers
        calculateMexicoPrice,
        buildItemPayload,
    };
}
