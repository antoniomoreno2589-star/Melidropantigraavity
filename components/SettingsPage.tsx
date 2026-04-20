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

const DEFAULT_DESCRIPTION_SUFFIX = `==========================================
IMPORTANTE:
Este producto se importa de Estados Unidos
Por favor revisa la fecha de entrega antes de comprar
==========================================

Este producto ha sido seleccionado cuidadosamente para ofrecerte la mejor calidad y desempeño. Ideal para quienes buscan confiabilidad y funcionalidad en su compra.

¿Por qué elegirnos?

Factura disponible: Al realizar tu compra, solicítanos la factura y con gusto te la enviaremos.
Garantía de 30 días: Si no quedas satisfecho con el producto o presenta algún defecto, puedes realizar devoluciones sin problema durante los primeros 30 días.
Compra con confianza, estamos comprometidos en ofrecerte productos de excelente calidad y un servicio de atención al cliente sobresaliente.

¡Haz tu compra ahora y recibe tu producto en la puerta de tu hogar!`;

export const SettingsPage = () => {
    const [testUser, setTestUser] = useState<any>(null);
    const [testUserLoading, setTestUserLoading] = useState(false);
    const [testUserEmail, setTestUserEmail] = useState('');
    const [testUserPassword, setTestUserPassword] = useState('');
    const [testUserStatus, setTestUserStatus] = useState<string>('');

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
        const creds = JSON.parse(localStorage.getItem('melidrop_meli_credentials') || '{}');
        if (!creds.appId) {
            setTestUserStatus('❌ Primero conecta tu cuenta real de MercadoLibre en la sección Perfil.');
            return;
        }

        // Generate PKCE (required by ML apps that have it enabled)
        const array = new Uint8Array(32);
        window.crypto.getRandomValues(array);
        const verifier = btoa(String.fromCharCode(...Array.from(array))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        const hashBuf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        const challenge = btoa(String.fromCharCode(...new Uint8Array(hashBuf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        sessionStorage.setItem('test_oauth_verifier', verifier);

        const redirectUri = encodeURIComponent(`${window.location.origin}/perfil`);
        const site = localStorage.getItem('meli_auth_site_domain') || 'mx';
        const authUrl = `https://auth.mercadolibre.com.${site}/authorization?response_type=code&client_id=${creds.appId}&redirect_uri=${redirectUri}&code_challenge=${challenge}&code_challenge_method=S256&state=test_user`;

        const popup = window.open(authUrl, 'ml_test_oauth', 'width=520,height=720,left=200,top=100');
        if (!popup) {
            setTestUserStatus('❌ Permite las ventanas emergentes en tu navegador e intenta de nuevo.');
            return;
        }

        setTestUserLoading(true);
        setTestUserStatus('Iniciá sesión en la ventana emergente con las credenciales del usuario de prueba...');

        const handleMessage = async (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return;
            if (event.data?.type !== 'ml_oauth_code' || event.data?.state !== 'test_user') return;
            window.removeEventListener('message', handleMessage);
            clearInterval(pollTimer);
            popup.close();

            try {
                const storedVerifier = sessionStorage.getItem('test_oauth_verifier');
                sessionStorage.removeItem('test_oauth_verifier');
                const body = new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: creds.appId,
                    client_secret: creds.secret,
                    code: event.data.code,
                    redirect_uri: `${window.location.origin}/perfil`,
                    ...(storedVerifier ? { code_verifier: storedVerifier } : {})
                });
                setTestUserStatus('Obteniendo token...');
                const response = await fetch('/api/proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: 'https://api.mercadolibre.com/oauth/token',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                        body: body.toString()
                    })
                });
                if (!response.ok) { const err = await response.json(); throw new Error(err.message || 'Error al obtener token'); }
                const data = await response.json();

                let email = testUserEmail || 'Usuario de prueba';
                try {
                    const userRes = await fetch('/api/proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: 'https://api.mercadolibre.com/users/me', method: 'GET', headers: { 'Authorization': `Bearer ${data.access_token}` } })
                    });
                    if (userRes.ok) { const info = await userRes.json(); email = info.email || info.nickname || email; }
                } catch { /* use default */ }

                const testUserData = { email, access_token: data.access_token, connected_at: new Date().toISOString() };
                const { data: { user } } = await supabase.auth.getUser();
                if (user) await supabase.from('user_connections').upsert({ user_id: user.id, meli_test_user: testUserData }, { onConflict: 'user_id' });
                setTestUser(testUserData);
                setTestUserStatus('✅ Usuario de prueba conectado. Ya puedes usar "Probar (Sandbox)" en el importador.');
            } catch (e: any) {
                setTestUserStatus(`❌ Error: ${e.message}`);
            } finally {
                setTestUserLoading(false);
            }
        };

        window.addEventListener('message', handleMessage);
        const pollTimer = setInterval(() => {
            if (popup.closed) {
                clearInterval(pollTimer);
                window.removeEventListener('message', handleMessage);
                setTestUserLoading(false);
                setTestUserStatus(prev => prev.startsWith('✅') ? prev : 'Ventana cerrada sin autorizar.');
            }
        }, 1000);
    };

    const handleVerifyTestUser = async () => {
        if (!testUser?.access_token) return;
        setTestUserStatus('Verificando token...');
        try {
            const res = await fetch('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.mercadolibre.com/users/me',
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${testUser.access_token}` }
                })
            });
            const data = await res.json();
            if (res.ok && data.id) {
                setTestUserStatus(`✅ Token válido — Usuario: ${data.nickname} (ID: ${data.id})`);
            } else {
                setTestUserStatus(`❌ Token inválido o expirado — ${data.message || res.status}. Usa "Renovar token".`);
            }
        } catch (e: any) {
            setTestUserStatus(`❌ Error al verificar: ${e.message}`);
        }
    };

    const handleDisconnectTestUser = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await supabase.from('user_connections').update({ meli_test_user: null }).eq('user_id', user.id);
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
    const [usaDeliveryDays, setUsaDeliveryDays] = useState<number>(() => parseInt(localStorage.getItem('melidrop_amazon_delivery_usa') || '5'));
    const [mxDeliveryDays, setMxDeliveryDays] = useState<number>(() => parseInt(localStorage.getItem('melidrop_amazon_delivery_mx') || '3'));
    const [postalCode, setPostalCode] = useState<string>(() => localStorage.getItem('melidrop_postal_code') || '');
    const [usaDefaultMargin, setUsaDefaultMargin] = useState<number>(30);
    const [mxDefaultMargin, setMxDefaultMargin] = useState<number>(20);
    const [isUpdatingDolar, setIsUpdatingDolar] = useState(false);
    const [globalFilters, setGlobalFilters] = useState("Nike\nAdidas\nReacondicionado");

    const [warrantyMonths, setWarrantyMonths] = useState<number>(() =>
        parseInt(localStorage.getItem('melidrop_warranty_months') || '1')
    );
    const [descriptionSuffix, setDescriptionSuffix] = useState<string>(() =>
        localStorage.getItem('melidrop_description_suffix') ?? DEFAULT_DESCRIPTION_SUFFIX
    );
    const [syncParams, setSyncParams] = useState<{ price: boolean; stock: boolean; shipping: boolean; description: boolean }>(() => {
        const saved = localStorage.getItem('melidrop_sync_params');
        return saved ? JSON.parse(saved) : { price: true, stock: true, shipping: false, description: false };
    });
    const [defaultStock, setDefaultStock] = useState<number>(() =>
        parseInt(localStorage.getItem('melidrop_default_stock') || '3')
    );
    const [autoPromos, setAutoPromos] = useState<boolean>(() =>
        localStorage.getItem('melidrop_auto_promos') === 'true'
    );
    const [allowPriceDecrease, setAllowPriceDecrease] = useState<boolean>(() =>
        localStorage.getItem('melidrop_allow_price_decrease') === 'true'
    );
    const [syncFrequencyHours, setSyncFrequencyHours] = useState<number>(() =>
        parseInt(localStorage.getItem('melidrop_sync_frequency_hours') || '24')
    );

    const UPDATER_URL = `https://gbdrxwfywxvyoxroqcut.supabase.co/functions/v1/amazon-ml-updater`;
    const ANON_KEY    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdiZHJ4d2Z5d3h2eW94cm9xY3V0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkxMzU1MTQsImV4cCI6MjA4NDcxMTUxNH0.8bGbL6bKSfGShizUiijZIJqRdyO_72hecEujK3vYvr4';

    const [syncRunning, setSyncRunning]   = useState(false);
    const [syncResult,  setSyncResult]    = useState<string>('');
    const [lastJob,     setLastJob]       = useState<any>(null);

    useEffect(() => {
        const fetchLastJob = async () => {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;
            const { data } = await supabase
                .from('sync_jobs')
                .select('*')
                .eq('user_id', user.id)
                .order('started_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            if (data) setLastJob(data);
        };
        fetchLastJob();
    }, []);

    const handleRunNow = async () => {
        setSyncRunning(true);
        setSyncResult('Ejecutando sincronización...');
        try {
            const res = await fetch(UPDATER_URL, {
                method:  'POST',
                headers: { 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
                body:    '{}',
            });
            const data = await res.json();
            if (data.success) {
                const s = data.summary?.[0];
                if (s?.skipped)   setSyncResult(`⏳ No es necesario aún (próxima sincronización en ${syncFrequencyHours}h).`);
                else if (s)       setSyncResult(`✅ Lote procesado: ${s.updated} actualizados, ${s.errors} errores. Offset: ${s.offset}/${lastJob?.total_products ?? '?'}`);
                else              setSyncResult('✅ Sincronización ejecutada (sin productos pendientes).');

                // Refresh job status
                const { data: { user } } = await supabase.auth.getUser();
                if (user) {
                    const { data: job } = await supabase.from('sync_jobs').select('*').eq('user_id', user.id).order('started_at', { ascending: false }).limit(1).maybeSingle();
                    if (job) setLastJob(job);
                }
            } else {
                setSyncResult(`❌ Error: ${data.error}`);
            }
        } catch (e: any) {
            setSyncResult(`❌ Error de red: ${e.message}`);
        } finally {
            setSyncRunning(false);
        }
    };

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
        localStorage.setItem('melidrop_amazon_delivery_usa', usaDeliveryDays.toString());
        localStorage.setItem('melidrop_amazon_delivery_mx', mxDeliveryDays.toString());
        localStorage.setItem('melidrop_postal_code', postalCode);
        localStorage.setItem('melidrop_warranty_months', warrantyMonths.toString());
        localStorage.setItem('melidrop_description_suffix', descriptionSuffix);
        localStorage.setItem('melidrop_sync_params', JSON.stringify(syncParams));
        localStorage.setItem('melidrop_default_stock', defaultStock.toString());
        localStorage.setItem('melidrop_auto_promos', autoPromos.toString());
        localStorage.setItem('melidrop_allow_price_decrease', allowPriceDecrease.toString());
        localStorage.setItem('melidrop_sync_frequency_hours', syncFrequencyHours.toString());

        // Sync to Supabase
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await supabase.from('user_connections').upsert({
                user_id: user.id,
                exchange_rate: exchangeRate,
                margin_rules: {
                    usa: usaRules, mx: mxRules, filters: globalFilters,
                    handling_time_usa: usaHandlingTime, handling_time_mx: mxHandlingTime,
                    warranty_months: warrantyMonths, default_stock: defaultStock,
                    sync_params: syncParams, auto_promos: autoPromos,
                    allow_price_decrease: allowPriceDecrease, sync_frequency_hours: syncFrequencyHours
                }
            }, { onConflict: 'user_id' });
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

                    {/* POSTAL CODE */}
                    <div className="lg:col-span-2 bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                        <div className="p-2 rounded-lg bg-indigo-100 text-indigo-600 flex-shrink-0">
                            <span className="material-symbols-outlined">pin_drop</span>
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-black text-slate-900 dark:text-white">Código Postal de tu Bodega / Domicilio</p>
                            <p className="text-xs text-slate-500 mt-0.5">Se usa para estimar tiempos de entrega de Amazon a tu ubicación. Ingresa los días manualmente en cada sección.</p>
                        </div>
                        <div className="relative w-40 flex-shrink-0">
                            <input
                                type="text"
                                maxLength={10}
                                value={postalCode}
                                onChange={e => setPostalCode(e.target.value.replace(/\D/g, ''))}
                                placeholder="64000"
                                className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black text-center tracking-widest"
                            />
                        </div>
                        <button onClick={() => handleSaveSection('Código Postal')} className="flex-shrink-0 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-lg text-xs transition-all">
                            Guardar CP
                        </button>
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
                                <p className="text-[10px] text-slate-400 italic">Días de tu proceso interno antes de enviar al cliente.</p>
                            </div>
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-semibold text-slate-500 uppercase flex items-center gap-1">
                                    <span className="material-symbols-outlined text-[14px] text-blue-500">local_shipping</span>
                                    Amazon USA → Tu bodega (días de entrega)
                                </label>
                                <div className="relative">
                                    <input
                                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black"
                                        type="number" min="1" max="30"
                                        value={usaDeliveryDays}
                                        onChange={(e) => setUsaDeliveryDays(Math.max(1, parseInt(e.target.value) || 1))}
                                    />
                                    <span className="absolute right-3 top-2 text-slate-400 text-xs">días</span>
                                </div>
                                <div className="bg-slate-100 dark:bg-slate-800 rounded-lg px-3 py-2 flex items-center justify-between">
                                    <span className="text-xs text-slate-500">Total handling_time en ML:</span>
                                    <span className="text-sm font-black text-primary">{usaDeliveryDays + usaHandlingTime} días</span>
                                </div>
                                <p className="text-[10px] text-slate-400 italic">ML esperará este total antes de exigirte el envío al cliente.</p>
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
                                <p className="text-[10px] text-slate-400 italic">Días de tu proceso interno antes de enviar al cliente.</p>
                            </div>
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-semibold text-slate-500 uppercase flex items-center gap-1">
                                    <span className="material-symbols-outlined text-[14px] text-blue-500">local_shipping</span>
                                    Amazon MX → Tu bodega (días de entrega)
                                </label>
                                <div className="relative">
                                    <input
                                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black"
                                        type="number" min="1" max="30"
                                        value={mxDeliveryDays}
                                        onChange={(e) => setMxDeliveryDays(Math.max(1, parseInt(e.target.value) || 1))}
                                    />
                                    <span className="absolute right-3 top-2 text-slate-400 text-xs">días</span>
                                </div>
                                <div className="bg-slate-100 dark:bg-slate-800 rounded-lg px-3 py-2 flex items-center justify-between">
                                    <span className="text-xs text-slate-500">Total handling_time en ML:</span>
                                    <span className="text-sm font-black text-primary">{mxDeliveryDays + mxHandlingTime} días</span>
                                </div>
                                <p className="text-[10px] text-slate-400 italic">ML esperará este total antes de exigirte el envío al cliente.</p>
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
                                        {testUser.password && <p className="text-xs text-green-600 mt-0.5 font-mono">Contraseña: {testUser.password}</p>}
                                        <p className="text-xs text-green-600 mt-0.5">Conectado: {new Date(testUser.connected_at).toLocaleDateString('es-MX')}</p>
                                    </div>
                                    <div className="flex gap-3">
                                    <button onClick={handleVerifyTestUser} className="text-xs text-green-600 hover:text-green-800 font-bold flex items-center gap-1">
                                        <span className="material-symbols-outlined text-[14px]">check_circle</span>Verificar token
                                    </button>
                                    <button onClick={handleConnectTestUser} disabled={testUserLoading} className="text-xs text-blue-500 hover:text-blue-700 font-bold flex items-center gap-1">
                                        <span className="material-symbols-outlined text-[14px]">refresh</span>Renovar token
                                    </button>
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
                                            <li>Crea un usuario de prueba con el botón de abajo</li>
                                            <li>Anota el email y contraseña que aparecen</li>
                                            <li>Haz click en "Conectar con OAuth" e inicia sesión con esas credenciales</li>
                                            <li>"Probar (Sandbox)" publicará en esa cuenta de prueba</li>
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
                                    {testUserEmail && (
                                        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl p-3 text-xs font-mono text-amber-800 dark:text-amber-300 space-y-1">
                                            <p><span className="font-black">Email:</span> {testUserEmail}</p>
                                            {testUserPassword && <p><span className="font-black">Contraseña:</span> {testUserPassword}</p>}
                                            <p className="text-amber-600 text-[10px] mt-1">Anota estas credenciales — las necesitarás en el paso siguiente</p>
                                        </div>
                                    )}
                                    <button
                                        onClick={handleConnectTestUser}
                                        disabled={testUserLoading}
                                        className="w-full py-2.5 bg-slate-900 dark:bg-white dark:text-slate-900 text-white font-black rounded-xl text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        {testUserLoading ? <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : <span className="material-symbols-outlined text-[18px]">open_in_new</span>}
                                        Conectar con OAuth
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

                    {/* DEBUG: TEST USER STATUS */}
                    <div className="lg:col-span-2 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-xl p-6 flex flex-col gap-4">
                        <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">bug_report</span>
                            <h3 className="text-lg font-bold text-blue-900 dark:text-blue-200">🔧 Estado de Conexión Supabase</h3>
                        </div>
                        <div className="space-y-2">
                            {testUser?.access_token ? (
                                <>
                                    <p className="text-sm text-green-700 dark:text-green-300">✅ <strong>Usuario Conectado:</strong> {testUser.nickname || testUser.email}</p>
                                    <p className="text-xs text-slate-600 dark:text-slate-400">Email: {testUser.email}</p>
                                </>
                            ) : testUser?.nickname ? (
                                <>
                                    <p className="text-sm text-amber-700 dark:text-amber-300">⚠️ <strong>Usuario Existe pero SIN Access Token:</strong> {testUser.nickname}</p>
                                    <p className="text-xs text-slate-600 dark:text-slate-400">Necesitas completar la conexión OAuth.</p>
                                </>
                            ) : (
                                <p className="text-sm text-red-700 dark:text-red-300">❌ <strong>Sin usuario de prueba conectado</strong></p>
                            )}
                            {testUserStatus && (
                                <p className={`text-xs font-mono mt-2 ${testUserStatus.startsWith('✅') ? 'text-green-700 dark:text-green-300' : testUserStatus.startsWith('❌') ? 'text-red-700 dark:text-red-300' : 'text-slate-600 dark:text-slate-400'}`}>
                                    {testUserStatus}
                                </p>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={handleVerifyTestUser}
                                disabled={testUserLoading || !testUser?.access_token}
                                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white font-bold rounded-lg text-sm transition-all flex items-center justify-center gap-2"
                            >
                                <span className="material-symbols-outlined text-[16px]">check_circle</span>
                                Verificar Token
                            </button>
                            {testUser && (
                                <button
                                    onClick={handleDisconnectTestUser}
                                    className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg text-sm transition-all flex items-center justify-center gap-2"
                                >
                                    <span className="material-symbols-outlined text-[16px]">logout</span>
                                    Desconectar
                                </button>
                            )}
                        </div>
                    </div>

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

                    {/* GARANTÍA Y DESCRIPCIÓN */}
                    <section className="flex flex-col lg:col-span-2 bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-emerald-100 text-emerald-600">
                                <span className="material-symbols-outlined">verified_user</span>
                            </div>
                            <h2 className="text-lg font-bold text-slate-900 dark:text-white uppercase tracking-tighter">Garantía y Descripción</h2>
                        </div>
                        <div className="p-6 space-y-6">
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-black text-slate-500 uppercase">Garantía por Defecto</label>
                                <div className="flex items-center gap-3">
                                    <div className="relative w-40">
                                        <input
                                            type="number" min="0" max="60"
                                            value={warrantyMonths}
                                            onChange={e => setWarrantyMonths(Math.max(0, parseInt(e.target.value) || 0))}
                                            className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black"
                                        />
                                        <span className="absolute right-3 top-2 text-slate-400 text-xs">meses</span>
                                    </div>
                                </div>
                                <p className="text-[10px] text-slate-400 italic">Se enviará como "Garantía del vendedor: N mes(es)" en cada publicación de MercadoLibre.</p>
                            </div>
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-black text-slate-500 uppercase">Texto Adicional en Todas las Descripciones</label>
                                <p className="text-[10px] text-slate-500">Se agrega al final de la descripción tomada de Amazon en cada publicación.</p>
                                <textarea
                                    value={descriptionSuffix}
                                    onChange={e => setDescriptionSuffix(e.target.value)}
                                    rows={12}
                                    className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-4 py-3 text-sm font-mono focus:ring-primary resize-y"
                                />
                            </div>
                        </div>
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800">
                            <button onClick={() => handleSaveSection('Garantía y Descripción')} className="w-full bg-slate-800 hover:bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white font-black py-3 px-4 rounded-xl shadow-sm transition-all flex items-center justify-center gap-2 text-sm uppercase">
                                <span className="material-symbols-outlined text-[18px]">save</span>
                                Guardar Garantía y Descripción
                            </button>
                        </div>
                    </section>

                    {/* ACTUALIZADOR */}
                    <section className="flex flex-col lg:col-span-2 bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
                                <span className="material-symbols-outlined">sync</span>
                            </div>
                            <h2 className="text-lg font-bold text-slate-900 dark:text-white uppercase tracking-tighter">Actualizador Amazon → MercadoLibre</h2>
                        </div>
                        <div className="p-6 space-y-6">
                            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
                                <p className="font-black text-amber-800 dark:text-amber-200 text-sm flex items-center gap-2">
                                    <span className="material-symbols-outlined text-[18px]">info</span>
                                    Recomendación para +20,000 publicaciones
                                </p>
                                <p className="text-xs text-amber-700 dark:text-amber-300 mt-2 leading-relaxed">
                                    La API de MercadoLibre permite ~3,600 req/hora. Actualizar 20k productos de golpe tomaría más de 5h solo en llamadas a ML,
                                    más las consultas a Amazon SP-API. El sistema procesa en <strong>lotes de 200 productos con pausas de 5 min</strong> entre lotes
                                    → ciclo completo de 20k en ~10h, sin riesgo de bloqueo. <strong>Frecuencia recomendada: 1 vez al día.</strong>
                                </p>
                            </div>

                            <div>
                                <label className="text-xs font-black text-slate-500 uppercase mb-3 block">Parámetros a Sincronizar</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {([
                                        { key: 'price',       label: '💰 Precio',          desc: 'Actualiza el precio según Amazon' },
                                        { key: 'stock',       label: '📦 Stock',            desc: 'Sincroniza disponibilidad' },
                                        { key: 'shipping',    label: '🚚 Tiempo de envío',  desc: 'Actualiza handling_time' },
                                        { key: 'description', label: '📝 Descripción',      desc: 'Sincroniza descripción del producto' },
                                    ] as const).map(p => (
                                        <label key={p.key} className="flex items-start gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                                            <input
                                                type="checkbox"
                                                checked={syncParams[p.key]}
                                                onChange={e => setSyncParams((prev: typeof syncParams) => ({ ...prev, [p.key]: e.target.checked }))}
                                                className="mt-0.5 accent-primary"
                                            />
                                            <div>
                                                <p className="text-sm font-bold text-slate-900 dark:text-white">{p.label}</p>
                                                <p className="text-xs text-slate-500">{p.desc}</p>
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-black text-slate-500 uppercase">Stock por Defecto al Importar</label>
                                <div className="relative w-40">
                                    <input
                                        type="number" min="1" max="999"
                                        value={defaultStock}
                                        onChange={e => setDefaultStock(Math.max(1, parseInt(e.target.value) || 1))}
                                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black"
                                    />
                                    <span className="absolute right-3 top-2 text-slate-400 text-xs">pzas</span>
                                </div>
                                <p className="text-[10px] text-slate-400 italic">Cantidad disponible asignada a cada publicación nueva en MercadoLibre.</p>
                            </div>

                            <div>
                                <label className="text-xs font-black text-slate-500 uppercase mb-3 block">Opciones de Precio</label>
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-700">
                                        <div>
                                            <p className="text-sm font-bold text-slate-900 dark:text-white">🎯 Crear Promociones Automáticas</p>
                                            <p className="text-xs text-slate-500">Cuando Amazon baja el precio, crea una promoción en MercadoLibre.</p>
                                        </div>
                                        <div onClick={() => setAutoPromos(v => !v)}
                                            className={`w-12 h-6 rounded-full transition-all cursor-pointer relative flex-shrink-0 ml-4 ${autoPromos ? 'bg-primary' : 'bg-slate-200 dark:bg-slate-700'}`}>
                                            <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${autoPromos ? 'left-6' : 'left-0.5'}`} />
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-700">
                                        <div>
                                            <p className="text-sm font-bold text-slate-900 dark:text-white">📉 Permitir Fluctuación de Precios (Bajas)</p>
                                            <p className="text-xs text-slate-500">Desactivado: el precio solo sube. Activado: sigue los cambios de Amazon en ambas direcciones.</p>
                                        </div>
                                        <div onClick={() => setAllowPriceDecrease(v => !v)}
                                            className={`w-12 h-6 rounded-full transition-all cursor-pointer relative flex-shrink-0 ml-4 ${allowPriceDecrease ? 'bg-primary' : 'bg-slate-200 dark:bg-slate-700'}`}>
                                            <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${allowPriceDecrease ? 'left-6' : 'left-0.5'}`} />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div>
                                <label className="text-xs font-black text-slate-500 uppercase mb-3 block">Frecuencia de Actualización</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {([
                                        { hours: 24,  label: 'Cada día',    badge: '✓ Recomendado', color: 'text-green-600' },
                                        { hours: 72,  label: 'Cada 3 días', badge: 'Moderado',       color: 'text-blue-600'  },
                                        { hours: 120, label: 'Cada 5 días', badge: 'Conservador',    color: 'text-slate-500' },
                                    ] as const).map(opt => (
                                        <button key={opt.hours} onClick={() => setSyncFrequencyHours(opt.hours)}
                                            className={`p-3 rounded-xl border-2 text-left transition-all ${syncFrequencyHours === opt.hours ? 'border-primary bg-primary/5' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}>
                                            <p className="font-bold text-slate-900 dark:text-white text-sm">{opt.label}</p>
                                            <p className={`text-xs font-black ${opt.color}`}>{opt.badge}</p>
                                        </button>
                                    ))}
                                </div>
                                <p className="text-[10px] text-slate-400 italic mt-2">
                                    Lotes de 200 productos por ejecución (cron cada 10 min). Ciclo completo de 20k ≈ 17h.
                                </p>
                            </div>
                        </div>
                        {/* Sync status */}
                        {lastJob && (
                            <div className="px-6 pb-4">
                                <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-2">
                                    <p className="text-xs font-black text-slate-500 uppercase tracking-widest">Estado del Ciclo Actual</p>
                                    <div className="flex items-center gap-2">
                                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${lastJob.status === 'running' ? 'bg-blue-500 animate-pulse' : lastJob.status === 'completed' ? 'bg-green-500' : 'bg-red-500'}`} />
                                        <span className="text-sm font-bold text-slate-700 dark:text-slate-300 capitalize">
                                            {lastJob.status === 'running' ? 'En progreso' : lastJob.status === 'completed' ? 'Completado' : 'Fallido'}
                                        </span>
                                    </div>
                                    {lastJob.total_products > 0 && (
                                        <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                                            <div
                                                className="bg-primary h-2 rounded-full transition-all"
                                                style={{ width: `${Math.min(100, (lastJob.processed_count / lastJob.total_products) * 100)}%` }}
                                            />
                                        </div>
                                    )}
                                    <div className="grid grid-cols-3 gap-2 text-center">
                                        <div>
                                            <p className="text-lg font-black text-slate-900 dark:text-white">{lastJob.processed_count?.toLocaleString()}</p>
                                            <p className="text-[10px] text-slate-400 uppercase">Procesados</p>
                                        </div>
                                        <div>
                                            <p className="text-lg font-black text-green-600">{lastJob.updated_count?.toLocaleString()}</p>
                                            <p className="text-[10px] text-slate-400 uppercase">Actualizados</p>
                                        </div>
                                        <div>
                                            <p className="text-lg font-black text-red-500">{lastJob.error_count?.toLocaleString()}</p>
                                            <p className="text-[10px] text-slate-400 uppercase">Errores</p>
                                        </div>
                                    </div>
                                    {lastJob.started_at && (
                                        <p className="text-[10px] text-slate-400">
                                            Iniciado: {new Date(lastJob.started_at).toLocaleString('es-MX')}
                                            {lastJob.finished_at && ` · Terminado: ${new Date(lastJob.finished_at).toLocaleString('es-MX')}`}
                                        </p>
                                    )}
                                </div>
                                {syncResult && (
                                    <p className={`mt-2 text-xs font-mono ${syncResult.startsWith('✅') ? 'text-green-600' : syncResult.startsWith('❌') ? 'text-red-500' : 'text-slate-500'}`}>
                                        {syncResult}
                                    </p>
                                )}
                            </div>
                        )}

                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex gap-3">
                            <button onClick={() => handleSaveSection('Actualizador')} className="flex-1 bg-slate-800 hover:bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white font-black py-3 px-4 rounded-xl shadow-sm transition-all flex items-center justify-center gap-2 text-sm uppercase">
                                <span className="material-symbols-outlined text-[18px]">save</span>
                                Guardar
                            </button>
                            <button
                                onClick={handleRunNow}
                                disabled={syncRunning}
                                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-black py-3 px-4 rounded-xl shadow-sm transition-all flex items-center justify-center gap-2 text-sm uppercase"
                            >
                                {syncRunning
                                    ? <><span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />Ejecutando...</>
                                    : <><span className="material-symbols-outlined text-[18px]">play_arrow</span>Ejecutar Ahora</>
                                }
                            </button>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
};