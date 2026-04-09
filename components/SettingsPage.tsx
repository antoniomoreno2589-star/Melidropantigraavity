import React, { useState, useEffect } from 'react';
import { AmazonConnect } from './AmazonConnect';
import { supabase } from '../services/supabase';

interface PriceRule {
    id: number;
    min: number;
    max: number | null;
    margin: number;
}

const PriceRuleManager = ({
    currencySymbol,
    currencyCode,
    rules,
    setRules
}: {
    currencySymbol: string,
    currencyCode: string,
    rules: PriceRule[],
    setRules: React.Dispatch<React.SetStateAction<PriceRule[]>>
}) => {
    const [newMin, setNewMin] = useState<string>('');
    const [newMax, setNewMax] = useState<string>('');
    const [newMargin, setNewMargin] = useState<string>('');

    const handleAddRule = () => {
        if (!newMin || !newMargin) return;
        const newRule: PriceRule = {
            id: Date.now(),
            min: parseFloat(newMin),
            max: newMax ? parseFloat(newMax) : null,
            margin: parseFloat(newMargin)
        };
        setRules([...rules, newRule].sort((a, b) => a.min - b.min));
        setNewMin(''); setNewMax(''); setNewMargin('');
    };

    const handleDeleteRule = (id: number) => {
        setRules(rules.filter(r => r.id !== id));
    };

    return (
        <div className="flex flex-col gap-3 w-full">
            <label className="text-xs font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
                Reglas de Margen por Costo ({currencyCode})
            </label>
            <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden bg-white dark:bg-slate-900/50">
                <div className="grid grid-cols-12 gap-2 p-3 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-500">
                    <div className="col-span-3">Costo Mín</div>
                    <div className="col-span-3">Costo Máx</div>
                    <div className="col-span-4 text-center">Ganancia %</div>
                    <div className="col-span-2 text-right">Acción</div>
                </div>
                <div className="max-h-40 overflow-y-auto">
                    {rules.length === 0 && <div className="p-4 text-center text-xs text-slate-400 italic">No hay reglas definidas.</div>}
                    {rules.map((rule) => (
                        <div key={rule.id} className="grid grid-cols-12 gap-2 p-3 border-b border-slate-100 dark:border-slate-800/50 items-center text-sm hover:bg-slate-50 transition-colors">
                            <div className="col-span-3 font-mono text-slate-700 dark:text-slate-300">{currencySymbol}{rule.min}</div>
                            <div className="col-span-3 font-mono text-slate-700 dark:text-slate-300">{rule.max ? `${currencySymbol}${rule.max}` : '∞'}</div>
                            <div className="col-span-4 text-center font-bold text-primary bg-primary/10 rounded py-0.5">{rule.margin}%</div>
                            <div className="col-span-2 text-right">
                                <button onClick={() => handleDeleteRule(rule.id)} className="text-slate-400 hover:text-red-500">
                                    <span className="material-symbols-outlined text-[18px]">delete</span>
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
                <div className="grid grid-cols-12 gap-2 p-3 bg-slate-50/50 border-t border-slate-200 dark:border-slate-700">
                    <div className="col-span-3 relative">
                        <span className="absolute left-2 top-1.5 text-xs text-slate-400">{currencySymbol}</span>
                        <input type="number" placeholder="0" value={newMin} onChange={(e) => setNewMin(e.target.value)} className="w-full pl-5 pr-1 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800" />
                    </div>
                    <div className="col-span-3 relative">
                        <span className="absolute left-2 top-1.5 text-xs text-slate-400">{currencySymbol}</span>
                        <input type="number" placeholder="Max" value={newMax} onChange={(e) => setNewMax(e.target.value)} className="w-full pl-5 pr-1 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800" />
                    </div>
                    <div className="col-span-4 relative">
                        <input type="number" placeholder="Margen" value={newMargin} onChange={(e) => setNewMargin(e.target.value)} className="w-full pl-2 pr-6 py-1 text-xs border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-center font-bold" />
                        <span className="absolute right-2 top-1.5 text-xs text-slate-400">%</span>
                    </div>
                    <div className="col-span-2 text-right">
                        <button onClick={handleAddRule} disabled={!newMin || !newMargin} className="bg-primary hover:bg-primary-dark disabled:opacity-50 text-white rounded p-1 shadow-sm transition-colors">
                            <span className="material-symbols-outlined text-[18px]">add</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export const SettingsPage = () => {
    const [usaRules, setUsaRules] = useState<PriceRule[]>(() => {
        const saved = localStorage.getItem('melidrop_usa_rules');
        return saved ? JSON.parse(saved) : [{ id: 1, min: 0, max: 20, margin: 200 }, { id: 2, min: 21, max: 50, margin: 100 }, { id: 3, min: 51, max: null, margin: 50 }];
    });
    const [mxRules, setMxRules] = useState<PriceRule[]>(() => {
        const saved = localStorage.getItem('melidrop_mx_rules');
        return saved ? JSON.parse(saved) : [{ id: 1, min: 0, max: 300, margin: 150 }, { id: 2, min: 301, max: 600, margin: 130 }, { id: 3, min: 601, max: null, margin: 80 }];
    });
    const [exchangeRate, setExchangeRate] = useState<number>(() => parseFloat(localStorage.getItem('melidrop_exchange_rate') || '18.24'));
    const [usaDefaultMargin, setUsaDefaultMargin] = useState<number>(30);
    const [mxDefaultMargin, setMxDefaultMargin] = useState<number>(20);
    const [isUpdatingDolar, setIsUpdatingDolar] = useState(false);
    const [globalFilters, setGlobalFilters] = useState("Nike\nAdidas\nReacondicionado");

    const updateDolarOnline = async () => {
        setIsUpdatingDolar(true);
        try {
            // Real API call to get live exchange rate USD/MXN
            const response = await fetch('https://open.er-api.com/v6/latest/USD');
            const data = await response.json();

            if (data.result === "success" && data.rates && data.rates.MXN) {
                const liveRate = parseFloat(data.rates.MXN.toFixed(2));
                setExchangeRate(liveRate);
                localStorage.setItem('melidrop_exchange_rate', liveRate.toString());
                alert(`¡Éxito! El tipo de cambio real se ha actualizado a $${liveRate} MXN.`);
            } else {
                throw new Error("No se pudo obtener la tasa de MXN");
            }
        } catch (error) {
            console.error("Error fetching dollar rate:", error);
            alert("Error al conectar con el servidor financiero. Intente de nuevo más tarde.");
        } finally {
            setIsUpdatingDolar(false);
        }
    };

    const handleSaveSection = async (section: string) => {
        localStorage.setItem('melidrop_usa_rules', JSON.stringify(usaRules));
        localStorage.setItem('melidrop_mx_rules', JSON.stringify(mxRules));
        localStorage.setItem('melidrop_exchange_rate', exchangeRate.toString());
        localStorage.setItem('melidrop_global_filters', globalFilters);
        
        // Sync to Supabase
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await supabase.from('user_connections').upsert({
                user_id: user.id,
                exchange_rate: exchangeRate,
                margin_rules: { usa: usaRules, mx: mxRules, filters: globalFilters }
            });
        }
        
        alert(`Configuración de ${section} guardada exitosamente en el sistema.`);
    };

    return (
        <div className="flex-1 overflow-y-auto p-4 md:p-8 scroll-smooth">
            <div className="w-full max-w-7xl mx-auto flex flex-col gap-8">
                <div className="flex flex-col gap-2 mb-4 animate-fade-in">
                    <h1 className="text-3xl md:text-4xl font-black text-text-main-light dark:text-white tracking-tight uppercase">Configuración de Reglas</h1>
                    <p className="text-text-secondary-light dark:text-text-secondary-dark text-lg max-w-2xl">Estrategias de precios independientes por región de origen.</p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* AMAZON CONNECT CARD */}
                    <div className="lg:col-span-2">
                        <AmazonConnect />
                    </div>

                    {/* AMAZON USA CARD */}
                    <section className="flex flex-col bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden relative group h-fit">
                        <div className="absolute top-0 left-0 w-full h-1 bg-blue-600"></div>
                        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <img alt="USA" className="h-6 rounded" src="https://flagcdn.com/us.svg" />
                                <h2 className="text-lg font-bold text-slate-900 dark:text-white">Amazon USA</h2>
                            </div>
                            <span className="px-2 py-1 rounded bg-blue-100 text-blue-700 text-[10px] font-black uppercase">Importación</span>
                        </div>
                        <div className="p-6 space-y-6">
                            <PriceRuleManager currencySymbol="$" currencyCode="USD" rules={usaRules} setRules={setUsaRules} />
                            <div className="grid grid-cols-2 gap-4">
                                <div className="flex flex-col gap-2">
                                    <label className="text-xs font-semibold text-slate-500 uppercase">Dólar (USD/MXN)</label>
                                    <div className="relative">
                                        <input className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg pl-7 pr-3 py-2 text-sm font-black" type="number" value={exchangeRate} onChange={(e) => setExchangeRate(parseFloat(e.target.value))} />
                                        <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 font-bold">$</span>
                                    </div>
                                    <button
                                        onClick={updateDolarOnline}
                                        disabled={isUpdatingDolar}
                                        className="text-primary text-[10px] font-black uppercase flex items-center gap-1 hover:underline disabled:opacity-50 disabled:no-underline"
                                    >
                                        <span className={`material-symbols-outlined text-[14px] ${isUpdatingDolar ? 'animate-spin' : ''}`}>sync</span>
                                        {isUpdatingDolar ? 'Conectando...' : 'Actualizar en Línea'}
                                    </button>
                                </div>
                                <div className="flex flex-col gap-2">
                                    <label className="text-xs font-semibold text-slate-500 uppercase">Margen Default</label>
                                    <div className="relative">
                                        <input className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black" type="number" value={usaDefaultMargin} onChange={(e) => setUsaDefaultMargin(parseFloat(e.target.value))} />
                                        <span className="absolute right-3 top-2 text-slate-400 text-xs">%</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800">
                            <button onClick={() => handleSaveSection('USA')} className="w-full bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white font-black py-2.5 rounded-lg shadow-sm text-sm active:scale-95 transition-all">
                                GUARDAR CONFIGURACIÓN USA
                            </button>
                        </div>
                    </section>

                    {/* AMAZON MX CARD */}
                    <section className="flex flex-col bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden relative group h-fit">
                        <div className="absolute top-0 left-0 w-full h-1 bg-green-600"></div>
                        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <img alt="MX" className="h-6 rounded" src="https://flagcdn.com/mx.svg" />
                                <h2 className="text-lg font-bold text-slate-900 dark:text-white">Amazon México</h2>
                            </div>
                            <span className="px-2 py-1 rounded bg-green-100 text-green-700 text-[10px] font-black uppercase">Nacional</span>
                        </div>
                        <div className="p-6 space-y-6">
                            <PriceRuleManager currencySymbol="$" currencyCode="MXN" rules={mxRules} setRules={setMxRules} />
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-semibold text-slate-500 uppercase">Margen Default Nacional</label>
                                <div className="relative">
                                    <input className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black" type="number" value={mxDefaultMargin} onChange={(e) => setMxDefaultMargin(parseFloat(e.target.value))} />
                                    <span className="absolute right-3 top-2 text-slate-400 text-xs">%</span>
                                </div>
                            </div>
                        </div>
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800">
                            <button onClick={() => handleSaveSection('México')} className="w-full bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white font-black py-2.5 rounded-lg shadow-sm text-sm active:scale-95 transition-all">
                                GUARDAR CONFIGURACIÓN MX
                            </button>
                        </div>
                    </section>

                    {/* GLOBAL FILTERS */}
                    <section className="flex flex-col lg:col-span-2 bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-red-100 text-red-600">
                                <span className="material-symbols-outlined">block</span>
                            </div>
                            <h2 className="text-lg font-bold text-slate-900 dark:text-white uppercase tracking-tighter">Filtro Global de Palabras Prohibidas</h2>
                        </div>
                        <div className="p-6">
                            <div className="flex flex-col gap-4">
                                <label className="text-xs font-black text-slate-500 uppercase">Lista negra de marcas y palabras (una por línea)</label>
                                <textarea
                                    value={globalFilters}
                                    onChange={(e) => setGlobalFilters(e.target.value)}
                                    className="w-full h-32 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-4 py-3 text-sm font-mono focus:ring-primary resize-none"
                                    placeholder="Nike, Adidas, Apple..."
                                />
                                <p className="text-[10px] text-slate-400 font-bold uppercase italic">Cualquier producto con estas palabras será excluido de la importación automáticamente.</p>
                            </div>
                        </div>
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 mt-auto">
                            <button onClick={() => handleSaveSection('Filtros Globales')} className="w-full bg-slate-800 hover:bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white font-black py-3 px-4 rounded-xl shadow-sm transition-all flex items-center justify-center gap-2 text-sm uppercase">
                                <span className="material-symbols-outlined text-[18px]">save</span>
                                Aplicar Filtros Globales
                            </button>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
};