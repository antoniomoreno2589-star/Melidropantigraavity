import React, { useState, useEffect } from 'react';
import { AmazonConnect } from './AmazonConnect';
import { supabase } from '../services/supabase';
import { meliService } from '../services/meliService';

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
    const [testUser, setTestUser] = useState<any>(null);
    const [testUserLoading, setTestUserLoading] = useState(false);
    const [testUserEmail, setTestUserEmail] = useState('');
    const [testUserPassword, setTestUserPassword] = useState('');
    const [testUserStatus, setTestUserStatus] = useState<string>('');

    useEffect(() => {
        const fetchTestUser = async () => {
            const { data } = await supabase.from('user_connections').select('meli_test_user').maybeSingle();
            if (data?.meli_test_user) setTestUser(data.meli_test_user);
        };
        fetchTestUser();
    }, []);

    const handleCreateTestUser = async () => {
        setTestUserLoading(true);
        setTestUserStatus('Creando usuario de prueba en MercadoLibre...');
        try {
            const newUser = await meliService.createTestUser('MLM');
            setTestUserStatus(`✅ Usuario creado: ${newUser.nickname} | Email: ${newUser.email} | Contraseña: ${newUser.password}\n\nAhora pega el email y contraseña abajo para conectarlo.`);
            setTestUserEmail(newUser.email || '');
            setTestUserPassword(newUser.password || '');
        } catch (e: any) {
            setTestUserStatus(`❌ Error: ${e.message}`);
        } finally {
            setTestUserLoading(false);
        }
    };

    const handleConnectTestUser = async () => {
        if (!testUserEmail || !testUserPassword) {
            setTestUserStatus('❌ Ingresa el email y contraseña del usuario de prueba.');
            return;
        }
        setTestUserLoading(true);
        setTestUserStatus('Autenticando usuario de prueba...');
        try {
            const accessToken = await meliService.loginTestUser(testUserEmail, testUserPassword);
            if (!accessToken) throw new Error('No se obtuvo token de acceso');
            const testUserData = { email: testUserEmail, access_token: accessToken, connected_at: new Date().toISOString() };
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                await supabase.from('user_connections').upsert({
                    user_id: user.id,
                    meli_test_user: testUserData
                });
            }
            setTestUser(testUserData);
            setTestUserStatus('✅ Usuario de prueba conectado correctamente. Ya puedes usar "Probar (Sandbox)" en el importador.');
            setTestUserPassword('');
        } catch (e: any) {
            setTestUserStatus(`❌ Error de autenticación: ${e.message}`);
        } finally {
            setTestUserLoading(false);
        }
    };

    const handleDisconnectTestUser = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await supabase.from('user_connections').upsert({ user_id: user.id, meli_test_user: null });
        }
        setTestUser(null);
        setTestUserStatus('Usuario de prueba desconectado.');
    };

    const [usaRules, setUsaRules] = useState<PriceRule[]>(() => {
        const saved = localStorage.getItem('melidrop_usa_rules');
        return saved ? JSON.parse(saved) : [{ id: 1, min: 0, max: 20, margin: 200 }, { id: 2, min: 21, max: 50, margin: 100 }, { id: 3, min: 51, max: null, margin: 50 }];
    });
    const [mxRules, setMxRules] = useState<PriceRule[]>(() => {
        const saved = localStorage.getItem('melidrop_mx_rules');
        return saved ? JSON.parse(saved) : [{ id: 1, min: 0, max: 300, margin: 150 }, { id: 2, min: 301, max: 600, margin: 130 }, { id: 3, min: 601, max: null, margin: 80 }];
    });
    const [exchangeRate, setExchangeRate] = useState<number>(() => parseFloat(localStorage.getItem('melidrop_exchange_rate') || '18.24'));
    const [usaHandlingTime, setUsaHandlingTime] = useState<number>(() => parseInt(localStorage.getItem('melidrop_handling_time_usa') || '7'));
    const [mxHandlingTime, setMxHandlingTime] = useState<number>(() => parseInt(localStorage.getItem('melidrop_handling_time_mx') || '3'));
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
        localStorage.setItem('melidrop_handling_time_usa', usaHandlingTime.toString());
        localStorage.setItem('melidrop_handling_time_mx', mxHandlingTime.toString());

        // Sync to Supabase
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await supabase.from('user_connections').upsert({
                user_id: user.id,
                exchange_rate: exchangeRate,
                margin_rules: { usa: usaRules, mx: mxRules, filters: globalFilters, handling_time_usa: usaHandlingTime, handling_time_mx: mxHandlingTime }
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
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-semibold text-slate-500 uppercase flex items-center gap-1">
                                    <span className="material-symbols-outlined text-[14px] text-amber-500">schedule</span>
                                    Días de Preparación (Amazon USA)
                                </label>
                                <div className="flex items-center gap-3">
                                    <div className="relative flex-1">
                                        <input
                                            className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black"
                                            type="number" min="1" max="60"
                                            value={usaHandlingTime}
                                            onChange={(e) => setUsaHandlingTime(Math.max(1, parseInt(e.target.value) || 1))}
                                        />
                                        <span className="absolute right-3 top-2 text-slate-400 text-xs">días</span>
                                    </div>
                                </div>
                                <p className="text-[10px] text-slate-400 italic">Tiempo entre compra del cliente y envío a ML (incluye entrega Amazon → tú). Se envía como <code>handling_time</code> a MercadoLibre.</p>
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
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-semibold text-slate-500 uppercase flex items-center gap-1">
                                    <span className="material-symbols-outlined text-[14px] text-amber-500">schedule</span>
                                    Días de Preparación (Amazon MX)
                                </label>
                                <div className="relative">
                                    <input
                                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black"
                                        type="number" min="1" max="30"
                                        value={mxHandlingTime}
                                        onChange={(e) => setMxHandlingTime(Math.max(1, parseInt(e.target.value) || 1))}
                                    />
                                    <span className="absolute right-3 top-2 text-slate-400 text-xs">días</span>
                                </div>
                                <p className="text-[10px] text-slate-400 italic">Tiempo entre compra del cliente y envío desde Amazon MX. Se envía como <code>handling_time</code> a MercadoLibre.</p>
                            </div>
                        </div>
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800">
                            <button onClick={() => handleSaveSection('México')} className="w-full bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white font-black py-2.5 rounded-lg shadow-sm text-sm active:scale-95 transition-all">
                                GUARDAR CONFIGURACIÓN MX
                            </button>
                        </div>
                    </section>

                    {/* TEST USER (SANDBOX ML) */}
                    <section className="flex flex-col lg:col-span-2 bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                        <div className="absolute top-0 left-0 w-full h-1 bg-purple-500 rounded-t-xl" />
                        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-purple-100 text-purple-600">
                                <span className="material-symbols-outlined">science</span>
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-slate-900 dark:text-white uppercase tracking-tighter">Usuario de Prueba (Sandbox ML)</h2>
                                <p className="text-xs text-slate-500">Permite publicar productos en una cuenta de prueba de MercadoLibre antes de publicar en tu cuenta real.</p>
                            </div>
                            {testUser?.access_token && (
                                <span className="ml-auto bg-green-100 text-green-700 text-[10px] font-black px-3 py-1 rounded-full">✓ Conectado</span>
                            )}
                        </div>
                        <div className="p-6 space-y-4">
                            {testUser?.access_token ? (
                                <div className="flex flex-col gap-3">
                                    <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4">
                                        <p className="text-sm font-bold text-green-800 dark:text-green-300">✅ Cuenta de prueba activa</p>
                                        <p className="text-xs text-green-700 dark:text-green-400 mt-1">Email: {testUser.email}</p>
                                        <p className="text-xs text-green-600 mt-0.5">Conectado: {new Date(testUser.connected_at).toLocaleDateString('es-MX')}</p>
                                    </div>
                                    <button onClick={handleDisconnectTestUser} className="w-fit text-xs text-red-500 hover:text-red-700 font-bold flex items-center gap-1">
                                        <span className="material-symbols-outlined text-[14px]">link_off</span>Desconectar usuario de prueba
                                    </button>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 text-sm text-blue-700 dark:text-blue-300">
                                        <p className="font-bold mb-1">¿Cómo funciona?</p>
                                        <ol className="text-xs space-y-1 list-decimal list-inside">
                                            <li>Crea un usuario de prueba con el botón de abajo (requiere ML conectado)</li>
                                            <li>Copia el email y contraseña que aparecen</li>
                                            <li>Pégalos en los campos e ingresa "Conectar"</li>
                                            <li>Ahora "Probar (Sandbox)" publicará en esa cuenta de prueba</li>
                                        </ol>
                                    </div>
                                    <button
                                        onClick={handleCreateTestUser}
                                        disabled={testUserLoading}
                                        className="w-full py-2.5 bg-purple-600 hover:bg-purple-700 text-white font-black rounded-xl text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        {testUserLoading ? <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : <span className="material-symbols-outlined text-[18px]">person_add</span>}
                                        Crear Usuario de Prueba en ML
                                    </button>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 uppercase">Email del usuario test</label>
                                            <input
                                                type="email"
                                                value={testUserEmail}
                                                onChange={e => setTestUserEmail(e.target.value)}
                                                placeholder="test_user@testuser.com"
                                                className="mt-1 w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-900 dark:text-white"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold text-slate-500 uppercase">Contraseña</label>
                                            <input
                                                type="password"
                                                value={testUserPassword}
                                                onChange={e => setTestUserPassword(e.target.value)}
                                                placeholder="qatest1234"
                                                className="mt-1 w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-900 dark:text-white"
                                            />
                                        </div>
                                    </div>
                                    <button
                                        onClick={handleConnectTestUser}
                                        disabled={testUserLoading || !testUserEmail || !testUserPassword}
                                        className="w-full py-2.5 bg-slate-900 dark:bg-white dark:text-slate-900 text-white font-black rounded-xl text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        {testUserLoading ? <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : <span className="material-symbols-outlined text-[18px]">link</span>}
                                        Conectar Usuario de Prueba
                                    </button>
                                </div>
                            )}
                            {testUserStatus && (
                                <pre className={`text-xs rounded-xl p-3 font-mono whitespace-pre-wrap ${testUserStatus.startsWith('✅') ? 'bg-green-50 dark:bg-green-900/20 text-green-700' : testUserStatus.startsWith('❌') ? 'bg-red-50 dark:bg-red-900/20 text-red-600' : 'bg-slate-50 dark:bg-slate-900 text-slate-600'}`}>
                                    {testUserStatus}
                                </pre>
                            )}
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