import React, { useState } from 'react';
import { amazonService } from '../services/amazonService';
import { api } from '../services/api';
import { Product } from '../types';

export const AmazonImporter: React.FC = () => {
    const [searchQuery, setSearchQuery] = useState('');
    const [asinInput, setAsinInput] = useState('');
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    // Pricing settings
    const [exchangeRate, setExchangeRate] = useState(20.5);
    const [marginPercent, setMarginPercent] = useState(30);

    const handleSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!searchQuery.trim()) return;

        setIsSearching(true);
        setError('');
        setSearchResults([]);

        try {
            const results = await amazonService.searchProducts(searchQuery);
            setSearchResults(results);
            if (results.length === 0) {
                setError('No se encontraron productos');
            }
        } catch (err: any) {
            setError(err.message || 'Error al buscar productos');
        } finally {
            setIsSearching(false);
        }
    };

    const handleGetByAsin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!asinInput.trim()) return;

        setIsLoading(true);
        setError('');
        setSelectedProduct(null);

        try {
            const product = await amazonService.getProduct(asinInput.trim());
            setSelectedProduct(product);
        } catch (err: any) {
            setError(err.message || 'Error al obtener producto');
        } finally {
            setIsLoading(false);
        }
    };

    const handleSelectFromSearch = async (asin: string) => {
        setIsLoading(true);
        setError('');
        setSelectedProduct(null);

        try {
            const product = await amazonService.getProduct(asin);
            setSelectedProduct(product);
        } catch (err: any) {
            setError(err.message || 'Error al obtener detalles del producto');
        } finally {
            setIsLoading(false);
        }
    };

    const calculatePrice = (costUSD: number) => {
        const costMXN = costUSD * exchangeRate;
        const finalPrice = costMXN * (1 + marginPercent / 100);
        return {
            costMXN: costMXN.toFixed(2),
            finalPrice: finalPrice.toFixed(2),
            margin: marginPercent
        };
    };

    const handleImport = async () => {
        if (!selectedProduct) return;

        setIsLoading(true);
        setError('');
        setSuccess('');

        try {
            const pricing = calculatePrice(selectedProduct.price);

            const newProduct: Omit<Product, 'id' | 'lastUpdated'> = {
                title: selectedProduct.title,
                sku: `AMZN-${selectedProduct.asin}`,
                asin: selectedProduct.asin,
                meliId: undefined,
                priceMXN: parseFloat(pricing.finalPrice),
                costUSD: selectedProduct.price,
                stockProvider: 0,
                stockMeli: 0,
                status: 'draft',
                imageUrl: selectedProduct.imageUrl || ''
            };

            await api.products.create(newProduct);
            setSuccess('¡Producto importado exitosamente!');
            setSelectedProduct(null);
            setSearchResults([]);
            setSearchQuery('');
            setAsinInput('');

            // Clear success message after 3 seconds
            setTimeout(() => setSuccess(''), 3000);
        } catch (err: any) {
            setError(err.message || 'Error al importar producto');
        } finally {
            setIsLoading(false);
        }
    };

    if (!amazonService.isAuthenticated()) {
        return (
            <div className="flex-1 overflow-auto p-6">
                <div className="max-w-2xl mx-auto">
                    <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl p-6 text-center">
                        <span className="material-symbols-outlined text-yellow-600 dark:text-yellow-400 text-5xl mb-4">warning</span>
                        <h3 className="text-lg font-bold text-yellow-900 dark:text-yellow-100 mb-2">
                            Amazon no está conectado
                        </h3>
                        <p className="text-sm text-yellow-700 dark:text-yellow-300 mb-4">
                            Debes conectar tu cuenta de Amazon en la configuración antes de importar productos.
                        </p>
                        <a
                            href="/configuracion"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg font-bold transition-colors"
                        >
                            <span className="material-symbols-outlined">settings</span>
                            Ir a Configuración
                        </a>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-auto p-6">
            <div className="max-w-7xl mx-auto">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
                        Importar desde Amazon
                    </h1>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                        Busca productos por palabra clave o ingresa un ASIN directamente
                    </p>
                </div>

                {/* Error/Success Messages */}
                {error && (
                    <div className="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 flex items-center gap-3">
                        <span className="material-symbols-outlined text-red-600 dark:text-red-400">error</span>
                        <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
                    </div>
                )}

                {success && (
                    <div className="mb-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 flex items-center gap-3">
                        <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
                        <p className="text-sm text-green-700 dark:text-green-300">{success}</p>
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Search Panel */}
                    <div className="lg:col-span-2 space-y-6">
                        {/* Search by Keyword */}
                        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                                <span className="material-symbols-outlined">search</span>
                                Buscar por palabra clave
                            </h3>
                            <form onSubmit={handleSearch} className="flex gap-2">
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Ej: wireless headphones, laptop stand..."
                                    className="flex-1 px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                                />
                                <button
                                    type="submit"
                                    disabled={isSearching}
                                    className="px-6 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg font-bold transition-colors disabled:opacity-50 flex items-center gap-2"
                                >
                                    {isSearching ? (
                                        <>
                                            <span className="material-symbols-outlined animate-spin">progress_activity</span>
                                            Buscando...
                                        </>
                                    ) : (
                                        <>
                                            <span className="material-symbols-outlined">search</span>
                                            Buscar
                                        </>
                                    )}
                                </button>
                            </form>

                            {/* Search Results */}
                            {searchResults.length > 0 && (
                                <div className="mt-6 space-y-3">
                                    <h4 className="text-sm font-bold text-slate-700 dark:text-slate-300">
                                        Resultados ({searchResults.length})
                                    </h4>
                                    <div className="max-h-96 overflow-y-auto space-y-2">
                                        {searchResults.map((result) => (
                                            <div
                                                key={result.asin}
                                                onClick={() => handleSelectFromSearch(result.asin)}
                                                className="flex gap-3 p-3 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer transition-colors"
                                            >
                                                {result.imageUrl ? (
                                                    <img
                                                        src={result.imageUrl}
                                                        alt={result.title}
                                                        className="w-16 h-16 object-cover rounded-lg"
                                                    />
                                                ) : (
                                                    <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 rounded-lg flex items-center justify-center">
                                                        <span className="material-symbols-outlined text-slate-400">image</span>
                                                    </div>
                                                )}
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-bold text-slate-900 dark:text-white line-clamp-2">
                                                        {result.title}
                                                    </p>
                                                    <p className="text-xs text-slate-500 mt-1">
                                                        ASIN: {result.asin}
                                                    </p>
                                                    {result.brand && (
                                                        <p className="text-xs text-slate-500">
                                                            Marca: {result.brand}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Search by ASIN */}
                        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                                <span className="material-symbols-outlined">barcode</span>
                                Buscar por ASIN
                            </h3>
                            <form onSubmit={handleGetByAsin} className="flex gap-2">
                                <input
                                    type="text"
                                    value={asinInput}
                                    onChange={(e) => setAsinInput(e.target.value.toUpperCase())}
                                    placeholder="Ej: B08N5WRWNW"
                                    className="flex-1 px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-transparent font-mono"
                                />
                                <button
                                    type="submit"
                                    disabled={isLoading}
                                    className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold transition-colors disabled:opacity-50"
                                >
                                    {isLoading ? 'Cargando...' : 'Obtener'}
                                </button>
                            </form>
                        </div>
                    </div>

                    {/* Product Preview & Import */}
                    <div className="lg:col-span-1">
                        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-6 sticky top-6">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4">
                                Vista Previa
                            </h3>

                            {selectedProduct ? (
                                <div className="space-y-4">
                                    {selectedProduct.imageUrl && (
                                        <img
                                            src={selectedProduct.imageUrl}
                                            alt={selectedProduct.title}
                                            className="w-full rounded-lg border border-slate-200 dark:border-slate-700"
                                        />
                                    )}

                                    <div>
                                        <h4 className="font-bold text-slate-900 dark:text-white text-sm mb-2">
                                            {selectedProduct.title}
                                        </h4>
                                        <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
                                            ASIN: {selectedProduct.asin}
                                        </p>
                                        {selectedProduct.brand && (
                                            <p className="text-xs text-slate-600 dark:text-slate-400">
                                                Marca: {selectedProduct.brand}
                                            </p>
                                        )}
                                    </div>

                                    {/* Pricing Calculator */}
                                    <div className="border-t border-slate-200 dark:border-slate-700 pt-4 space-y-3">
                                        <h5 className="text-sm font-bold text-slate-700 dark:text-slate-300">
                                            Calculadora de Precio
                                        </h5>

                                        <div>
                                            <label className="text-xs text-slate-600 dark:text-slate-400 block mb-1">
                                                Tipo de cambio (USD → MXN)
                                            </label>
                                            <input
                                                type="number"
                                                value={exchangeRate}
                                                onChange={(e) => setExchangeRate(parseFloat(e.target.value))}
                                                step="0.1"
                                                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm"
                                            />
                                        </div>

                                        <div>
                                            <label className="text-xs text-slate-600 dark:text-slate-400 block mb-1">
                                                Margen de ganancia (%)
                                            </label>
                                            <input
                                                type="number"
                                                value={marginPercent}
                                                onChange={(e) => setMarginPercent(parseFloat(e.target.value))}
                                                step="1"
                                                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm"
                                            />
                                        </div>

                                        <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 space-y-2">
                                            <div className="flex justify-between text-xs">
                                                <span className="text-slate-600 dark:text-slate-400">Costo USD:</span>
                                                <span className="font-bold text-slate-900 dark:text-white">
                                                    ${selectedProduct.price.toFixed(2)}
                                                </span>
                                            </div>
                                            <div className="flex justify-between text-xs">
                                                <span className="text-slate-600 dark:text-slate-400">Costo MXN:</span>
                                                <span className="font-bold text-slate-900 dark:text-white">
                                                    ${calculatePrice(selectedProduct.price).costMXN}
                                                </span>
                                            </div>
                                            <div className="flex justify-between text-sm border-t border-slate-200 dark:border-slate-700 pt-2">
                                                <span className="text-slate-700 dark:text-slate-300 font-bold">Precio Final:</span>
                                                <span className="font-bold text-green-600 dark:text-green-400 text-lg">
                                                    ${calculatePrice(selectedProduct.price).finalPrice}
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    <button
                                        onClick={handleImport}
                                        disabled={isLoading}
                                        className="w-full px-4 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-bold transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        <span className="material-symbols-outlined">download</span>
                                        Importar Producto
                                    </button>
                                </div>
                            ) : (
                                <div className="text-center py-12">
                                    <span className="material-symbols-outlined text-slate-300 dark:text-slate-600 text-6xl mb-4">
                                        inventory_2
                                    </span>
                                    <p className="text-sm text-slate-500 dark:text-slate-400">
                                        Busca o selecciona un producto para ver los detalles
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
