import React from 'react';
import { Marketplace, ListingType } from '../types';
import { useAmazonImporter } from '../useAmazonImporter';

type Props = ReturnType<typeof useAmazonImporter>;

// ── Step 1 ─────────────────────────────────────────────────────────────────
export const Step1Config: React.FC<Props> = ({
    marketplace, setMarketplace,
    listingType, setListingType,
    autoCategory, setAutoCategory,
    cleanImages, setCleanImages,
    setStep,
}) => (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 space-y-6">
        <h2 className="text-lg font-black text-slate-900 dark:text-white">Configuración de Importación</h2>

        {/* Marketplace Destino */}
        <div>
            <label className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 block">Marketplace Destino</label>
            <div className="grid grid-cols-2 gap-3">
                {[
                    { id: 'MLM', label: '🇲🇽 MercadoLibre México', desc: 'Pesos MXN' },
                    { id: 'MLS', label: '🇺🇸 MercadoLibre USA',    desc: 'Dólares USD' }
                ].map(m => (
                    <button key={m.id} onClick={() => setMarketplace(m.id as Marketplace)}
                        className={`p-4 rounded-xl border-2 text-left transition-all ${marketplace === m.id ? 'border-primary bg-primary/5 shadow-sm shadow-primary/20' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}>
                        <p className="font-bold text-slate-900 dark:text-white text-sm">{m.label}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{m.desc}</p>
                    </button>
                ))}
            </div>
        </div>

        {/* Tipo de Publicación */}
        <div>
            <label className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3 block">Tipo de Publicación</label>
            <div className="grid grid-cols-2 gap-3">
                {[
                    { id: 'gold_special', label: '⚡ Clásica',  desc: 'Sin mercadoenvíos gratis, menor comisión', commission: '~8%' },
                    { id: 'gold_pro',     label: '🥇 Premium', desc: 'Con envío gratis, mayor exposición',       commission: '~13%' }
                ].map(lt => (
                    <button key={lt.id} onClick={() => setListingType(lt.id as ListingType)}
                        className={`p-4 rounded-xl border-2 text-left transition-all ${listingType === lt.id ? 'border-primary bg-primary/5 shadow-sm shadow-primary/20' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}>
                        <p className="font-bold text-slate-900 dark:text-white text-sm">{lt.label}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{lt.desc}</p>
                        <span className="inline-block mt-2 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] font-bold px-2 py-0.5 rounded-full">Comisión {lt.commission}</span>
                    </button>
                ))}
            </div>
        </div>

        {/* Opciones de IA */}
        <div className="border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-3">
            <p className="text-xs font-black text-slate-500 uppercase tracking-widest">Opciones de IA</p>
            <label className="flex items-center justify-between cursor-pointer">
                <div>
                    <p className="text-sm font-bold text-slate-900 dark:text-white">🤖 Detectar categoría automáticamente</p>
                    <p className="text-xs text-slate-500">Claude analiza el producto y elige la categoría correcta de ML</p>
                </div>
                <div onClick={() => setAutoCategory(!autoCategory)}
                    className={`w-12 h-6 rounded-full transition-all cursor-pointer relative ${autoCategory ? 'bg-primary' : 'bg-slate-200 dark:bg-slate-700'}`}>
                    <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${autoCategory ? 'left-6' : 'left-0.5'}`} />
                </div>
            </label>
            <div className="border-t border-slate-100 dark:border-slate-700/50 pt-3">
                <label className="flex items-center justify-between cursor-pointer">
                    <div>
                        <p className="text-sm font-bold text-slate-900 dark:text-white">🖼️ Limpiar imágenes con IA</p>
                        <p className="text-xs text-slate-500">Elimina texto de contacto en fotos con Clipdrop • ~$0.01 USD por imagen</p>
                    </div>
                    <div onClick={() => setCleanImages(!cleanImages)}
                        className={`w-12 h-6 rounded-full transition-all cursor-pointer relative flex-shrink-0 ml-4 ${cleanImages ? 'bg-primary' : 'bg-slate-200 dark:bg-slate-700'}`}>
                        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${cleanImages ? 'left-6' : 'left-0.5'}`} />
                    </div>
                </label>
            </div>
        </div>

        <button onClick={() => setStep(2)}
            className="w-full py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all shadow-sm shadow-primary/30 flex items-center justify-center gap-2">
            Continuar <span className="material-symbols-outlined">arrow_forward</span>
        </button>
    </div>
);

// ── Step 2 ─────────────────────────────────────────────────────────────────
export const Step2Asins: React.FC<Props> = ({
    asinInput, setAsinInput,
    loadedProducts,
    loadingAsins,
    processingProgress,
    handleLoadAsins,
    handleProcessWithAI,
    removeProduct,
    setStep,
}) => {
    // Same parsing handleLoadAsins actually uses, so this count always matches
    // what "Cargar Productos" will really load — not just a token count.
    const tokens = asinInput.split(/[\n,\s]+/).map(a => a.trim()).filter(Boolean);
    const validAsins = tokens.map(a => a.toUpperCase()).filter(a => /^[A-Z0-9]{10}$/.test(a));
    const invalidCount = tokens.length - validAsins.length;

    return (
    <div className="space-y-4">
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
            <h2 className="text-lg font-black text-slate-900 dark:text-white mb-1">Ingresa los ASINs</h2>
            <p className="text-sm text-slate-500 mb-4">Uno o varios ASINs, uno por línea o separados por comas</p>
            <textarea
                value={asinInput}
                onChange={e => setAsinInput(e.target.value)}
                rows={4}
                placeholder={"B08N5WRWNW\nB09G9HDQLR\nB07ZPKBL9V"}
                className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white font-mono text-sm focus:ring-2 focus:ring-primary focus:border-transparent resize-none"
            />
            {tokens.length > 0 && (
                <div className="mt-2 flex items-center gap-2 text-xs">
                    <span className="font-black text-primary bg-primary/10 px-2 py-1 rounded-full">
                        {validAsins.length} ASIN{validAsins.length === 1 ? '' : 's'} detectado{validAsins.length === 1 ? '' : 's'}
                    </span>
                    {invalidCount > 0 && (
                        <span className="text-slate-400">
                            ({invalidCount} línea{invalidCount === 1 ? '' : 's'} no parece{invalidCount === 1 ? '' : 'n'} un ASIN válido)
                        </span>
                    )}
                </div>
            )}
            <button onClick={handleLoadAsins} disabled={loadingAsins || !asinInput.trim()}
                className="mt-3 w-full py-3 bg-slate-900 dark:bg-white dark:text-slate-900 text-white font-black rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                {loadingAsins
                    ? <><span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                        {processingProgress && processingProgress.total > 0
                            ? `Cargando... (${processingProgress.current}/${processingProgress.total})`
                            : 'Cargando...'}
                      </>
                    : <><span className="material-symbols-outlined">cloud_download</span>Cargar {validAsins.length > 0 ? `${validAsins.length} ` : ''}Producto{validAsins.length === 1 ? '' : 's'}</>}
            </button>
            {loadingAsins && processingProgress && processingProgress.total > 5 && (
                <div className="mt-2 h-1.5 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                        style={{ width: `${Math.round((processingProgress.current / processingProgress.total) * 100)}%` }}
                    />
                </div>
            )}
        </div>

        {loadedProducts.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {loadedProducts.map(p => (
                    <div key={p.asin} className="relative bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 flex gap-3">
                        <button
                            onClick={() => {
                                if (!confirm(`¿Quitar ${p.asin} de esta importación?`)) return;
                                removeProduct(p.asin);
                            }}
                            title="Quitar este producto de la importación"
                            className="absolute top-2 right-2 p-1 text-slate-300 hover:text-red-500 dark:text-slate-600 dark:hover:text-red-400 transition-colors"
                        >
                            <span className="material-symbols-outlined text-[18px]">close</span>
                        </button>
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
                                    <p className="font-bold text-slate-900 dark:text-white text-xs line-clamp-2">
                                        {p.title || <span className="text-amber-500 italic">Sin título (error de API)</span>}
                                    </p>
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
                                {p.imageUrl
                                    ? <img src={p.imageUrl} alt={p.title} className="w-16 h-16 object-cover rounded-lg flex-shrink-0 border border-slate-100 dark:border-slate-700" />
                                    : <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 rounded-lg flex-shrink-0 flex items-center justify-center">
                                        <span className="material-symbols-outlined text-slate-400">image</span>
                                      </div>}
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
            <button onClick={() => setStep(1)} className="flex-1 py-3 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">Atrás</button>
            <button
                onClick={async () => { await handleProcessWithAI(); setStep(3); }}
                disabled={loadedProducts.filter(p => !p.loading && !p.error).length === 0}
                className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                Procesar con IA <span className="material-symbols-outlined">auto_awesome</span>
            </button>
        </div>
    </div>
    );
};

// ── Step 3 ─────────────────────────────────────────────────────────────────
export const Step3AI: React.FC<Props> = ({
    isProcessing, processingStage, processingProgress,
    processedProducts,
    editedTitles, setEditedTitles,
    selectedCategories, setSelectedCategories,
    mlCategorySearchResults,
    handleLoadAttributes,
    removeProduct,
    setStep,
}) => (
    <div className="space-y-4">
        {isProcessing && (
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-2xl p-6">
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 rounded-full border-4 border-blue-200 border-t-blue-500 animate-spin flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-3">
                            <p className="font-black text-blue-900 dark:text-blue-100">Claude está analizando tus productos...</p>
                            {processingProgress && processingProgress.total > 0 && (
                                <span className="flex-shrink-0 text-xs font-black text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/40 px-2.5 py-1 rounded-full">
                                    {processingProgress.current}/{processingProgress.total}
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-blue-600 dark:text-blue-400 mt-0.5 truncate">{processingStage}</p>
                    </div>
                </div>
                {processingProgress && processingProgress.total > 0 && (
                    <div className="mt-4 h-2 bg-blue-100 dark:bg-blue-900/40 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-blue-500 rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${Math.round((processingProgress.current / processingProgress.total) * 100)}%` }}
                        />
                    </div>
                )}
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
                        <div className="flex items-center gap-2">
                            <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-[10px] font-black px-3 py-1 rounded-full uppercase">✓ Procesado</span>
                            <button
                                onClick={() => {
                                    if (!confirm(`¿Quitar "${editedTitles[processed.asin] || processed.optimizedTitle}" (${processed.asin}) de esta importación?`)) return;
                                    removeProduct(processed.asin);
                                }}
                                title="Quitar este producto de la importación"
                                className="p-1 text-slate-300 hover:text-red-500 dark:text-slate-600 dark:hover:text-red-400 transition-colors"
                            >
                                <span className="material-symbols-outlined text-[18px]">close</span>
                            </button>
                        </div>
                    </div>

                    <div className="p-4 space-y-4">
                        {/* Title */}
                        <div>
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Título para MercadoLibre</label>
                            <div className="mt-1 flex items-start gap-2">
                                <input maxLength={60}
                                    value={editedTitles[processed.asin] || processed.optimizedTitle}
                                    onChange={e => setEditedTitles(prev => ({ ...prev, [processed.asin]: e.target.value }))}
                                    className="flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-900 dark:text-white font-medium focus:ring-2 focus:ring-primary focus:border-transparent"
                                />
                                <span className={`text-[10px] font-black mt-2 flex-shrink-0 ${(editedTitles[processed.asin] || processed.optimizedTitle).length > 55 ? 'text-red-500' : 'text-slate-400'}`}>
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
                                <span className="text-sm font-bold text-slate-900 dark:text-white">
                                    {selectedCategories[processed.asin]?.name || processed.categorySuggestion.category_name}
                                </span>
                            </div>
                            {mlCats.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                    {mlCats.slice(0, 4).map((cat: any) => (
                                        <button key={cat.category_id || cat.id}
                                            onClick={() => setSelectedCategories(prev => ({
                                                ...prev,
                                                [processed.asin]: { id: cat.category_id || cat.id, name: cat.category_name || cat.domain_name }
                                            }))}
                                            className={`text-[10px] font-bold px-2 py-1 rounded-lg border transition-all ${selectedCategories[processed.asin]?.id === (cat.category_id || cat.id) ? 'bg-primary text-white border-primary' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:border-primary'}`}>
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
                                            <img src={img.cleanedUrl || img.url} alt={`img-${i}`} className="w-12 h-12 object-cover rounded-lg border border-slate-200 dark:border-slate-700" />
                                            {img.checked && img.hasContactInfo && (
                                                <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center" title="Limpiada con IA">
                                                    <span className="material-symbols-outlined text-white text-[10px]">auto_fix_high</span>
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
                onClick={async () => { try { await handleLoadAttributes(); } catch (e) { console.error('Error loading attributes:', e); } setStep(4); }}
                disabled={processedProducts.length === 0}
                className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                Revisar Atributos <span className="material-symbols-outlined">arrow_forward</span>
            </button>
        </div>
    </div>
);
