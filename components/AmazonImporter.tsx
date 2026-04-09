import React, { useState, useCallback } from 'react';
import { amazonService } from '../services/amazonService';
import { aiImporterService, ProcessedProduct } from '../services/aiImporterService';
import { meliService } from '../services/meliService';
import { api } from '../services/api';
import { supabase } from '../services/supabase';
import { useEffect } from 'react';

// ─── Types ────────────────────────────────────────────────────────────
type Marketplace = 'MLM' | 'MLS';
type ListingType = 'gold_special' | 'gold_pro';
type Step = 1 | 2 | 3 | 4 | 5;

interface LoadedProduct {
    asin: string;
    title: string;
    description: string;
    brand: string;
    price: number;
    currency: string;
    imageUrl: string;
    images: string[];
    category: string;
    attributes: any;
    loading: boolean;
    error: string | null;
}

// ─── Step Indicator ───────────────────────────────────────────────────
const StepIndicator = ({ current, total }: { current: Step; total: number }) => {
    const steps = ['Configuración', 'ASINs', 'Procesar con IA', 'Atributos', 'Publicar'];
    return (
        <div className="flex items-center justify-between mb-8 px-2">
            {steps.map((label, i) => {
                const stepNum = (i + 1) as Step;
                const isCompleted = current > stepNum;
                const isActive = current === stepNum;
                return (
                    <React.Fragment key={stepNum}>
                        <div className="flex flex-col items-center gap-1">
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-black transition-all ${
                                isCompleted ? 'bg-green-500 text-white shadow-lg shadow-green-500/30' :
                                isActive ? 'bg-primary text-white shadow-lg shadow-primary/30 scale-110' :
                                'bg-slate-100 dark:bg-slate-800 text-slate-400'
                            }`}>
                                {isCompleted ? <span className="material-symbols-outlined text-[18px]">check</span> : stepNum}
                            </div>
                            <span className={`text-[9px] font-black uppercase tracking-wider text-center w-16 ${
                                isActive ? 'text-primary' : isCompleted ? 'text-green-500' : 'text-slate-400'
                            }`}>{label}</span>
                        </div>
                        {i < steps.length - 1 && (
                            <div className={`flex-1 h-0.5 mx-1 transition-all ${isCompleted ? 'bg-green-400' : 'bg-slate-200 dark:bg-slate-700'}`} />
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
};

// ─── Main Component ───────────────────────────────────────────────────
export const AmazonImporter: React.FC = () => {
    const [step, setStep] = useState<Step>(1);

    // Step 1 State
    const [marketplace, setMarketplace] = useState<Marketplace>('MLM');
    const [listingType, setListingType] = useState<ListingType>('gold_special');
    const [autoCategory, setAutoCategory] = useState(true);
    const [cleanImages, setCleanImages] = useState(false);

    // Step 2 State
    const [asinInput, setAsinInput] = useState('');
    const [loadedProducts, setLoadedProducts] = useState<LoadedProduct[]>([]);
    const [loadingAsins, setLoadingAsins] = useState(false);

    // Step 3 State
    const [processedProducts, setProcessedProducts] = useState<ProcessedProduct[]>([]);
    const [editedTitles, setEditedTitles] = useState<Record<string, string>>({});
    const [selectedCategories, setSelectedCategories] = useState<Record<string, { id: string; name: string }>>({});
    const [mlCategorySearchResults, setMlCategorySearchResults] = useState<Record<string, any[]>>({});
    const [processingStage, setProcessingStage] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    // Step 4 State
    const [categoryAttributes, setCategoryAttributes] = useState<Record<string, any[]>>({});
    const [userAttributes, setUserAttributes] = useState<Record<string, Record<string, string>>>({});
    const [validationResults, setValidationResults] = useState<Record<string, { isDuplicate: boolean; hasForbiddenWords: boolean; forbiddenWord?: string }>>({});

    // Step 5 State
    const [publishingStatus, setPublishingStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({});
    const [publishResults, setPublishResults] = useState<Record<string, any>>({});
    const [dryRunResults, setDryRunResults] = useState<Record<string, any>>({});
    const [testUserCreds, setTestUserCreds] = useState<any>(null);

    useEffect(() => {
        const fetchTestUser = async () => {
            const { data } = await supabase.from('user_connections').select('meli_test_user').maybeSingle();
            if (data?.meli_test_user) {
                setTestUserCreds(data.meli_test_user);
            }
        };
        fetchTestUser();
    }, []);

    // ─── Guard: Amazon must be connected ────────────────────────────
    if (!amazonService.isAuthenticated()) {
        return (
            <div className="flex-1 overflow-auto p-6 flex items-center justify-center">
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-8 text-center max-w-md">
                    <span className="material-symbols-outlined text-amber-500 text-5xl mb-4 block">storefront</span>
                    <h3 className="text-lg font-black text-amber-900 dark:text-amber-100 mb-2">Amazon no está conectado</h3>
                    <p className="text-sm text-amber-700 dark:text-amber-300 mb-4">
                        Ve a <strong>Configuración</strong> e ingresa tus credenciales de Amazon Seller API.
                    </p>
                    <a href="/configuracion" className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-bold transition-colors shadow-sm shadow-amber-500/30">
                        <span className="material-symbols-outlined text-[18px]">settings</span>Ir a Configuración
                    </a>
                </div>
            </div>
        );
    }

    // ─── Step 2: Load Products ────────────────────────────────────────
    const handleLoadAsins = async () => {
        const asins = asinInput.split(/[\n,\s]+/).map(a => a.trim().toUpperCase()).filter(a => /^[A-Z0-9]{10}$/.test(a));
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
                    images: product.imageUrl ? [product.imageUrl] : [],
                    category: product.category || '',
                    attributes: product.attributes || {},
                    loading: false,
                    error: null
                } : p));
            } catch (e: any) {
                setLoadedProducts(prev => prev.map(p => p.asin === asin ? { ...p, loading: false, error: e.message } : p));
            }
        }
        setLoadingAsins(false);
    };

    // ─── Step 3: AI Processing ────────────────────────────────────────
    const handleProcessWithAI = async () => {
        const validProducts = loadedProducts.filter(p => !p.loading && !p.error);
        if (validProducts.length === 0) return;

        setIsProcessing(true);
        const results: ProcessedProduct[] = [];

        for (const product of validProducts) {
            setProcessingStage(`Procesando "${product.title.substring(0, 30)}..."`);

            // Get ML category predictions to enrich AI suggestion
            let requiredAttrs: any[] = [];
            const processed = await aiImporterService.processProduct(product, marketplace, requiredAttrs, cleanImages);

            // Search ML for actual category ID
            setProcessingStage(`Buscando categoría en MercadoLibre...`);
            const mlPredictions = await meliService.predictCategory(processed.categorySuggestion.search_term, marketplace);

            if (mlPredictions && mlPredictions.length > 0) {
                setMlCategorySearchResults(prev => ({ ...prev, [product.asin]: mlPredictions }));
                const topPred = mlPredictions[0];
                setSelectedCategories(prev => ({
                    ...prev,
                    [product.asin]: { id: topPred.category_id || topPred.id, name: topPred.category_name || topPred.domain_name }
                }));
            }

            results.push(processed);
            setEditedTitles(prev => ({ ...prev, [product.asin]: processed.optimizedTitle }));
        }

        setProcessedProducts(results);
        setIsProcessing(false);
    };

    // ─── Step 4: Load Attributes & Validate ──────────────────────────
    const handleLoadAttributes = async () => {
        const rawFilters = localStorage.getItem('melidrop_global_filters') || "Nike\nAdidas\nReacondicionado";
        const forbiddenWords: string[] = rawFilters
            .split('\n')
            .map((w: string) => w.trim().toLowerCase())
            .filter(Boolean);

        for (const processed of processedProducts) {
            const catId = selectedCategories[processed.asin]?.id;

            // Check duplicates
            const dupCheck = await meliService.checkDuplicate(processed.asin);

            // Check forbidden words
            const titleToCheck = (editedTitles[processed.asin] || processed.optimizedTitle).toLowerCase();
            const hasForbiddenWords = forbiddenWords.some(w => titleToCheck.includes(w));
            const forbiddenWord = forbiddenWords.find(w => titleToCheck.includes(w));

            setValidationResults(prev => ({
                ...prev,
                [processed.asin]: { isDuplicate: dupCheck.isDuplicate, hasForbiddenWords, forbiddenWord }
            }));

            // Load ML required attrs
            if (catId) {
                const attrs = await meliService.getCategoryAttributes(catId);
                const required = attrs.filter((a: any) => a.tags?.required);
                setCategoryAttributes(prev => ({ ...prev, [processed.asin]: required }));

                // Apply AI-suggested attrs as defaults
                const defaultAttrs: Record<string, string> = {};
                (processed.mappedAttributes || []).forEach((ma: any) => {
                    defaultAttrs[ma.id] = ma.value_name;
                });
                setUserAttributes(prev => ({ ...prev, [processed.asin]: { ...defaultAttrs, ...(prev[processed.asin] || {}) } }));
            }
        }
    };

    // ─── Step 5: Dry Run & Publish ────────────────────────────────────
    // ─── Pricing helpers ──────────────────────────────────────────────
    const calculateMexicoPrice = (costUSD: number): number => {
        const exchangeRate = parseFloat(localStorage.getItem('melidrop_exchange_rate') || '18.5');
        const savedRulesRaw = localStorage.getItem('melidrop_usa_rules');
        const rules: Array<{ min: number; max: number | null; margin: number }> = savedRulesRaw
            ? JSON.parse(savedRulesRaw)
            : [{ min: 0, max: 20, margin: 200 }, { min: 21, max: 50, margin: 100 }, { min: 51, max: null, margin: 50 }];

        // Find matching rule tier
        const rule = rules.find(r => costUSD >= r.min && (r.max === null || costUSD <= r.max))
            || rules[rules.length - 1]; // fallback to last rule

        const margin = rule?.margin ?? 50;
        const costMXN = costUSD * exchangeRate;
        const priceMXN = costMXN * (1 + margin / 100);
        return Math.ceil(priceMXN);
    };

    const buildItemPayload = (processed: ProcessedProduct) => {
        const product = loadedProducts.find(p => p.asin === processed.asin)!;
        const catId = selectedCategories[processed.asin]?.id;
        const title = editedTitles[processed.asin] || processed.optimizedTitle;
        const attrs = userAttributes[processed.asin] || {};

        // Ensure ASIN is exactly the SKU
        const finalAttributes = [
            ...Object.entries(attrs)
                .filter(([id, v]) => v && id !== 'SELLER_SKU')
                .map(([id, value_name]) => ({ id, value_name })),
            { id: 'SELLER_SKU', value_name: processed.asin }
        ];

        const costUSD = product.price || 0;
        const priceMXN = calculateMexicoPrice(costUSD);

        return {
            title,
            category_id: catId,
            price: priceMXN,
            currency_id: marketplace === 'MLM' ? 'MXN' : 'USD',
            available_quantity: 10,
            buying_mode: 'buy_it_now',
            listing_type_id: listingType,
            condition: 'new',
            seller_custom_field: processed.asin,
            pictures: processed.images.slice(0, 10).map(img => ({ source: img.url })),
            attributes: finalAttributes
        };
    };

    const handleDryRun = async () => {
        setIsDryRunning(true);
        for (const processed of processedProducts) {
            const payload = buildItemPayload(processed);
            
            try {
                // Validate with Meli
                const validation = await meliService.validateItem(payload);
                
                let publishResult = null;
                // If a test user is connected, REALLY publish to the test user's account
                if (testUserCreds?.access_token) {
                    try {
                        // Upload images to ML first for the test user
                        const imageIds: string[] = [];
                        for (const img of processed.images.slice(0, 10)) {
                            const id = await meliService.uploadImage(img.url, testUserCreds.access_token);
                            if (id) imageIds.push(id);
                        }
                        
                        const testPayload = { ...payload };
                        if (imageIds.length > 0) {
                            (testPayload as any).pictures = imageIds.map((id: string) => ({ id }));
                        }
                        
                        publishResult = await meliService.publishItem(testPayload, false, testUserCreds.access_token);
                    } catch (publishErr) {
                        console.error("Test publish error:", publishErr);
                    }
                }

                // Save to Sandbox Catalog in Supabase for local visibility
                await api.testProducts.create({
                    title: payload.title,
                    asin: processed.asin,
                    sku: processed.asin,
                    price_mxn: payload.price,
                    cost_usd: loadedProducts.find(p => p.asin === processed.asin)?.price || 0,
                    image_url: processed.images[0]?.url,
                    category: payload.category_id,
                    status: 'active'
                });

                setDryRunResults(prev => ({ ...prev, [processed.asin]: { payload, validation, testPublish: publishResult } }));
            } catch (err) {
                console.error("Dry Run error:", err);
            }
        }
        setIsDryRunning(false);
    };

    const handlePublish = async (asin: string, isDraft: boolean = false) => {
        const processed = processedProducts.find(p => p.asin === asin);
        if (!processed) return;

        setPublishingStatus(prev => ({ ...prev, [asin]: 'loading' }));
        try {
            // Upload images to ML first
            const imageIds: string[] = [];
            for (const img of processed.images.slice(0, 10)) {
                const id = await meliService.uploadImage(img.url);
                if (id) imageIds.push(id);
            }

            const payload = buildItemPayload(processed);
            if (imageIds.length > 0) {
                (payload as any).pictures = imageIds.map((id: string) => ({ id }));
            }

            const result = await meliService.publishItem(payload, isDraft);
            setPublishResults(prev => ({ ...prev, [asin]: result }));
            setPublishingStatus(prev => ({ ...prev, [asin]: 'success' }));
        } catch (e: any) {
            setPublishResults(prev => ({ ...prev, [asin]: { error: e.message } }));
            setPublishingStatus(prev => ({ ...prev, [asin]: 'error' }));
        }
    };

    // ─── RENDER ───────────────────────────────────────────────────────
    return (
        <div className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-900">
            <div className="max-w-5xl mx-auto p-6">
                {/* Header */}
                <div className="mb-6">
                    <h1 className="text-2xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                        <span className="text-2xl">📦</span>
                        Importador Amazon → MercadoLibre
                    </h1>
                    <p className="text-sm text-slate-500 mt-1">Importa productos con optimización de IA en 5 pasos</p>
                </div>

                {/* Step Indicator */}
                <StepIndicator current={step} total={5} />

                {/* ── STEP 1: Config ─────────────────────────────────── */}
                {step === 1 && (
                    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 space-y-6">
                        <h2 className="text-lg font-black text-slate-900 dark:text-white">Configuración de Importación</h2>

                        {/* Marketplace */}
                        <div>
                            <label className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 block">Marketplace Destino</label>
                            <div className="grid grid-cols-2 gap-3">
                                {[{ id: 'MLM', label: '🇲🇽 MercadoLibre México', desc: 'Pesos MXN' }, { id: 'MLS', label: '🇺🇸 MercadoLibre USA', desc: 'Dólares USD' }].map(m => (
                                    <button
                                        key={m.id}
                                        onClick={() => setMarketplace(m.id as Marketplace)}
                                        className={`p-4 rounded-xl border-2 text-left transition-all ${marketplace === m.id ? 'border-primary bg-primary/5 shadow-sm shadow-primary/20' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}
                                    >
                                        <p className="font-bold text-slate-900 dark:text-white text-sm">{m.label}</p>
                                        <p className="text-xs text-slate-500 mt-0.5">{m.desc}</p>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Listing Type */}
                        <div>
                            <label className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 block">Tipo de Publicación</label>
                            <div className="grid grid-cols-2 gap-3">
                                {[
                                    { id: 'gold_special', label: '⚡ Clásica', desc: 'Sin mercadoenvíos gratis, menor comisión', commission: '~8%' },
                                    { id: 'gold_pro', label: '🥇 Premium', desc: 'Con envío gratis, mayor exposición', commission: '~13%' }
                                ].map(lt => (
                                    <button
                                        key={lt.id}
                                        onClick={() => setListingType(lt.id as ListingType)}
                                        className={`p-4 rounded-xl border-2 text-left transition-all ${listingType === lt.id ? 'border-primary bg-primary/5 shadow-sm shadow-primary/20' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}
                                    >
                                        <p className="font-bold text-slate-900 dark:text-white text-sm">{lt.label}</p>
                                        <p className="text-xs text-slate-500 mt-0.5">{lt.desc}</p>
                                        <span className="inline-block mt-2 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] font-bold px-2 py-0.5 rounded-full">Comisión {lt.commission}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* AI Options */}
                        <div className="border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-3">
                            <p className="text-xs font-black text-slate-500 uppercase tracking-widest">Opciones de IA</p>
                            <label className="flex items-center justify-between cursor-pointer">
                                <div>
                                    <p className="text-sm font-bold text-slate-900 dark:text-white">🤖 Detectar categoría automáticamente</p>
                                    <p className="text-xs text-slate-500">Gemini analiza el producto y elige la categoría correcta de ML</p>
                                </div>
                                <div
                                    onClick={() => setAutoCategory(!autoCategory)}
                                    className={`w-12 h-6 rounded-full transition-all cursor-pointer relative ${autoCategory ? 'bg-primary' : 'bg-slate-200 dark:bg-slate-700'}`}
                                >
                                    <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${autoCategory ? 'left-6' : 'left-0.5'}`} />
                                </div>
                            </label>
                            <div className="border-t border-slate-100 dark:border-slate-700/50 pt-3">
                                <label className="flex items-center justify-between cursor-pointer">
                                    <div>
                                        <p className="text-sm font-bold text-slate-900 dark:text-white">🖼️ Limpiar imágenes con IA</p>
                                        <p className="text-xs text-slate-500">Detecta datos de contacto en fotos • ~$0.01 USD por producto</p>
                                    </div>
                                    <div
                                        onClick={() => setCleanImages(!cleanImages)}
                                        className={`w-12 h-6 rounded-full transition-all cursor-pointer relative flex-shrink-0 ml-4 ${cleanImages ? 'bg-primary' : 'bg-slate-200 dark:bg-slate-700'}`}
                                    >
                                        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${cleanImages ? 'left-6' : 'left-0.5'}`} />
                                    </div>
                                </label>
                            </div>
                        </div>

                        <button
                            onClick={() => setStep(2)}
                            className="w-full py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all shadow-sm shadow-primary/30 flex items-center justify-center gap-2"
                        >
                            Continuar <span className="material-symbols-outlined">arrow_forward</span>
                        </button>
                    </div>
                )}

                {/* ── STEP 2: ASINs ──────────────────────────────────── */}
                {step === 2 && (
                    <div className="space-y-4">
                        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-1">Ingresa los ASINs</h2>
                            <p className="text-sm text-slate-500 mb-4">Uno o varios ASINs, uno por línea o separados por comas</p>
                            <textarea
                                value={asinInput}
                                onChange={e => setAsinInput(e.target.value)}
                                rows={4}
                                placeholder="B08N5WRWNW&#10;B09G9HDQLR&#10;B07ZPKBL9V"
                                className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white font-mono text-sm focus:ring-2 focus:ring-primary focus:border-transparent resize-none"
                            />
                            <button
                                onClick={handleLoadAsins}
                                disabled={loadingAsins || !asinInput.trim()}
                                className="mt-3 w-full py-3 bg-slate-900 dark:bg-white dark:text-slate-900 text-white font-black rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {loadingAsins ? <><span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />Cargando...</> : <><span className="material-symbols-outlined">cloud_download</span>Cargar Productos</>}
                            </button>
                        </div>

                        {/* Product Cards */}
                        {loadedProducts.length > 0 && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                {loadedProducts.map(p => (
                                    <div key={p.asin} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 flex gap-3">
                                        {p.loading ? (
                                            <div className="flex items-center gap-3 w-full">
                                                <div className="w-16 h-16 rounded-lg bg-slate-100 dark:bg-slate-700 animate-pulse flex-shrink-0" />
                                                <div className="flex-1 space-y-2">
                                                    <div className="h-3 bg-slate-100 dark:bg-slate-700 rounded animate-pulse" />
                                                    <div className="h-3 bg-slate-100 dark:bg-slate-700 rounded animate-pulse w-2/3" />
                                                </div>
                                            </div>
                                        ) : p.error ? (
                                            <div className="flex items-center gap-2 text-red-500 text-sm w-full">
                                                <span className="material-symbols-outlined">error</span>
                                                <div className="flex-1 min-w-0">
                                                    <p className="font-bold text-slate-900 dark:text-white text-xs line-clamp-2">{p.title || <span className="text-amber-500 italic">Sin título (error de API)</span>}</p>
                                                    <p className="text-[10px] text-slate-400 mt-1 font-mono">{p.asin}</p>
                                                    {p.images.length > 0 && <p className="text-[10px] text-blue-500 mt-0.5">{p.images.length} foto(s)</p>}
                                                    {p.price > 0 && (
                                                        <div className="mt-1 flex flex-col gap-0.5">
                                                            <p className="text-[10px] text-slate-400">Costo: <span className="font-bold text-slate-600 dark:text-slate-300">${p.price.toFixed(2)} {p.currency}</span></p>
                                                            <p className="text-[10px] text-green-600 font-black">Venta ML: ${((): number => {
                                                                const ex = parseFloat(localStorage.getItem('melidrop_exchange_rate') || '18.5');
                                                                const raw = localStorage.getItem('melidrop_usa_rules');
                                                                const rules: any[] = raw ? JSON.parse(raw) : [{ min: 0, max: null, margin: 100 }];
                                                                const rule = rules.find((r: any) => p.price >= r.min && (r.max === null || p.price <= r.max)) || rules[rules.length - 1];
                                                                return Math.ceil(p.price * ex * (1 + (rule?.margin ?? 100) / 100));
                                                            })().toLocaleString()} MXN</p>
                                                        </div>
                                                    )}
                                                    <span className="inline-block mt-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-[9px] font-bold px-2 py-0.5 rounded-full">✓ Cargado</span>
                                                </div>
                                            </div>
                                        ) : (
                                            <>
                                                {p.imageUrl ? (
                                                    <img src={p.imageUrl} alt={p.title} className="w-16 h-16 object-cover rounded-lg flex-shrink-0 border border-slate-100 dark:border-slate-700" />
                                                ) : (
                                                    <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 rounded-lg flex-shrink-0 flex items-center justify-center">
                                                        <span className="material-symbols-outlined text-slate-400">image</span>
                                                    </div>
                                                )}
                                                <div className="flex-1 min-w-0">
                                                    <p className="font-bold text-slate-900 dark:text-white text-xs line-clamp-2">{p.title}</p>
                                                    <p className="text-[10px] text-slate-400 mt-1 font-mono">{p.asin}</p>
                                                    {p.price > 0 && <p className="text-xs font-black text-green-600 mt-1">${p.price.toFixed(2)} {p.currency}</p>}
                                                    <span className="inline-block mt-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-[9px] font-bold px-2 py-0.5 rounded-full">✓ Cargado</span>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="flex gap-3">
                            <button onClick={() => setStep(1)} className="flex-1 py-3 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                                Atrás
                            </button>
                            <button
                                onClick={async () => { await handleProcessWithAI(); setStep(3); }}
                                disabled={loadedProducts.filter(p => !p.loading && !p.error).length === 0}
                                className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                Procesar con IA <span className="material-symbols-outlined">auto_awesome</span>
                            </button>
                        </div>
                    </div>
                )}

                {/* ── STEP 3: AI Processing ───────────────────────────── */}
                {step === 3 && (
                    <div className="space-y-4">
                        {isProcessing && (
                            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-2xl p-6 flex items-center gap-4">
                                <div className="w-8 h-8 rounded-full border-4 border-blue-200 border-t-blue-500 animate-spin flex-shrink-0" />
                                <div>
                                    <p className="font-black text-blue-900 dark:text-blue-100">Gemini está analizando tus productos...</p>
                                    <p className="text-sm text-blue-600 dark:text-blue-400 mt-0.5">{processingStage}</p>
                                </div>
                            </div>
                        )}

                        {processedProducts.map(processed => {
                            const mlCats = mlCategorySearchResults[processed.asin] || [];
                            return (
                                <div key={processed.asin} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                                    <div className="bg-gradient-to-r from-primary/10 to-transparent p-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                                        <div>
                                            <p className="font-black text-slate-900 dark:text-white text-sm">ASIN: {processed.asin}</p>
                                            {processed.errors.length > 0 && <p className="text-xs text-amber-600 mt-0.5">{processed.errors.join(' · ')}</p>}
                                        </div>
                                        <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-[10px] font-black px-3 py-1 rounded-full uppercase">✓ Procesado</span>
                                    </div>

                                    <div className="p-4 space-y-4">
                                        {/* Title optimization */}
                                        <div>
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Título para MercadoLibre</label>
                                            <div className="mt-1 flex items-start gap-2">
                                                <input
                                                    maxLength={60}
                                                    value={editedTitles[processed.asin] || processed.optimizedTitle}
                                                    onChange={e => setEditedTitles(prev => ({ ...prev, [processed.asin]: e.target.value }))}
                                                    className="flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-900 dark:text-white font-medium focus:ring-2 focus:ring-primary focus:border-transparent"
                                                />
                                                <span className={`text-[10px] font-black ${(editedTitles[processed.asin] || processed.optimizedTitle).length > 55 ? 'text-red-500' : 'text-slate-400'} mt-2 flex-shrink-0`}>
                                                    {(editedTitles[processed.asin] || processed.optimizedTitle).length}/60
                                                </span>
                                            </div>
                                            <p className="text-[10px] text-slate-400 mt-1">Original: {processed.originalTitle.substring(0, 80)}...</p>
                                        </div>

                                        {/* Category */}
                                        <div>
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Categoría MercadoLibre</label>
                                            <div className="mt-1 flex items-center gap-2">
                                                <span className="text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full font-bold flex-shrink-0">
                                                    {Math.round((processed.categorySuggestion.confidence || 0) * 100)}% conf.
                                                </span>
                                                <span className="text-sm font-bold text-slate-900 dark:text-white">{selectedCategories[processed.asin]?.name || processed.categorySuggestion.category_name}</span>
                                            </div>
                                            {mlCats.length > 0 && (
                                                <div className="mt-2 flex flex-wrap gap-1">
                                                    {mlCats.slice(0, 4).map((cat: any) => (
                                                        <button
                                                            key={cat.category_id || cat.id}
                                                            onClick={() => setSelectedCategories(prev => ({ ...prev, [processed.asin]: { id: cat.category_id || cat.id, name: cat.category_name || cat.domain_name } }))}
                                                            className={`text-[10px] font-bold px-2 py-1 rounded-lg border transition-all ${selectedCategories[processed.asin]?.id === (cat.category_id || cat.id) ? 'bg-primary text-white border-primary' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-primary'}`}
                                                        >
                                                            {cat.category_name || cat.domain_name}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Images */}
                                        {processed.images.length > 0 && (
                                            <div>
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Imágenes ({processed.images.length})</label>
                                                <div className="mt-1 flex gap-2 flex-wrap">
                                                    {processed.images.slice(0, 6).map((img, i) => (
                                                        <div key={i} className="relative">
                                                            <img src={img.url} alt={`img-${i}`} className="w-12 h-12 object-cover rounded-lg border border-slate-200 dark:border-slate-700" />
                                                            {img.checked && img.hasContactInfo && (
                                                                <div className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full flex items-center justify-center">
                                                                    <span className="material-symbols-outlined text-white text-[10px]">warning</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}

                        <div className="flex gap-3" style={{ display: isProcessing ? 'none' : 'flex' }}>
                            <button onClick={() => setStep(2)} className="flex-1 py-3 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">Atrás</button>
                            <button
                                onClick={async () => { 
                                    try {
                                        await handleLoadAttributes(); 
                                    } catch (e) {
                                        console.error("Error loading attributes:", e);
                                    }
                                    setStep(4); 
                                }}
                                disabled={processedProducts.length === 0}
                                className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                Revisar Atributos <span className="material-symbols-outlined">arrow_forward</span>
                            </button>
                        </div>
                    </div>
                )}

                {/* ── STEP 4: Attributes & Validation ─────────────────── */}
                {step === 4 && (
                    <div className="space-y-4">
                        {processedProducts.map(processed => {
                            const val = validationResults[processed.asin];
                            const attrs = categoryAttributes[processed.asin] || [];
                            const userAttrs = userAttributes[processed.asin] || {};

                            return (
                                <div key={processed.asin} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                                    <div className="p-4 border-b border-slate-100 dark:border-slate-700">
                                        <p className="font-black text-slate-900 dark:text-white">{editedTitles[processed.asin]}</p>
                                        <p className="text-xs text-slate-500 font-mono mt-0.5">{processed.asin}</p>
                                    </div>

                                    {/* Validations */}
                                    {val && (
                                        <div className="px-4 py-3 space-y-1.5 border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
                                            <div className={`flex items-center gap-2 text-xs font-bold ${val.isDuplicate ? 'text-red-500' : 'text-green-600'}`}>
                                                <span className="material-symbols-outlined text-[16px]">{val.isDuplicate ? 'error' : 'check_circle'}</span>
                                                {val.isDuplicate ? '⚠️ Ya tienes este ASIN publicado en MercadoLibre' : '✓ No es duplicado'}
                                            </div>
                                            <div className={`flex items-center gap-2 text-xs font-bold ${val.hasForbiddenWords ? 'text-red-500' : 'text-green-600'}`}>
                                                <span className="material-symbols-outlined text-[16px]">{val.hasForbiddenWords ? 'error' : 'check_circle'}</span>
                                                {val.hasForbiddenWords ? `⚠️ Contiene palabra prohibida: "${val.forbiddenWord}"` : '✓ Sin palabras prohibidas'}
                                            </div>
                                        </div>
                                    )}

                                    {/* Required Attributes */}
                                    <div className="p-4">
                                        {attrs.length === 0 ? (
                                            <p className="text-sm text-slate-400 italic">No se encontraron atributos requeridos para esta categoría.</p>
                                        ) : (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                                {attrs.slice(0, 16).map((attr: any) => (
                                                    <div key={attr.id}>
                                                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider">
                                                            {attr.name} {attr.tags?.required && <span className="text-red-500">*</span>}
                                                        </label>
                                                        {attr.values && attr.values.length > 0 ? (
                                                            <select
                                                                value={userAttrs[attr.id] || ''}
                                                                onChange={e => setUserAttributes(prev => ({ ...prev, [processed.asin]: { ...prev[processed.asin], [attr.id]: e.target.value } }))}
                                                                className="mt-1 w-full px-2 py-1.5 border border-slate-300 dark:border-slate-600 rounded-lg text-xs bg-white dark:bg-slate-900 dark:text-white focus:ring-1 focus:ring-primary"
                                                            >
                                                                <option value="">Seleccionar...</option>
                                                                {attr.values.slice(0, 20).map((v: any) => (
                                                                    <option key={v.id} value={v.name}>{v.name}</option>
                                                                ))}
                                                            </select>
                                                        ) : (
                                                            <input
                                                                type="text"
                                                                value={userAttrs[attr.id] || ''}
                                                                onChange={e => setUserAttributes(prev => ({ ...prev, [processed.asin]: { ...prev[processed.asin], [attr.id]: e.target.value } }))}
                                                                placeholder={attr.hint || `Ingresa ${attr.name}`}
                                                                className="mt-1 w-full px-2 py-1.5 border border-slate-300 dark:border-slate-600 rounded-lg text-xs bg-white dark:bg-slate-900 dark:text-white focus:ring-1 focus:ring-primary"
                                                            />
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}

                        <div className="flex gap-3">
                            <button onClick={() => setStep(3)} className="flex-1 py-3 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">Atrás</button>
                            <button
                                onClick={() => setStep(5)}
                                className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all flex items-center justify-center gap-2"
                            >
                                Confirmar y Publicar <span className="material-symbols-outlined">arrow_forward</span>
                            </button>
                        </div>
                    </div>
                )}

                {/* ── STEP 5: Publish ─────────────────────────────────── */}
                {step === 5 && (
                    <div className="space-y-4">
                        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-1">Confirmar Publicación</h2>
                            <p className="text-sm text-slate-500 mb-4">Revisa el resumen antes de publicar</p>

                            <div className="space-y-3">
                                {processedProducts.map(processed => {
                                    const status = publishingStatus[processed.asin];
                                    const result = publishResults[processed.asin];
                                    const dry = dryRunResults[processed.asin];

                                    return (
                                        <div key={processed.asin} className="border border-slate-200 dark:border-slate-700 rounded-xl p-4">
                                            <div className="flex items-start justify-between gap-4 mb-3">
                                                <div className="flex-1 min-w-0">
                                                    <p className="font-bold text-slate-900 dark:text-white text-sm">{editedTitles[processed.asin]}</p>
                                                    <p className="text-[10px] text-slate-400 font-mono mt-0.5">
                                                        {processed.asin} · {selectedCategories[processed.asin]?.name} · {listingType === 'gold_special' ? 'Clásica' : 'Premium'}
                                                    </p>
                                                </div>
                                                {status === 'success' && <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-[10px] font-black px-3 py-1 rounded-full flex-shrink-0">✓ Publicado</span>}
                                                {status === 'error' && <span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-[10px] font-black px-3 py-1 rounded-full flex-shrink-0">✗ Error</span>}
                                            </div>

                                            {/* Dry run result */}
                                            {dry && (
                                                <div className="mb-3 bg-slate-50 dark:bg-slate-900 rounded-lg p-3">
                                                    <p className="text-[10px] font-black text-slate-500 uppercase mb-1">Resultado de Validación</p>
                                                    <div className="flex gap-2">
                                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${dry.validation?.valid ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                                            {dry.validation?.valid ? '✓ Válido' : '✗ Con errores'}
                                                        </span>
                                                    </div>
                                                    {dry.validation?.errors?.length > 0 && (
                                                        <p className="text-[10px] text-red-500 mt-1">{dry.validation.errors.map((e: any) => e.message || JSON.stringify(e)).join(', ')}</p>
                                                    )}
                                                </div>
                                            )}

                                            {/* Publish result */}
                                            {result?.id && (
                                                <a href={`https://articulo.mercadolibre.com.mx/${result.id}`} target="_blank" rel="noopener noreferrer"
                                                    className="text-xs text-primary font-bold hover:underline flex items-center gap-1 mb-2">
                                                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                                                    Ver en MercadoLibre: {result.id}
                                                </a>
                                            )}
                                            {result?.error && <p className="text-xs text-red-500 font-mono">{result.error}</p>}

                                            {/* Action Buttons */}
                                            {!status || status === 'idle' ? (
                                                <div className="flex gap-2">
                                                    <button
                                                        onClick={handleDryRun}
                                                        className="flex-1 py-2 border-2 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 font-bold rounded-lg text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-all flex items-center justify-center gap-1"
                                                    >
                                                        <span className="material-symbols-outlined text-[16px]">science</span>Probar (Validar)
                                                    </button>
                                                    <button
                                                        onClick={() => handlePublish(processed.asin, false)}
                                                        disabled={!!validationResults[processed.asin]?.hasForbiddenWords}
                                                        className="flex-1 py-2 bg-green-600 hover:bg-green-700 text-white font-black rounded-lg text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-1 shadow-sm shadow-green-600/30"
                                                    >
                                                        <span className="material-symbols-outlined text-[16px]">rocket_launch</span>Publicar en ML
                                                    </button>
                                                </div>
                                            ) : status === 'loading' ? (
                                                <div className="flex items-center gap-2 text-sm text-slate-500">
                                                    <span className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-primary animate-spin" />
                                                    Publicando...
                                                </div>
                                            ) : null}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Results Summary (Improved based on design) */}
                        {Object.keys(publishingStatus).length > 0 && (
                            <div className="space-y-6 animate-fade-in mt-8">
                                <div className="bg-white dark:bg-slate-800 p-8 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                                    <h3 className="text-base font-black text-slate-900 dark:text-white mb-8 tracking-tight uppercase">Consolidado:</h3>
                                    
                                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                                        <div className="flex flex-col items-center text-center">
                                            <div className="size-12 bg-green-100 dark:bg-green-900/20 text-green-600 rounded-xl mb-3 flex items-center justify-center">
                                                <span className="material-symbols-outlined filled text-[24px]">check_box</span>
                                            </div>
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Publicados</span>
                                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">
                                                {Object.values(publishingStatus).filter(s => s === 'success').length}
                                            </span>
                                        </div>
                                        <div className="flex flex-col items-center text-center">
                                            <div className="size-12 bg-yellow-100 dark:bg-yellow-900/20 text-yellow-600 rounded-xl mb-3 flex items-center justify-center">
                                                <span className="material-symbols-outlined text-[24px]">content_copy</span>
                                            </div>
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Producto Duplicado</span>
                                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">
                                                {Object.values(validationResults).filter(v => v.isDuplicate).length}
                                            </span>
                                        </div>
                                        <div className="flex flex-col items-center text-center">
                                            <div className="size-12 bg-red-100 dark:bg-red-900/20 text-red-600 rounded-xl mb-3 flex items-center justify-center">
                                                <span className="material-symbols-outlined text-[24px]">remove_circle</span>
                                            </div>
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">En Lista Negra</span>
                                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">
                                                {Object.values(validationResults).filter(v => v.hasForbiddenWords).length}
                                            </span>
                                        </div>
                                        <div className="flex flex-col items-center text-center">
                                            <div className="size-12 bg-blue-100 dark:bg-blue-900/20 text-blue-600 rounded-xl mb-3 flex items-center justify-center">
                                                <span className="material-symbols-outlined text-[24px]">tag</span>
                                            </div>
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Error por GTIN</span>
                                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">0</span>
                                        </div>
                                        <div className="flex flex-col items-center text-center">
                                            <div className="size-12 bg-pink-100 dark:bg-pink-900/20 text-pink-600 rounded-xl mb-3 flex items-center justify-center">
                                                <span className="material-symbols-outlined text-[24px]">help</span>
                                            </div>
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Otros Errores</span>
                                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">
                                                {Object.values(publishingStatus).filter(s => s === 'error').length}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex gap-3">
                            <button onClick={() => setStep(4)} className="flex-1 py-3 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">Atrás</button>
                            <button
                                onClick={() => { setStep(1); setLoadedProducts([]); setProcessedProducts([]); setAsinInput(''); setPublishingStatus({}); setDryRunResults({}); setPublishResults({}); }}
                                className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all flex items-center justify-center gap-2"
                            >
                                <span className="material-symbols-outlined">add</span>Nueva Importación
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
