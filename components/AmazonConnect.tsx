import React, { useState, useEffect } from 'react';
import { amazonService, AmazonCredentials } from '../services/amazonService';

const describeAmazonError = (msg?: string) =>
    msg && /expired/i.test(msg)
        ? 'Amazon rechazó la clave secreta (Client Secret): está vencida. Renuévala en Seller Central y pega aquí la nueva.'
        : `Amazon rechazó las credenciales: ${msg ?? 'error desconocido'}`;

export const AmazonConnect: React.FC = () => {
    const [creds, setCreds] = useState<AmazonCredentials>({
        sellerId: '',
        clientId: '',
        clientSecret: '',
        refreshToken: '',
        region: 'NA'
    });
    const [isConnected, setIsConnected] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [newSecret, setNewSecret] = useState('');
    const [updatingSecret, setUpdatingSecret] = useState(false);
    const [secretMsg, setSecretMsg] = useState('');

    useEffect(() => {
        const stored = amazonService.getCredentials();
        if (stored) {
            setCreds(stored);
            setIsConnected(true);
        }
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        setCreds({ ...creds, [e.target.name]: e.target.value });
    };

    const handleConnect = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const test = await amazonService.testConnection(creds);
            if (!test.ok) {
                setError(describeAmazonError(test.error));
                return;
            }
            await amazonService.saveCredentials(creds);
            setIsConnected(true);
            alert('Conexión con Amazon exitosa');
        } catch (err: any) {
            setError(err?.message ?? 'Error al conectar con Amazon.');
        } finally {
            setLoading(false);
        }
    };

    // Amazon expires the LWA client secret every 180 days. Swapping in just the
    // new one, verified against Amazon before saving, avoids disconnecting and
    // re-entering every credential (including the refresh token) each time.
    const handleUpdateSecret = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newSecret.trim()) return;
        setUpdatingSecret(true);
        setSecretMsg('');
        try {
            const updated = { ...creds, clientSecret: newSecret.trim() };
            const test = await amazonService.testConnection(updated);
            if (!test.ok) {
                setSecretMsg(`❌ ${describeAmazonError(test.error)}`);
                return;
            }
            await amazonService.saveCredentials(updated);
            setCreds(updated);
            setNewSecret('');
            setSecretMsg('✅ Clave actualizada y verificada con Amazon.');
        } catch (err: any) {
            setSecretMsg(`❌ ${err?.message ?? 'No se pudo actualizar la clave.'}`);
        } finally {
            setUpdatingSecret(false);
        }
    };

    const handleDisconnect = () => {
        amazonService.clearCredentials();
        setIsConnected(false);
        setCreds({
            sellerId: '',
            clientId: '',
            clientSecret: '',
            refreshToken: '',
            region: 'NA'
        });
    };

    if (isConnected) {
        return (
            <div className="bg-white dark:bg-slate-800 p-6 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-4 mb-4">
                    <img src="https://upload.wikimedia.org/wikipedia/commons/a/a9/Amazon_logo.svg" alt="Amazon" className="h-8 dark:invert" />
                    <div className="flex items-center gap-2 px-3 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full text-xs font-bold">
                        <span className="w-2 h-2 rounded-full bg-green-500"></span>
                        Conectado
                    </div>
                </div>
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                            <p className="text-slate-500">Seller ID</p>
                            <p className="font-mono font-bold dark:text-white">{creds.sellerId}</p>
                        </div>
                        <div>
                            <p className="text-slate-500">Región</p>
                            <p className="font-bold dark:text-white">{creds.region}</p>
                        </div>
                    </div>
                    <form onSubmit={handleUpdateSecret} className="space-y-2 pt-4 border-t border-slate-100 dark:border-slate-700">
                        <label className="block text-xs font-bold text-slate-500">Actualizar clave secreta (LWA Client Secret)</label>
                        <p className="text-xs text-slate-400">Amazon la vence cada 180 días. Renuévala en Seller Central → Desarrollar aplicaciones → "Rotate secret" y pégala aquí.</p>
                        <div className="flex gap-2">
                            <input
                                type="password"
                                value={newSecret}
                                onChange={(e) => setNewSecret(e.target.value)}
                                placeholder="Nueva clave secreta"
                                className="flex-1 px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none transition-all"
                            />
                            <button
                                type="submit"
                                disabled={updatingSecret || !newSecret.trim()}
                                className="bg-[#FF9900] hover:bg-[#ffad33] text-black font-bold px-4 py-2 rounded-lg text-sm shadow-sm transition-all disabled:opacity-50 whitespace-nowrap"
                            >
                                {updatingSecret ? 'Verificando...' : 'Probar y guardar'}
                            </button>
                        </div>
                        {secretMsg && <p className={`text-xs font-bold ${secretMsg.startsWith('✅') ? 'text-green-600' : 'text-red-500'}`}>{secretMsg}</p>}
                    </form>
                    <button
                        onClick={handleDisconnect}
                        className="text-red-500 hover:text-red-700 text-sm font-bold border border-red-200 hover:bg-red-50 px-4 py-2 rounded-lg transition-colors"
                    >
                        Desconectar
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-white dark:bg-slate-800 p-6 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700">
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 dark:text-white">
                <span className="material-symbols-outlined text-orange-500">storefront</span>
                Conectar Amazon Seller
            </h2>
            <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">
                Ingresa tus credenciales de Amazon Selling Partner API para sincronizar inventario y precios.
            </p>

            <form onSubmit={handleConnect} className="space-y-4">
                <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">Seller ID / Merchant Token</label>
                    <input
                        name="sellerId"
                        value={creds.sellerId}
                        onChange={handleChange}
                        className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none transition-all"
                        placeholder="Ej: A28..."
                        required
                    />
                </div>
                <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">Refresh Token (LWA)</label>
                    <input
                        name="refreshToken"
                        value={creds.refreshToken}
                        onChange={handleChange}
                        type="password"
                        className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none transition-all"
                        required
                    />
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1">LWA Client ID</label>
                        <input
                            name="clientId"
                            value={creds.clientId}
                            onChange={handleChange}
                            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none transition-all"
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1">LWA Client Secret</label>
                        <input
                            name="clientSecret"
                            value={creds.clientSecret}
                            onChange={handleChange}
                            type="password"
                            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-orange-500 focus:border-transparent outline-none transition-all"
                            required
                        />
                    </div>
                </div>

                {error && <p className="text-red-500 text-sm font-bold">{error}</p>}

                <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-[#FF9900] hover:bg-[#ffad33] text-black font-bold py-2.5 rounded-lg shadow-sm hover:shadow transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                    {loading ? (
                        <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin"></span>
                    ) : (
                        'Conectar Cuenta'
                    )}
                </button>
            </form>
        </div>
    );
};
