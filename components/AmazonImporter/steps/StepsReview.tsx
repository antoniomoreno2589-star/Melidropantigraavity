import { useAmazonImporter } from '../useAmazonImporter';

type Props = ReturnType<typeof useAmazonImporter>;

export function Step4Attributes({
    processedProducts,
    validationResults,
    categoryAttributes,
    userAttributes,
    setUserAttributes,
    editedTitles,
    setStep,
}: Props) {
    return (
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
                                    {val.isDuplicate ? `⚠️ Detectado en MercadoLibre (ID: ${val.duplicateId})` : '✓ No es duplicado'}
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
    );
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
    setProcessedProducts,
    setAsinInput,
    setPublishingStatus,
    setDryRunResults,
    setPublishResults,
}: Props) {
    return (
        <div className="space-y-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                <h2 className="text-lg font-black text-slate-900 dark:text-white mb-1">Confirmar Publicación</h2>
                <p className="text-sm text-slate-500 mb-4">Revisa el resumen antes de publicar</p>

                <div className="space-y-3">
                    {processedProducts.map(processed => {
                        const status = publishingStatus[processed.asin];
                        const result = publishResults[processed.asin];
                        const dry = dryRunResults[processed.asin];
                        const val = validationResults[processed.asin];

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
                                    <div className="mb-3 bg-slate-50 dark:bg-slate-900 rounded-lg p-3 space-y-2">
                                        <p className="text-[10px] font-black text-slate-500 uppercase mb-1">Resultado de Prueba</p>
                                        <div className="flex flex-wrap gap-2">
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${dry.validation?.valid ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                                                {dry.validation?.valid ? '✓ Estructura válida' : '⚠ Errores de validación'}
                                            </span>
                                            {dry.hasTestUser ? (
                                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${dry.testPublish?.id ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                                    {dry.testPublish?.id ? `✓ Publicado en ML Test (${dry.testPublish.id})` : '✗ Error en ML Test'}
                                                </span>
                                            ) : (
                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                                                    📋 Guardado en catálogo de pruebas
                                                </span>
                                            )}
                                        </div>
                                        {dry.testPublish?.error && (
                                            <p className="text-[10px] text-red-500 font-mono mt-1">{dry.testPublish.error}</p>
                                        )}
                                        {!dry.hasTestUser && (
                                            <p className="text-[10px] text-slate-400 mt-1">
                                                Para publicar en una cuenta test de ML, configura el Usuario de Prueba en <strong>Configuración → MercadoLibre</strong>.
                                            </p>
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
                                {result?.error && (
                                    <div className="mt-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                                        <p className="text-[10px] font-black text-red-600 uppercase tracking-widest mb-1">Error de MercadoLibre</p>
                                        {result.error.split('\n').map((line: string, i: number) => (
                                            <p key={i} className="text-xs text-red-500 font-mono leading-relaxed">{line}</p>
                                        ))}
                                    </div>
                                )}

                                {/* Validation Messages */}
                                {val?.isSkipped && (
                                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-lg p-3 flex items-center gap-2 mb-4">
                                        <span className="material-symbols-outlined text-red-500 text-[20px]">block</span>
                                        <div className="flex-1">
                                            <p className="text-xs font-black text-red-600 uppercase tracking-widest">Producto Descartado</p>
                                            <p className="text-[10px] text-red-500">{val.isDuplicate ? 'Ya existe en tus publicaciones activas.' : `Contiene palabra prohibida: "${val.forbiddenWord}"`}</p>
                                        </div>
                                    </div>
                                )}

                                {/* Action Buttons */}
                                {!status || status === 'idle' || status === 'error' ? (
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => handleDryRun(processed.asin)}
                                            className="flex-1 py-2 border-2 border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 font-bold rounded-lg text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-all flex items-center justify-center gap-1"
                                        >
                                            <span className="material-symbols-outlined text-[16px]">science</span>Probar (Sandbox)
                                        </button>
                                        <button
                                            onClick={() => handlePublish(processed.asin, false)}
                                            disabled={!!validationResults[processed.asin]?.isSkipped}
                                            className="flex-1 py-2 bg-green-600 hover:bg-green-700 text-white font-black rounded-lg text-sm transition-all disabled:opacity-50 disabled:grayscale flex items-center justify-center gap-1 shadow-sm shadow-green-600/30"
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
                    onClick={() => {
                        setStep(1);
                        setLoadedProducts([]);
                        setProcessedProducts([]);
                        setAsinInput('');
                        setPublishingStatus({});
                        setDryRunResults({});
                        setPublishResults({});
                    }}
                    className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-black rounded-xl transition-all flex items-center justify-center gap-2"
                >
                    <span className="material-symbols-outlined">add</span>Nueva Importación
                </button>
            </div>
        </div>
    );
}
