
import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

type AccountType = 'amazon' | 'meli' | null;
type ConnectStep = 'input' | 'processing' | 'success';

// Global guard for React 18 double-mounts
const codesInExchange = new Set<string>();

export const ProfilePage = () => {
    const navigate = useNavigate();
    console.log(">>> ProfilePage Mounting/Rendering <<<");
    const [searchParams, setSearchParams] = useSearchParams();
    const [connectModal, setConnectModal] = useState<AccountType>(null);
    const [connectStep, setConnectStep] = useState<ConnectStep>('input');

    const [meliAppId, setMeliAppId] = useState('');
    const [meliSecret, setMeliSecret] = useState('');
    const [meliSite, setMeliSite] = useState(() => localStorage.getItem('meli_auth_site_domain') || 'mx');
    const [errorMessage, setErrorMessage] = useState('');

    // Real State for connections from LocalStorage
    const [accounts, setAccounts] = useState(() => {
        const saved = localStorage.getItem('melidrop_connected_accounts');
        const initial = saved ? JSON.parse(saved) : { amazon: false, meli: false };
        // Priority: If real credentials exist, the account IS connected
        if (localStorage.getItem('melidrop_meli_credentials')) {
            initial.meli = true;
        }
        return initial;
    });

    useEffect(() => {
        localStorage.setItem('melidrop_connected_accounts', JSON.stringify(accounts));
        console.log("Accounts state updated and saved:", accounts);
    }, [accounts]);

    const checkStoredCredentials = () => {
        const stored = localStorage.getItem('melidrop_meli_credentials');
        const tempId = localStorage.getItem('temp_meli_app_id');
        const tempSecret = localStorage.getItem('temp_meli_secret');

        console.log("Storage Check:", {
            origin: window.location.origin,
            hasStoredCreds: !!stored,
            hasTempId: !!tempId,
            hasTempSecret: !!tempSecret
        });

        if (stored) {
            const data = JSON.parse(stored);
            console.log("Found stored credentials for:", data.nickname);
            if (!accounts.meli) {
                console.log("Account was connected but state was out of sync. Fixing...");
                setAccounts(prev => ({ ...prev, meli: true }));
            }
        }
    };

    useEffect(() => {
        checkStoredCredentials();
    }, []);

    const handleHardReset = () => {
        console.log("Performing Hard Reset of Meli connection state...");
        localStorage.removeItem('melidrop_meli_credentials');
        localStorage.removeItem('temp_meli_app_id');
        localStorage.removeItem('temp_meli_secret');
        localStorage.removeItem('temp_meli_code_verifier');
        localStorage.removeItem('melidrop_connected_accounts');
        setAccounts({ amazon: false, meli: false });
        setErrorMessage('');
        setConnectStep('input');
        setSearchParams({});
        codesInExchange.clear();
        alert("Caché limpiada. Por favor, intenta conectar de nuevo desde cero.");
    };

    // Auto-close modal if connected
    useEffect(() => {
        if (accounts.meli && connectModal === 'meli' && connectStep !== 'success') {
            setConnectStep('success');
        }
    }, [accounts.meli, connectModal]);

    const isExchanging = React.useRef(false);

    // Handle OAuth Callback
    useEffect(() => {
        // Always try getting code from direct URL search (query string), not from React Router's searchParams
        // because OAuth redirects come as ?code=...&state=... not #?code=...&state=...
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const state = urlParams.get('state');

        console.log("ProfilePage: Checking OAuth callback", { code: code?.substring(0, 20), state, url: window.location.href });

        if (!code) return;

        // If this is a test user OAuth request, send postMessage to parent window instead of handling locally
        if (state === 'test_user') {
            console.log("✅ Test user OAuth detected", { state, hasOpener: !!window.opener, code: code?.substring(0, 20) });
            if (window.opener) {
                console.log("📤 Sending postMessage to parent window...");
                try {
                    window.opener.postMessage({ type: 'ml_oauth_code', code, state }, window.location.origin);
                    console.log("✅ postMessage sent successfully");
                } catch (e) {
                    console.error("❌ Error sending postMessage:", e);
                }
            } else {
                console.warn("⚠️ window.opener is null - popup might not have been opened via window.open()");
            }
            return;
        }

        // If we already have stored credentials, don't try to exchange the code again
        // (Mercado Libre codes are one-time use, and page refreshes trigger this effect again)
        if (localStorage.getItem('melidrop_meli_credentials')) {
            console.log("Credentials already exist. Cleaning up URL and skipping exchange.");
            setSearchParams({});
            // Clean up the URL query string too (the part before the #)
            if (window.location.search.includes('code=')) {
                window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
            }
            return;
        }

        const storedAppId = localStorage.getItem('temp_meli_app_id');
        const storedSecret = localStorage.getItem('temp_meli_secret');
        const storedVerifier = localStorage.getItem('temp_meli_code_verifier');

        console.log("--- Meli OAuth Initial Check ---", {
            code,
            hasStoredAppId: !!storedAppId,
            hasStoredSecret: !!storedSecret,
            hasStoredVerifier: !!storedVerifier,
            url: window.location.href
        });

        if (code && storedAppId && storedSecret) {
            if (codesInExchange.has(code)) return;
            codesInExchange.add(code);

            console.log("Meli OAuth Callback detected. Proceeding to exchange...");
            setConnectModal('meli');
            setConnectStep('processing');

            // Wait a bit before clearing params to ensure we don't trigger a re-render that cancels the effect
            // Actually, let's NOT clear them until we are DONE.

            const exchangeToken = async () => {
                console.log("Exchanging code for token...");
                try {
                    const redirectUri = `${window.location.origin}/perfil`;
                    const bodyParams: any = {
                        grant_type: 'authorization_code',
                        client_id: storedAppId,
                        client_secret: storedSecret,
                        code: code,
                        redirect_uri: redirectUri
                    };

                    if (storedVerifier) {
                        bodyParams.code_verifier = storedVerifier;
                        console.log("Adding code_verifier to request");
                    }

                    const body = new URLSearchParams(bodyParams);

                    // Usamos el proxy para el intercambio del token
                    const response = await fetch('/api/proxy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            url: 'https://api.mercadolibre.com/oauth/token',
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                'Accept': 'application/json'
                            },
                            body: body.toString()
                        })
                    });

                    if (!response.ok) {
                        const err = await response.json();
                        throw new Error(err.message || 'Error al obtener token');
                    }

                    const data = await response.json();
                    console.log("Token received successfully through Proxy", { userId: data.user_id });

                    const newCreds = {
                        appId: storedAppId,
                        secret: storedSecret,
                        token: data.access_token,
                        refreshToken: data.refresh_token,
                        nickname: `Usuario ${data.user_id || ''}`,
                        id: data.user_id,
                        expiresAt: Date.now() + (data.expires_in * 1000)
                    };

                    try {
                        const userResponse = await fetch('/api/proxy', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                url: `https://api.mercadolibre.com/users/me`,
                                method: 'GET',
                                headers: { 'Authorization': `Bearer ${data.access_token}` }
                            })
                        });
                        if (userResponse.ok) {
                            const userData = await userResponse.ok ? await userResponse.json() : null;
                            if (userData) {
                                newCreds.nickname = userData.nickname;
                                console.log("User info received through Proxy:", newCreds.nickname);
                            }
                        }
                    } catch (infoErr) {
                        console.warn("Proxy error fetching user info", infoErr);
                    }

                    // Save Credentials
                    localStorage.setItem('melidrop_meli_credentials', JSON.stringify(newCreds));
                    console.log("Credentials saved to localStorage");

                    // Cleanup temps
                    localStorage.removeItem('temp_meli_app_id');
                    localStorage.removeItem('temp_meli_secret');
                    localStorage.removeItem('temp_meli_code_verifier');
                    console.log("SUCCESS CHECKPOINT: Credentials saved and temps cleared.");

                    setAccounts(prev => ({ ...prev, meli: true }));
                    setConnectStep('success');
                    console.log("SUCCESS CHECKPOINT: State updated to connected.");

                    // Now clear search params
                    setSearchParams({});

                } catch (error: any) {
                    console.error("OAuth Error:", error);

                    // If we already have credentials, this might be a redundant "already used" error
                    if (localStorage.getItem('melidrop_meli_credentials')) {
                        console.log("Redundant error detected, but we have credentials. Treating as success.");
                        setAccounts(prev => ({ ...prev, meli: true }));
                        setConnectStep('success');
                        setSearchParams({});
                    } else {
                        setErrorMessage(error.message || 'Error en la conexión con Mercado Libre');
                        setConnectStep('input');
                    }
                } finally {
                    // We don't remove from global set to prevent any retry with same code
                    isExchanging.current = false;
                }
            };

            exchangeToken();
        } else if (code) {
            console.warn("Meli OAuth Callback: Code present but missing storedAppId or storedSecret", { storedAppId, storedSecret });
        }
    }, [searchParams, setSearchParams]);

    const openModal = (type: AccountType) => {
        setConnectStep('input');
        setConnectModal(type);
        setMeliAppId('');
        setMeliSecret('');
        setErrorMessage('');
    };

    const handleDisconnect = (type: 'amazon' | 'meli') => {
        if (confirm(`¿Estás seguro de desconectar ${type === 'amazon' ? 'Amazon' : 'Mercado Libre'}? Dejarás de sincronizar productos.`)) {
            setAccounts(prev => ({ ...prev, [type]: false }));
            if (type === 'meli') {
                localStorage.removeItem('melidrop_meli_credentials');
            }
        }
    };

    const handleConnect = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrorMessage('');

        if (connectModal === 'meli') {
            // Full PKCE Implementation
            const generateVerifier = () => {
                const array = new Uint8Array(32);
                window.crypto.getRandomValues(array);
                return btoa(String.fromCharCode(...Array.from(array)))
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=/g, '');
            };

            const generateChallenge = async (verifier: string) => {
                const encoder = new TextEncoder();
                const data = encoder.encode(verifier);
                const hash = await window.crypto.subtle.digest('SHA-256', data);
                return btoa(String.fromCharCode(...Array.from(new Uint8Array(hash))))
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=/g, '');
            };

            try {
                const codeVerifier = generateVerifier();
                const codeChallenge = await generateChallenge(codeVerifier);

                // Save to localStorage
                localStorage.setItem('temp_meli_app_id', meliAppId);
                localStorage.setItem('temp_meli_secret', meliSecret);
                localStorage.setItem('meli_auth_site_domain', meliSite);
                localStorage.setItem('temp_meli_code_verifier', codeVerifier);

                console.log("PKCE generated and saved", { codeVerifier, codeChallenge });

                const redirectUri = encodeURIComponent(`${window.location.origin}/perfil`);

                // Clear state slightly before redirect to avoid browser "remembering" fields in this state
                setMeliAppId('');
                setMeliSecret('');

                window.location.href = `https://auth.mercadolibre.com.${meliSite}/authorization?response_type=code&client_id=${meliAppId}&redirect_uri=${redirectUri}&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=read:items write:items read:orders write:orders read:questions write:questions read:messages write:messages read:accounts read:payments offline_access`;
            } catch (err) {
                console.error("PKCE Generation failed", err);
                setErrorMessage("Error al generar seguridad PKCE");
            }
        } else {
            // Amazon simulation
            setConnectStep('processing');
            setTimeout(() => {
                setConnectStep('success');
                if (connectModal) {
                    setAccounts(prev => ({ ...prev, [connectModal]: true }));
                }
            }, 1500);
        }
    };

    const closeAndReset = () => {
        setConnectModal(null);
        setConnectStep('input');
    };

    return (
        <div className="flex-1 overflow-y-auto p-6 md:p-10 lg:px-16 scroll-smooth">
            {/* Page Heading */}
            <div className="mb-8">
                <h1 className="text-3xl md:text-4xl font-extrabold text-slate-900 dark:text-white mb-2">Mi Perfil</h1>
                <p className="text-slate-500 dark:text-slate-400 text-base md:text-lg">Gestiona tu información personal, seguridad y cuentas vinculadas.</p>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 max-w-[1200px]">
                {/* Left Column: Personal Information */}
                <div className="xl:col-span-7 flex flex-col gap-8">

                    {/* Personal Info Card */}
                    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                        <div className="p-6 border-b border-slate-200 dark:border-slate-700">
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">Información Personal</h2>
                        </div>
                        <div className="p-6 space-y-6">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <label className="flex flex-col gap-2">
                                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Nombre Completo</span>
                                    <input className="form-input w-full rounded-lg border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white focus:border-primary focus:ring-primary h-12 px-4 transition-colors" type="text" defaultValue="Ricardo González" />
                                </label>
                                <label className="flex flex-col gap-2">
                                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Correo Electrónico</span>
                                    <input className="form-input w-full rounded-lg border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-500 h-12 px-4 cursor-not-allowed" disabled type="email" defaultValue="ricardo@vendedorpro.mx" />
                                    <span className="text-xs text-slate-400 flex items-center gap-1"><span className="material-symbols-outlined text-[14px]">lock</span> Contacta a soporte para cambiar</span>
                                </label>
                                <label className="flex flex-col gap-2">
                                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Número de Teléfono</span>
                                    <input className="form-input w-full rounded-lg border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white focus:border-primary focus:ring-primary h-12 px-4 transition-colors" type="tel" defaultValue="+52 55 1234 5678" />
                                </label>
                                <div className="flex flex-col gap-2">
                                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Contraseña</span>
                                    <div className="flex items-center gap-3">
                                        <div className="flex-1 h-12 bg-slate-100 dark:bg-slate-900 rounded-lg flex items-center px-4 border border-slate-200 dark:border-slate-600">
                                            <span className="text-2xl text-slate-400 mt-2">••••••••••••</span>
                                        </div>
                                        <button className="h-12 px-4 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium text-sm transition-colors whitespace-nowrap">
                                            Cambiar
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-200 dark:border-slate-700 flex justify-end">
                            <button className="bg-primary hover:bg-primary/90 text-white font-medium py-2.5 px-6 rounded-lg transition-colors shadow-sm shadow-primary/20">
                                Guardar Cambios
                            </button>
                        </div>
                    </div>

                    {/* Linked Accounts Card */}
                    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                        <div className="p-6 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">Cuentas Vinculadas</h2>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={checkStoredCredentials}
                                    className="text-xs text-primary hover:underline flex items-center gap-1"
                                    title="Actualizar estado de conexión"
                                >
                                    <span className="material-symbols-outlined text-[14px]">refresh</span>
                                    Sincronizar estado
                                </button>
                                <span className="text-sm text-slate-500 dark:text-slate-400 hidden sm:inline-block">Sincronización automática activa</span>
                            </div>
                        </div>
                        <div className="p-0">
                            {/* Amazon Row */}
                            <div className="p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                                <div className="flex items-center gap-4">
                                    <div className={`size-12 rounded-lg ${accounts.amazon ? 'bg-white dark:bg-slate-700' : 'bg-slate-100 dark:bg-slate-800 grayscale'} shadow-sm border border-slate-200 dark:border-slate-600 flex items-center justify-center p-2`}>
                                        <div className="text-slate-800 dark:text-white font-bold text-xs">AMZ</div>
                                    </div>
                                    <div>
                                        <h3 className="font-bold text-slate-900 dark:text-white">Amazon Seller Central</h3>
                                        {accounts.amazon ? (
                                            <div className="flex items-center gap-1.5 mt-1">
                                                <span className="size-2 rounded-full bg-emerald-500"></span>
                                                <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">Conectado</span>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1.5 mt-1">
                                                <span className="size-2 rounded-full bg-slate-400"></span>
                                                <span className="text-sm text-slate-500 font-medium">Desconectado</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-3 w-full sm:w-auto">
                                    {accounts.amazon && (
                                        <div className="text-xs text-slate-500 text-right hidden sm:block">
                                            Última sync:<br />Hace 5 min
                                        </div>
                                    )}
                                    {accounts.amazon ? (
                                        <button onClick={() => handleDisconnect('amazon')} className="flex-1 sm:flex-none px-4 py-2 border border-red-200 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-600 rounded-lg text-sm font-medium hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors">
                                            Desconectar
                                        </button>
                                    ) : (
                                        <button onClick={() => openModal('amazon')} className="flex-1 sm:flex-none px-4 py-2 bg-slate-800 dark:bg-slate-700 text-white rounded-lg text-sm font-medium hover:bg-slate-900 dark:hover:bg-slate-600 transition-colors">
                                            Conectar Cuenta
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Mercado Libre Row */}
                            <div className="p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                                <div className="flex items-center gap-4">
                                    <div className={`size-12 rounded-lg bg-[#ffe600] shadow-sm border border-yellow-400 flex items-center justify-center p-2 ${!accounts.meli && 'grayscale'}`}>
                                        <div className="text-slate-900 font-bold text-xs">MELI</div>
                                    </div>
                                    <div>
                                        <h3 className="font-bold text-slate-900 dark:text-white">Mercado Libre</h3>
                                        {accounts.meli ? (
                                            <div className="flex items-center gap-1.5 mt-1">
                                                <span className="size-2 rounded-full bg-emerald-500"></span>
                                                <span className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">Conectado</span>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1.5 mt-1">
                                                <span className="size-2 rounded-full bg-slate-400"></span>
                                                <span className="text-sm text-slate-500 font-medium">Desconectado</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-3 w-full sm:w-auto">
                                    {accounts.meli && (
                                        <div className="text-xs text-slate-500 text-right hidden sm:block">
                                            Última sync:<br />Hace 2 min
                                        </div>
                                    )}
                                    {accounts.meli ? (
                                        <button onClick={() => handleDisconnect('meli')} className="flex-1 sm:flex-none px-4 py-2 border border-red-200 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 text-red-600 rounded-lg text-sm font-medium hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors">
                                            Desconectar
                                        </button>
                                    ) : (
                                        <button onClick={() => openModal('meli')} className="flex-1 sm:flex-none px-4 py-2 bg-slate-800 dark:bg-slate-700 text-white rounded-lg text-sm font-medium hover:bg-slate-900 dark:hover:bg-slate-600 transition-colors">
                                            Conectar Cuenta
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Column: Security & Summary */}
                <div className="xl:col-span-5 flex flex-col gap-8">

                    {/* Security Settings */}
                    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                        <div className="p-6 border-b border-slate-200 dark:border-slate-700">
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">Configuración de Seguridad</h2>
                        </div>
                        <div className="p-6 space-y-6">
                            {/* 2FA Toggle */}
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="material-symbols-outlined text-primary text-[20px]">verified_user</span>
                                        <h3 className="text-base font-bold text-slate-900 dark:text-white">Autenticación de Dos Factores (2FA)</h3>
                                    </div>
                                    <p className="text-sm text-slate-500 dark:text-slate-400">Agrega una capa extra de seguridad a tu cuenta.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer mt-1">
                                    <input className="sr-only peer" type="checkbox" value="" />
                                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/20 dark:peer-focus:ring-primary/30 rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary"></div>
                                </label>
                            </div>

                            <hr className="border-slate-100 dark:border-slate-700/50" />

                            {/* Recent Activity */}
                            <div>
                                <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider mb-4">Actividad Reciente</h3>
                                <div className="space-y-4">
                                    <div className="flex items-start gap-3">
                                        <div className="mt-0.5 text-slate-400">
                                            <span className="material-symbols-outlined text-[20px]">devices</span>
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-sm font-medium text-slate-900 dark:text-white">Inicio de sesión exitoso</p>
                                            <p className="text-xs text-slate-500 dark:text-slate-400">CDMX, México • IP: 192.168.1.1</p>
                                        </div>
                                        <span className="text-xs text-slate-400">Hoy, 10:23 AM</span>
                                    </div>
                                    <div className="flex items-start gap-3">
                                        <div className="mt-0.5 text-slate-400">
                                            <span className="material-symbols-outlined text-[20px]">key</span>
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-sm font-medium text-slate-900 dark:text-white">Cambio de contraseña</p>
                                            <p className="text-xs text-slate-500 dark:text-slate-400">Navegador Web • Chrome</p>
                                        </div>
                                        <span className="text-xs text-slate-400">Ayer, 4:15 PM</span>
                                    </div>
                                </div>
                                <button
                                    onClick={() => navigate('/historial-seguridad')}
                                    className="w-full mt-6 py-2 text-sm text-primary hover:text-primary/80 font-medium transition-colors border border-dashed border-primary/30 rounded-lg hover:bg-primary/5"
                                >
                                    Ver historial completo
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Plan Card */}
                    <div className="bg-gradient-to-br from-primary/10 to-transparent dark:from-primary/20 rounded-xl p-6 border border-primary/20">
                        <div className="flex items-center gap-3 mb-3">
                            <span className="material-symbols-outlined text-primary">diamond</span>
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white">Plan Vendedor Pro</h3>
                        </div>
                        <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
                            Tienes acceso ilimitado a las herramientas de sincronización y análisis de mercado con IA.
                        </p>
                        <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 mb-2">
                            <div className="bg-primary h-2 rounded-full" style={{ width: '75%' }}></div>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 flex justify-between">
                            <span>750 / 1000 Productos importados</span>
                            <a className="text-primary hover:underline" href="#">Aumentar límite</a>
                        </p>
                    </div>
                </div>
            </div>
            <div className="h-20"></div>

            {/* Connection Modal */}
            {connectModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden transform transition-all scale-100">
                        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-900/50">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                {connectModal === 'amazon' ? (
                                    <img src="https://upload.wikimedia.org/wikipedia/commons/4/4a/Amazon_icon.svg" className="w-5 h-5" />
                                ) : (
                                    <img src="https://http2.mlstatic.com/frontend-assets/ml-web-navigation/ui-navigation/5.21.22/mercadolibre/logo__small.png" className="w-6 h-6 object-contain" />
                                )}
                                Conectar {connectModal === 'amazon' ? 'Amazon Seller' : 'Mercado Libre'}
                            </h3>
                            <button onClick={closeAndReset}><span className="material-symbols-outlined text-slate-400 hover:text-slate-600">close</span></button>
                        </div>

                        <div className="p-6">
                            {/* Step 1: Input */}
                            {connectStep === 'input' && (
                                <form onSubmit={handleConnect} className="space-y-4">
                                    {connectModal === 'amazon' ? (
                                        <>
                                            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 text-xs rounded-lg mb-4">
                                                Ingresa tus credenciales MWS de Amazon. Puedes encontrarlas en tu Seller Central bajo "Apps & Services".
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 block mb-1">Seller ID / Merchant Token</label>
                                                <input required className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm focus:ring-primary focus:border-primary" placeholder="A123BCDEF..." />
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 block mb-1">MWS Auth Token</label>
                                                <input required type="password" className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm focus:ring-primary focus:border-primary" placeholder="amzn.mws..." />
                                            </div>
                                        </>
                                    ) : (
                                        <div className="space-y-4">
                                            {errorMessage && (
                                                <div className="p-3 bg-red-50 dark:bg-red-900/10 text-red-800 dark:text-red-200 text-xs rounded-lg border border-red-100 dark:border-red-900/30 flex flex-col gap-2">
                                                    <span>{errorMessage}</span>
                                                    <button
                                                        type="button"
                                                        onClick={handleHardReset}
                                                        className="text-[10px] bg-red-100 dark:bg-red-900/40 px-2 py-1 rounded w-fit hover:bg-red-200"
                                                    >
                                                        Limpiar caché y reintentar desde cero
                                                    </button>
                                                </div>
                                            )}
                                            <div className="p-3 bg-yellow-50 dark:bg-yellow-900/10 text-yellow-800 dark:text-yellow-200 text-xs rounded-lg">
                                                Ingresa tus credenciales de Aplicación (App ID y Secret).
                                                <br /><br />
                                                <b>Nota:</b> Asegúrate de tener configurada esta Redirect URI en tu panel de desarrollador:
                                                <br />
                                                <code className="bg-white dark:bg-black/20 p-1 rounded font-mono select-all mt-1 block border border-dashed border-yellow-300">
                                                    {window.location.origin}/perfil
                                                </code>
                                                <p className="mt-2 opacity-80">
                                                    * Esta es la URL actual de tu aplicación. Copiala y pégala tal cual en Mercado Libre.
                                                </p>
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 block mb-1">País / Sitio</label>
                                                <select
                                                    value={meliSite}
                                                    onChange={e => setMeliSite(e.target.value)}
                                                    className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm focus:ring-primary focus:border-primary h-10 px-3"
                                                >
                                                    <option value="com.mx">México (MLM)</option>
                                                    <option value="com.ar">Argentina (MLA)</option>
                                                    <option value="com.br">Brasil (MLB)</option>
                                                    <option value="cl">Chile (MLC)</option>
                                                    <option value="com.co">Colombia (MCO)</option>
                                                    <option value="com.uy">Uruguay (MLU)</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 block mb-1">App ID</label>
                                                <input
                                                    value={meliAppId}
                                                    autoComplete="new-password"
                                                    name="no-autocomplete-appid"
                                                    id="meli-app-id-field"
                                                    onChange={e => setMeliAppId(e.target.value)}
                                                    className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm focus:ring-primary focus:border-primary h-10 px-3"
                                                    placeholder="Ingresa App ID numérico"
                                                />
                                            </div>
                                            <div>
                                                <label className="text-xs font-bold text-slate-500 block mb-1">Client Secret</label>
                                                <input
                                                    required
                                                    type="password"
                                                    autoComplete="new-password"
                                                    name="no-autocomplete-secret"
                                                    id="meli-secret-field"
                                                    value={meliSecret}
                                                    onChange={e => setMeliSecret(e.target.value)}
                                                    className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm focus:ring-primary focus:border-primary h-10 px-3"
                                                    placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
                                                />
                                            </div>
                                        </div>
                                    )}

                                    <div className="pt-4 flex justify-end gap-2 border-t border-slate-100 dark:border-slate-700 mt-4">
                                        <button type="button" onClick={closeAndReset} className="px-4 py-2 text-slate-600 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors">Cancelar</button>
                                        <button
                                            type="submit"
                                            className="px-6 py-2 bg-primary text-white font-bold text-sm rounded-lg hover:bg-primary-dark flex items-center gap-2 shadow-sm"
                                        >
                                            {connectModal === 'amazon' ? 'Guardar y Conectar' : 'Autorizar con Mercado Libre'}
                                        </button>
                                    </div>
                                </form>
                            )}

                            {/* Step 2: Processing */}
                            {connectStep === 'processing' && (
                                <div className="flex flex-col items-center justify-center py-10">
                                    <div className="w-16 h-16 border-4 border-slate-200 border-t-primary rounded-full animate-spin mb-4"></div>
                                    <h4 className="text-lg font-bold text-slate-900 dark:text-white">Conectando...</h4>
                                    <p className="text-sm text-slate-500">Estamos verificando tus credenciales.</p>
                                </div>
                            )}

                            {/* Step 3: Success */}
                            {connectStep === 'success' && (
                                <div className="flex flex-col items-center justify-center py-8">
                                    <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4 animate-bounce">
                                        <span className="material-symbols-outlined text-3xl text-green-600 font-bold">check</span>
                                    </div>
                                    <h4 className="text-xl font-bold text-slate-900 dark:text-white mb-1">¡Conexión Exitosa!</h4>
                                    <p className="text-sm text-slate-500 text-center max-w-xs mb-6">
                                        {connectModal === 'meli' && localStorage.getItem('melidrop_meli_credentials')
                                            ? `Conectado correctamente como ${JSON.parse(localStorage.getItem('melidrop_meli_credentials')!).nickname}`
                                            : `Tu cuenta de ${connectModal === 'amazon' ? 'Amazon' : 'Mercado Libre'} ha sido vinculada correctamente.`}
                                    </p>
                                    <button onClick={closeAndReset} className="w-full py-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-bold rounded-lg hover:opacity-90">
                                        Finalizar
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};