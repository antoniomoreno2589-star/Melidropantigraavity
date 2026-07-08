import { useState } from 'react';
import { useAmazonImporter } from '../useAmazonImporter';

type Props = ReturnType<typeof useAmazonImporter>;

type ValidationResult = {
    isDuplicate: boolean;
    duplicateId?: string;
    hasForbiddenWords: boolean;
    forbiddenWord?: string;
    isSkipped?: boolean;
};

export function Step4Attributes({
    processedProducts,
    validationResults,
    categoryAttributes,
    userAttributes,
    setUserAttributes,
    editedTitles,
    selectedCategories,
    getBlockingIssues,
    refetchProductPrice,
    removeProduct,
    setStep,
}: Props) {
    // Products that still need attention before we can move to publishing.
    // Duplicates/forbidden-word matches are excluded — those are meant to be
    // skipped at publish time, not fixed, so they shouldn't block the batch.
    const blockingByAsin: Record<string, string[]> = {};
    for (const processed of processedProducts) {
        if (validationResults[processed.asin]?.isSkipped) continue;
        const issues = getBlockingIssues(processed.asin);
        if (issues.length > 0) blockingByAsin[processed.asin] = issues;
    }
    const blockedCount = Object.keys(blockingByAsin).length;

    // Amazon's pricing API reflects live stock/offers — a single-seller item can
    // briefly show no active offer at load time and be available again minutes
    // later, so "sin precio" isn't always permanent. Let the user recheck one
    // product without redoing the whole import.
    const [refetchingPrice, setRefetchingPrice] = useState<Set<string>>(new Set());
    const handleRetryPrice = async (asin: string) => {
        setRefetchingPrice(prev => new Set(prev).add(asin));
        try {
            await refetchProductPrice(asin);
        } finally {
            setRefetchingPrice(prev => { const next = new Set(prev); next.delete(asin); return next; });
        }
    };

    // Escape hatch for a product that can't be fixed in place — drops it from
    // the batch so it stops blocking everyone else from continuing to Step 5.
    const handleRemoveProduct = (asin: string, title: string) => {
        if (!confirm(`¿Eliminar "${title}" (${asin}) de esta importación?\n\nNo se publicará nada — simplemente se quita de este lote. Puedes volver a importarlo después si cambias de opinión.`)) return;
        removeProduct(asin);
    };

    return (
        <div className="space-y-4">
            {processedProducts.map(processed => {
                const val = validationResults[processed.asin];
                const attrs = categoryAttributes[processed.asin] || [];
                const userAttrs = userAttributes[processed.asin] || {};
                const hasCategory = !!selectedCategories[processed.asin]?.id;
                const issues = blockingByAsin[processed.asin] || [];

                return (
                    <div key={processed.asin} className={`bg-white dark:bg-slate-800 rounded-2xl border overflow-hidden ${issues.length > 0 ? 'border-amber-300 dark:border-amber-700' : 'border-slate-200 dark:border-slate-700'}`}>
                        <div className="p-4 border-b border-slate-100 dark:border-slate-700">
                            <p className="font-black text-slate-900 dark:text-white">{editedTitles[processed.asin]}</p>
                            <p className="text-xs text-slate-500 font-mono mt-0.5">{processed.asin}</p>
                        </div>

                        {/* Validations */}
                        {val && (
                            <div className="px-4 py-3 space-y-1.5 border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
                                <div className={`flex items-center gap-2 text-xs font-bold ${val.isDuplicate ? 'text-red-500' : 'text-green-600'}`}>
                                    <span className="material-symbols-outlined text-[16px]">{val.isDuplicate ? 'error' : 'check_circle'}</span>
                                    {val.isDuplicate ? `⚠️ Detectado en MercadoLibre (ID: ${val.duplicateId})` : '✓ No es duplicado'}
                                </div>
                                <div className={`flex items-center gap-2 text-xs font-bold ${val.hasForbiddenWords ? 'text-red-500' : 'text-green-600'}`}>
                                    <span className="material-symbols-outlined text-[16px]">{val.hasForbiddenWords ? 'error' : 'check_circle'}</span>
                                    {val.hasForbiddenWords ? `⚠️ Contiene palabra prohibida: "${val.forbiddenWord}"` : '✓ Sin palabras prohibidas'}
                                </div>
                            </div>
                        )}

                        {/* Blocking issues: category / price / required attributes still missing */}
                        {issues.length > 0 && (
                            <div className="px-4 py-3 border-b border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 space-y-1">
                                {issues.map((issue, i) => (
                                    <div key={i} className="flex items-center justify-between gap-2 text-xs font-bold text-amber-700 dark:text-amber-400">
                                        <span className="flex items-center gap-2">
                                            <span className="material-symbols-outlined text-[16px]">warning</span>
                                            {issue}
                                        </span>
                                        {issue.startsWith('Sin precio de Amazon') && (
                                            <button
                                                onClick={() => handleRetryPrice(processed.asin)}
                                                disabled={refetchingPrice.has(processed.asin)}
                                                className="text-[10px] font-black text-amber-800 dark:text-amber-300 underline hover:no-underline disabled:opacity-50 flex items-center gap-1 flex-shrink-0"
                                            >
                                                {refetchingPrice.has(processed.asin) ? (
                                                    <>
                                                        <span className="w-3 h-3 rounded-full border-2 border-amber-400 border-t-amber-700 animate-spin" />
                                                        Verificando...
                                                    </>
                                                ) : 'Reintentar precio'}
                                            </button>
                                        )}
                                    </div>
                                ))}
                                <div className="pt-1.5 mt-1.5 border-t border-amber-200/70 dark:border-amber-800/70 flex justify-end">
                                    <button
                                        onClick={() => handleRemoveProduct(processed.asin, editedTitles[processed.asin] || processed.asin)}
                                        className="text-[10px] font-black text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 flex items-center gap-1"
                                    >
                                        <span className="material-symbols-outlined text-[14px]">delete</span>
                                        Eliminar este producto del lote
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Required Attributes */}
                        <div className="p-4">
                            {!hasCategory ? (
                                <p className="text-sm text-amber-600 dark:text-amber-400 font-bold">Sin categoría asignada — vuelve al Paso 3 y selecciona una.</p>
                            ) : attrs.length === 0 ? (
                                <p className="text-sm text-slate-400 italic">No se encontraron atributos requeridos para esta categoría.</p>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {attrs.slice(0, 16).map((attr: any) => {
                                        const isRequired = attr.tags?.required || attr.tags?.new_required;
                                        const isEmpty = !userAttrs[attr.id]?.toString().trim();
                                        return (
                                        <div key={attr.id}>
                                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider">
                                                {attr.name} {isRequired && <span className="text-red-500">*</span>}
                                            </label>
                                            {attr.values && attr.values.length > 0 ? (
                                                <select
                                                    value={userAttrs[attr.id] || ''}
                                                    onChange={e => setUserAttributes(prev => ({ ...prev, [processed.asin]: { ...prev[processed.asin], [attr.id]: e.target.value } }))}
                                                    className={`mt-1 w-full px-2 py-1.5 border rounded-lg text-xs bg-white dark:bg-slate-900 dark:text-white focus:ring-1 focus:ring-primary ${isRequired && isEmpty ? 'border-red-400 dark:border-red-600' : 'border-slate-300 dark:border-slate-600'}`}
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
                                                    className={`mt-1 w-full px-2 py-1.5 border rounded-lg text-xs bg-white dark:bg-slate-900 dark:text-white focus:ring-1 focus:ring-primary ${isRequired && isEmpty ? 'border-red-400 dark:border-red-600' : 'border-slate-300 dark:border-slate-600'}`}
                                                />
                                            )}
                                        </div>
                                    )})}
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}

            {blockedCount > 0 && (
                <div className="flex items-center gap-2 text-sm font-bold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl p-3">
                    <span className="material-symbols-outlined text-[18px]">warning</span>
                    {blockedCount} producto(s) con datos incompletos — corrígelos arriba para poder continuar.
                </div>
            )}

            <div className="flex gap-3">
                <button onClick={() => setStep(3)} className="flex-1 py-3 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">Atrás</button>
                <button
                    onClick={() => setStep(5)}
                    disabled={blockedCount > 0}
                    title={blockedCount > 0 ? 'Resuelve los datos incompletos marcados arriba antes de continuar' : undefined}
                    className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-primary"
                >
                    Confirmar y Publicar <span className="material-symbols-outlined">arrow_forward</span>
                </button>
            </div>
        </div>
    );
}

interface Step5Props {
    processedProducts: any[];
    publishingStatus: Record<string, 'idle' | 'loading' | 'success' | 'error'>;
    publishResults: Record<string, any>;
    dryRunResults: Record<string, any>;
    validationResults: Record<string, ValidationResult>;
    editedTitles: Record<string, string>;
    selectedCategories: Record<string, { id: string; name: string }>;
    listingType: string;
    handleDryRun: (asin: string) => Promise<void>;
    handlePublish: (asin: string, isDraft: boolean) => Promise<void>;
    setStep: (step: number) => void;
    setLoadedProducts: (products: any[]) => void;
    setAsinInput: (input: string) => void;
}

export function Step5Publish({
    processedProducts,
    publishingStatus,
    publishResults,
    dryRunResults,
    validationResults,
    editedTitles,
    selectedCategories,
    listingType,
    handleDryRun,
    handlePublish,
    setStep,
    setLoadedProducts,
    setAsinInput,
}: Step5Props) {
    const [selectedAsins, setSelectedAsins] = useState<Set<string>>(new Set());
    const [isBulkProcessing, setIsBulkProcessing] = useState<boolean>(false);

    const toggleSelection = (asin: string) => {
        setSelectedAsins(prev => {
            const next = new Set(prev);
            if (next.has(asin)) {
                next.delete(asin);
            } else {
                next.add(asin);
            }
            return next;
        });
    };

    const toggleSelectAll = () => {
        if (selectedAsins.size === processedProducts.length) {
            setSelectedAsins(new Set());
        } else {
            setSelectedAsins(new Set(processedProducts.map(p => p.asin)));
        }
    };

    const failedAsins = processedProducts
        .filter(p => publishResults[p.asin]?.error || dryRunResults[p.asin]?.dryError)
        .map(p => p.asin);

    const selectFailed = () => setSelectedAsins(new Set(failedAsins));

    const handleBulkDryRun = async () => {
        if (selectedAsins.size === 0) return;
        setIsBulkProcessing(true);
        try {
            for (const asin of selectedAsins) {
                await handleDryRun(asin);
            }
        } finally {
            setIsBulkProcessing(false);
        }
    };

    const handleBulkPublish = async () => {
        if (selectedAsins.size === 0) return;
        setIsBulkProcessing(true);
        try {
            for (const asin of selectedAsins) {
                if (validationResults[asin]?.isSkipped) continue;
                await handlePublish(asin, false);
            }
        } finally {
            setIsBulkProcessing(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h2 className="text-lg font-black text-slate-900 dark:text-white mb-1">Confirmar Publicación</h2>
                        <p className="text-sm text-slate-500">Selecciona los productos para probar o publicar</p>
                    </div>
                    <div className="flex items-center gap-2">
                        {failedAsins.length > 0 && (
                            <button
                                onClick={selectFailed}
                                className="text-xs font-black text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-3 py-1.5 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-all flex items-center gap-1.5"
                                title="Selecciona todos los productos que fallaron para reintentarlos"
                            >
                                <span className="material-symbols-outlined text-[16px]">replay</span>
                                Seleccionar fallidos ({failedAsins.length})
                            </button>
                        )}
                        <div className="text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-lg">
                            {selectedAsins.size} de {processedProducts.length} seleccionados
                        </div>
                    </div>
                </div>

                {/* Bulk Action Buttons */}
                {selectedAsins.size > 0 && (
                    <div className="flex gap-2 mb-6 pb-6 border-b border-slate-200 dark:border-slate-700">
                        <button
                            onClick={handleBulkDryRun}
                            disabled={isBulkProcessing}
                            className="flex-1 py-3 border-2 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 font-black rounded-xl text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isBulkProcessing ? (
                                <>
                                    <span className="w-4 h-4 rounded-full border-2 border-slate-400 border-t-slate-700 animate-spin" />
                                    Procesando...
                                </>
                            ) : (
                                <>
                                    <span className="material-symbols-outlined text-[18px]">science</span>
                                    Probar ({selectedAsins.size})
                                </>
                            )}
                        </button>
                        <button
                            onClick={handleBulkPublish}
                            disabled={isBulkProcessing || Array.from(selectedAsins).some((asin: string) => validationResults[asin]?.isSkipped)}
                            className="flex-1 py-3 bg-green-600 hover:bg-green-700 text-white font-black rounded-xl text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm shadow-green-600/30"
                        >
                            {isBulkProcessing ? (
                                <>
                                    <span className="w-4 h-4 rounded-full border-2 border-white border-t-green-400 animate-spin" />
                                    Publicando...
                                </>
                            ) : (
                                <>
                                    <span className="material-symbols-outlined text-[18px]">rocket_launch</span>
                                    Publicar ({selectedAsins.size})
                                </>
                            )}
                        </button>
                    </div>
                )}

                {/* Products Table/List */}
                <div className="space-y-2">
                    {/* Header */}
                    <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700">
                        <input
                            type="checkbox"
                            checked={selectedAsins.size > 0 && selectedAsins.size === processedProducts.length}
                            onChange={toggleSelectAll}
                            className="w-5 h-5 rounded border-slate-300 dark:border-slate-600 cursor-pointer"
                        />
                        <div className="flex-1 grid grid-cols-4 gap-4">
                            <div className="text-[10px] font-black text-slate-600 dark:text-slate-400 uppercase tracking-wider">Producto</div>
                            <div className="text-[10px] font-black text-slate-600 dark:text-slate-400 uppercase tracking-wider">ASIN</div>
                            <div className="text-[10px] font-black text-slate-600 dark:text-slate-400 uppercase tracking-wider">Estado</div>
                            <div className="text-[10px] font-black text-slate-600 dark:text-slate-400 uppercase tracking-wider">Resultado</div>
                        </div>
                    </div>

                    {/* Product Rows */}
                    {processedProducts.map(processed => {
                        const status = publishingStatus[processed.asin];
                        const result = publishResults[processed.asin];
                        const dry = dryRunResults[processed.asin];
                        const val = validationResults[processed.asin];
                        const isSelected = selectedAsins.has(processed.asin);

                        return (
                            <div key={processed.asin}>
                                <div className="flex items-center gap-3 px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors">
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleSelection(processed.asin)}
                                        disabled={val?.isSkipped}
                                        className="w-5 h-5 rounded border-slate-300 dark:border-slate-600 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                    />
                                    <div className="flex-1 grid grid-cols-4 gap-4 items-center">
                                        <div className="min-w-0">
                                            <p className="text-sm font-bold text-slate-900 dark:text-white truncate">{editedTitles[processed.asin]}</p>
                                        </div>
                                        <div className="text-xs font-mono text-slate-500">{processed.asin}</div>
                                        <div>
                                            {status === 'success' && <span className="inline-flex items-center gap-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-[10px] font-black px-2 py-1 rounded-full">
                                                <span className="material-symbols-outlined text-[12px]">check_circle</span> Publicado
                                            </span>}
                                            {status === 'loading' && <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 text-[10px] font-black">
                                                <span className="w-3 h-3 rounded-full border-2 border-slate-400 border-t-slate-700 animate-spin" /> Publicando
                                            </span>}
                                            {status === 'error' && <span className="inline-flex items-center gap-1 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-[10px] font-black px-2 py-1 rounded-full">
                                                <span className="material-symbols-outlined text-[12px]">error</span> Error
                                            </span>}
                                            {!status && <span className="inline-flex items-center gap-1 bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 text-[10px] font-bold px-2 py-1 rounded-full">
                                                {val?.isSkipped ? '🚫 Descartado' : 'Pendiente'}
                                            </span>}
                                        </div>
                                        <div>
                                            {result?.id && (
                                                <a href={`https://articulo.mercadolibre.com.mx/${result.id}`} target="_blank" rel="noopener noreferrer"
                                                    className="text-xs text-primary font-bold hover:underline flex items-center gap-1">
                                                    <span className="material-symbols-outlined text-[12px]">open_in_new</span> ML-{result.id}
                                                </a>
                                            )}
                                            {result?.error && <span className="text-[10px] text-red-600 dark:text-red-400 font-bold">❌ Error</span>}
                                            {dry && !result?.id && dry.testMeliId && (
                                                <span className="text-[10px] text-green-600 dark:text-green-400 font-bold">✓ Probado (sandbox)</span>
                                            )}
                                            {dry && !result?.id && !dry.testMeliId && !dry.dryError && (
                                                <span className="text-[10px] text-blue-600 dark:text-blue-400 font-bold">✓ En catálogo local</span>
                                            )}
                                            {dry?.dryError && (
                                                <span className="text-[10px] text-amber-600 dark:text-amber-400 font-bold">⚠️ Error sandbox</span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Expanded details - show on error, skip, or dry run issue */}
                                {(result?.error || val?.isSkipped || dry?.dryError) && (
                                    <div className="px-4 py-3 bg-slate-50 dark:bg-slate-900/30 border border-t-0 border-slate-200 dark:border-slate-700 rounded-b-lg space-y-2">
                                        {val?.isSkipped && (
                                            <div className="flex items-center gap-2 text-xs">
                                                <span className="material-symbols-outlined text-red-500 text-[16px]">block</span>
                                                <span className="text-red-600 dark:text-red-400 font-bold">
                                                    {val.isDuplicate ? 'Ya existe en tus publicaciones activas.' : `Contiene palabra prohibida: "${val.forbiddenWord}"`}
                                                </span>
                                            </div>
                                        )}
                                        {result?.error && (
                                            <div className="text-[10px] text-red-600 dark:text-red-400 font-mono space-y-1">
                                                {result.error.split('\n').map((line: string, i: number) => (
                                                    <p key={i}>{line}</p>
                                                ))}
                                            </div>
                                        )}
                                        {dry?.dryError && (
                                            <div className="flex items-start gap-2 text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-2">
                                                <span className="material-symbols-outlined text-[14px] flex-shrink-0 mt-0.5">warning</span>
                                                <div>
                                                    <span className="font-bold block">Error al publicar en sandbox:</span>
                                                    {dry.dryError.split('\n').map((line: string, i: number) => (
                                                        <p key={i} className="font-mono">{line}</p>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Results Summary */}
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
                    onClick={() => setStep(1)}
                    className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all flex items-center justify-center gap-2"
                >
                    <span className="material-symbols-outlined">add</span>Nueva Importación
                </button>
            </div>
        </div>
    );
}
