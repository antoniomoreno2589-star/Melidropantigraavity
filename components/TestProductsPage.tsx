import React, { useState, useMemo, useEffect } from 'react';
import { Product } from '../types';
import { api } from '../services/api';
import { meliService } from '../services/meliService';
import { supabase } from '../services/supabase';

interface TestProduct extends Product {
    isPublishedToReal: boolean;
    creationDate: string; // Format YYYY-MM-DD for easier filtering
    prepTime: string;
    category: string;
}

export const TestProductsPage = () => {
    const [activeTab, setActiveTab] = useState<'config' | 'products'>('products');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [isSyncing, setIsSyncing] = useState(false);
    const [filterStatus, setFilterStatus] = useState<'all' | 'published' | 'not_published' | 'active' | 'paused'>('all');
    const [filterDate, setFilterDate] = useState<string>('');
    const [showFilters, setShowFilters] = useState(false);

    const [testProducts, setTestProducts] = useState<TestProduct[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [testUser, setTestUser] = useState<any>(null);
    const [isCreatingUser, setIsCreatingUser] = useState(false);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const data = await api.testProducts.list();
                setTestProducts(data);
                
                // Fetch test user from Supabase
                const { data: { user: authUser } } = await supabase.auth.getUser();
                if (authUser) {
                    const { data: userData } = await supabase.from('user_connections').select('meli_test_user').eq('user_id', authUser.id).maybeSingle();
                    if (userData?.meli_test_user) setTestUser(userData.meli_test_user);
                }
            } catch (err) {
                console.error("Error fetching data:", err);
            } finally {
                setIsLoading(false);
            }
        };
        fetchData();
    }, []);

    const handleCreateTestUser = async () => {
        setIsCreatingUser(true);
        try {
            const user = await meliService.createTestUser('MLM');
            setTestUser(user);
            
            // Save to Supabase
            const { data: { user: authUser } } = await supabase.auth.getUser();
            if (authUser) {
                await supabase.from('user_connections').upsert({
                    user_id: authUser.id,
                    meli_test_user: user
                });
            }
            alert('¡Éxito! Se ha creado un nuevo usuario de prueba en MercadoLibre.');
        } catch (err: any) {
            console.error("Error creating test user:", err);
            alert("No se pudo crear el usuario: " + err.message);
        } finally {
            setIsCreatingUser(false);
        }
    };

    // Derived State: Filtered Products logic
    const filteredProducts = useMemo(() => {
        return testProducts.filter(p => {
            // 1. Search filter (Search glass functionality)
            const matchesSearch = p.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
                                 p.asin.toLowerCase().includes(searchQuery.toLowerCase()) ||
                                 p.sku.toLowerCase().includes(searchQuery.toLowerCase());
            
            // 2. Status filter
            let matchesStatus = true;
            if (filterStatus === 'published') matchesStatus = p.isPublishedToReal;
            else if (filterStatus === 'not_published') matchesStatus = !p.isPublishedToReal;
            else if (filterStatus === 'active') matchesStatus = p.status === 'active';
            else if (filterStatus === 'paused') matchesStatus = p.status === 'paused';

            // 3. Date filter
            const matchesDate = filterDate ? p.creationDate === filterDate : true;

            return matchesSearch && matchesStatus && matchesDate;
        });
    }, [testProducts, searchQuery, filterStatus, filterDate]);

    // Handlers
    const handleSync = async () => {
        setIsSyncing(true);
        try {
            const data = await api.testProducts.list();
            setTestProducts(data);
            alert('Sincronización con el Sandbox de Mercado Libre completada.');
        } catch (err) {
            console.error("Sync error:", err);
        } finally {
            setIsSyncing(false);
        }
    };

    const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.checked) {
            setSelectedIds(filteredProducts.map(p => p.id));
        } else {
            setSelectedIds([]);
        }
    };

    const handleToggleSelect = (id: string) => {
        setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    };

    const handlePublishToReal = (id: string) => {
        setTestProducts(prev => prev.map(p => p.id === id ? { ...p, isPublishedToReal: true, status: 'active' } : p));
        alert('Producto publicado exitosamente en MercadoLibre.');
    };

    const handleDelete = async (id: string, meliId?: string) => {
        if (!confirm('¿Estás seguro de que deseas eliminar este producto?')) return;
        try {
            if (meliId) await meliService.deleteItem(meliId).catch(() => {});
            await api.testProducts.delete(id);
            setTestProducts(prev => prev.filter(p => p.id !== id));
        } catch (err: any) {
            console.error("Error deleting product:", err);
            alert("No se pudo eliminar: " + err.message);
        }
    };

    const handleBulkDelete = async () => {
        if (selectedIds.length === 0) return;
        if (!confirm(`¿Eliminar ${selectedIds.length} producto(s) seleccionado(s)?`)) return;
        try {
            const toDelete = testProducts.filter(p => selectedIds.includes(p.id));
            await Promise.all(toDelete.map(async p => {
                if (p.meliId) await meliService.deleteItem(p.meliId).catch(() => {});
                await api.testProducts.delete(p.id);
            }));
            setTestProducts(prev => prev.filter(p => !selectedIds.includes(p.id)));
            setSelectedIds([]);
        } catch (err: any) {
            alert("Error al eliminar: " + err.message);
        }
    };

    const handleBulkPublish = () => {
        if (selectedIds.length === 0) return;
        setTestProducts(prev => prev.map(p => selectedIds.includes(p.id) ? { ...p, isPublishedToReal: true, status: 'active' } : p));
        setSelectedIds([]);
        alert(`${selectedIds.length} productos han sido publicados en MercadoLibre.`);
    };

    const clearSandbox = async () => {
        const confirmClear = window.confirm('¿Estás seguro de limpiar todo el entorno de pruebas? Esta acción eliminará permanentemente todos los productos del catálogo de test.');
        if (confirmClear) {
            try {
                await api.testProducts.clearAll();
                setTestProducts([]);
                setSelectedIds([]);
                alert('Entorno Sandbox limpiado exitosamente.');
            } catch (err) {
                console.error("Clear error:", err);
            }
        }
    };

    const getFilterLabel = () => {
        switch(filterStatus) {
            case 'published': return 'Publicados en MercadoLibre';
            case 'not_published': return 'No publicados en MercadoLibre';
            case 'active': return 'Productos activos';
            case 'paused': return 'Productos pausados';
            default: return 'Todos los productos';
        }
    };

    return (
        <div className="flex-1 flex flex-col h-full bg-background-light dark:bg-background-dark overflow-hidden">
            {/* Header */}
            <div className="p-6 pb-0">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                    <div>
                        <h1 className="text-2xl font-bold text-text-main-light dark:text-white tracking-tight">Entorno de Pruebas (Sandbox)</h1>
                        <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">Valida tus importaciones antes de la salida al mercado real.</p>
                    </div>
                    <div className="flex bg-white dark:bg-slate-800 p-1 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 w-fit">
                        <button 
                            onClick={() => setActiveTab('products')}
                            className={`px-4 py-2 text-sm font-bold rounded-lg transition-all flex items-center gap-2 ${activeTab === 'products' ? 'bg-primary text-white shadow-md' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                        >
                            <span className="material-symbols-outlined text-[20px]">inventory_2</span>
                            Catálogo de Test
                        </button>
                        <button 
                            onClick={() => setActiveTab('config')}
                            className={`px-4 py-2 text-sm font-bold rounded-lg transition-all flex items-center gap-2 ${activeTab === 'config' ? 'bg-primary text-white shadow-md' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                        >
                            <span className="material-symbols-outlined text-[20px]">settings</span>
                            Configuración
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 pt-2">
                {activeTab === 'config' ? (
                    <div className="max-w-4xl mx-auto space-y-6 pb-20">
                        <div className="bg-primary/5 dark:bg-primary/10 border border-primary/20 rounded-2xl p-6 flex flex-col md:flex-row items-center gap-6">
                            <div className="size-16 rounded-2xl bg-primary flex items-center justify-center text-white shadow-lg shadow-primary/30">
                                <span className="material-symbols-outlined text-[32px]">science</span>
                            </div>
                            <div className="flex-1 text-center md:text-left">
                                <h2 className="text-lg font-bold text-slate-900 dark:text-white">Estado del Entorno</h2>
                                <p className="text-sm text-slate-500 dark:text-slate-400">Tu cuenta Sandbox está sincronizada. Las publicaciones realizadas aquí no afectarán tu reputación real.</p>
                            </div>
                            <div className="flex items-center gap-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-4 py-2 rounded-full font-bold text-sm">
                                <span className="material-symbols-outlined text-[18px]">verified</span>
                                Activo
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-6">
                            <div className="bg-surface-light dark:bg-surface-dark border border-slate-200 dark:border-slate-700 rounded-2xl p-6 shadow-sm">
                                <div className="flex items-start gap-4">
                                    <div className="size-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-500">1</div>
                                    <div className="flex-1">
                                        <div className="flex justify-between items-center mb-4">
                                            <h3 className="font-bold text-slate-900 dark:text-white">Cuenta Mercado Libre (Test)</h3>
                                            <span className={`text-xs font-bold px-2 py-1 rounded ${testUser ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20' : 'text-slate-400 bg-slate-100'}`}>
                                                {testUser ? 'VINCULADO' : 'PENDIENTE'}
                                            </span>
                                        </div>
                                        <div className="flex flex-col sm:flex-row items-center gap-4 bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
                                            <div className="flex-1 text-sm text-slate-600 dark:text-slate-400 italic">
                                                {testUser ? (
                                                    <>Usuario: <span className="font-bold text-slate-800 dark:text-slate-200">{testUser.nickname}</span></>
                                                ) : (
                                                    'No hay un usuario de prueba activo.'
                                                )}
                                            </div>
                                            <button 
                                                onClick={handleCreateTestUser}
                                                disabled={isCreatingUser}
                                                className="bg-primary text-white px-4 py-2 rounded-lg text-xs font-bold shadow-sm hover:opacity-90 disabled:opacity-50"
                                            >
                                                {isCreatingUser ? 'Generando...' : testUser ? 'Regenerar Usuario' : 'Crear Usuario Test'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-surface-light dark:bg-surface-dark border border-slate-200 dark:border-slate-700 rounded-2xl p-6 shadow-sm">
                                <div className="flex items-start gap-4">
                                    <div className="size-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-500">2</div>
                                    <div className="flex-1">
                                        <h3 className="font-bold text-slate-900 dark:text-white mb-2">Credenciales Sandbox</h3>
                                        <p className="text-sm text-slate-500 mb-4">Utiliza estos datos para iniciar sesión en MercadoLibre y ver tus pruebas.</p>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                                            <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                                <p className="text-[10px] font-bold text-slate-400 uppercase">Email</p>
                                                <p className="text-xs font-mono text-slate-700 dark:text-slate-300 truncate">{testUser?.email || 'N/A'}</p>
                                            </div>
                                            <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3 relative">
                                                <p className="text-[10px] font-bold text-slate-400 uppercase">Contraseña</p>
                                                <p className="text-xs font-mono text-slate-700 dark:text-slate-300">{testUser?.password || '••••••••'}</p>
                                                {testUser?.password && (
                                                     <button 
                                                        onClick={() => {navigator.clipboard.writeText(testUser.password); alert('Copiado');}}
                                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-primary"
                                                     >
                                                         <span className="material-symbols-outlined text-[16px]">content_copy</span>
                                                     </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-surface-light dark:bg-surface-dark border border-slate-200 dark:border-slate-700 rounded-2xl p-6 shadow-sm">
                                <div className="flex items-start gap-4">
                                    <div className="size-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-500">3</div>
                                    <div className="flex-1">
                                        <h3 className="font-bold text-slate-900 dark:text-white mb-2">Acceso Rápido</h3>
                                        <p className="text-sm text-slate-500 mb-4">Abre el panel de vendedor con tu cuenta de prueba.</p>
                                        <div className="flex gap-2">
                                            <button 
                                                onClick={() => window.open('https://www.mercadolibre.com.mx/menu', '_blank')}
                                                className="bg-slate-900 text-white px-6 py-2 rounded-lg text-xs font-bold hover:opacity-90 transition-opacity flex items-center gap-2"
                                            >
                                                <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                                                IR A PANEL VENDEDOR TEST
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="max-w-7xl mx-auto flex flex-col gap-4 animate-fade-in pb-20">
                        {/* Search & Filters BAR */}
                        <div className="bg-surface-light dark:bg-surface-dark p-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col md:flex-row justify-between items-center gap-4 relative">
                            <div className="relative w-full md:w-80">
                                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">search</span>
                                <input 
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="w-full pl-10 pr-4 py-2 rounded-lg border-slate-200 dark:border-slate-600 bg-background-light dark:bg-background-dark text-sm focus:ring-primary focus:border-primary" 
                                    placeholder="Buscar título, ASIN o SKU..." 
                                />
                            </div>
                            
                            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
                                {/* Date Filter */}
                                <div className="flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded-lg">
                                    <span className="material-symbols-outlined text-[18px] text-slate-400">calendar_today</span>
                                    <input 
                                        type="date" 
                                        value={filterDate}
                                        onChange={(e) => setFilterDate(e.target.value)}
                                        className="bg-transparent border-none text-xs font-bold text-slate-600 dark:text-slate-300 focus:ring-0 p-0"
                                    />
                                    {filterDate && (
                                        <button onClick={() => setFilterDate('')} className="text-slate-400 hover:text-red-500">
                                            <span className="material-symbols-outlined text-[16px]">close</span>
                                        </button>
                                    )}
                                </div>

                                {/* Status Filter Dropdown */}
                                <div className="relative">
                                    <button 
                                        onClick={() => setShowFilters(!showFilters)}
                                        className={`flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-lg transition-all border ${showFilters || filterStatus !== 'all' ? 'bg-primary/10 border-primary text-primary' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}
                                    >
                                        <span className="material-symbols-outlined text-[20px]">filter_list</span>
                                        {getFilterLabel()}
                                    </button>
                                    
                                    {showFilters && (
                                        <div className="absolute top-full right-0 mt-2 w-64 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 z-50 overflow-hidden">
                                            <button 
                                                onClick={() => { setFilterStatus('all'); setShowFilters(false); }}
                                                className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterStatus === 'all' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                            >
                                                Todos los productos
                                            </button>
                                            <button 
                                                onClick={() => { setFilterStatus('published'); setShowFilters(false); }}
                                                className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterStatus === 'published' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                            >
                                                Publicados en MercadoLibre
                                            </button>
                                            <button 
                                                onClick={() => { setFilterStatus('not_published'); setShowFilters(false); }}
                                                className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterStatus === 'not_published' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                            >
                                                No publicados en MercadoLibre
                                            </button>
                                            <button 
                                                onClick={() => { setFilterStatus('active'); setShowFilters(false); }}
                                                className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterStatus === 'active' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                            >
                                                Productos activos
                                            </button>
                                            <button 
                                                onClick={() => { setFilterStatus('paused'); setShowFilters(false); }}
                                                className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterStatus === 'paused' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                            >
                                                Productos pausados
                                            </button>
                                        </div>
                                    )}
                                </div>

                                <button 
                                    onClick={handleSync}
                                    disabled={isSyncing}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-primary hover:bg-primary/10 rounded-lg transition-all border border-primary/20 disabled:opacity-50"
                                >
                                    <span className={`material-symbols-outlined text-[20px] ${isSyncing ? 'animate-spin' : ''}`}>sync</span>
                                    {isSyncing ? 'Sincronizando...' : 'Sincronizar Test'}
                                </button>
                            </div>
                        </div>

                        {/* Table */}
                        <div className="bg-surface-light dark:bg-surface-dark border border-slate-200 dark:border-slate-700 rounded-2xl shadow-sm overflow-hidden min-h-[400px]">
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                                        <tr>
                                            <th className="px-6 py-4 w-12">
                                                <input 
                                                    type="checkbox" 
                                                    className="rounded h-4 w-4 text-primary focus:ring-primary" 
                                                    checked={filteredProducts.length > 0 && selectedIds.length === filteredProducts.length}
                                                    onChange={handleSelectAll}
                                                />
                                            </th>
                                            <th className="px-6 py-4">Producto</th>
                                            <th className="px-6 py-4">ID Referencia</th>
                                            <th className="px-6 py-4 text-right">Precio Test</th>
                                            <th className="px-6 py-4 text-center">Estado Test</th>
                                            <th className="px-6 py-4">Fecha Sync</th>
                                            <th className="px-6 py-4 text-right">Acción</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                        {filteredProducts.length === 0 ? (
                                            <tr>
                                                <td colSpan={7} className="px-6 py-20 text-center text-slate-400">
                                                    No se encontraron productos en el catálogo de test.
                                                </td>
                                            </tr>
                                        ) : (
                                            filteredProducts.map(p => (
                                                <tr key={p.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors group ${selectedIds.includes(p.id) ? 'bg-primary/5' : ''}`}>
                                                    <td className="px-6 py-4">
                                                        <input 
                                                            type="checkbox" 
                                                            className="rounded h-4 w-4 text-primary focus:ring-primary" 
                                                            checked={selectedIds.includes(p.id)}
                                                            onChange={() => handleToggleSelect(p.id)}
                                                        />
                                                    </td>
                                                    <td className="px-6 py-4 max-w-[300px]">
                                                        <div className="flex items-center gap-3">
                                                            <div className="size-12 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
                                                                <img src={p.imageUrl} className="w-full h-full object-cover" alt={p.title} />
                                                            </div>
                                                            <div>
                                                                <p className="font-bold text-slate-900 dark:text-white line-clamp-1">{p.title}</p>
                                                                <span className="text-[10px] font-bold text-slate-400 uppercase">{p.category}</span>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <div className="flex flex-col text-xs">
                                                            <span className="text-primary font-bold">{p.asin}</span>
                                                            <span className="text-slate-500 font-mono tracking-tighter">{p.sku}</span>
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-4 text-right font-black text-slate-900 dark:text-white">
                                                        ${p.priceMXN.toLocaleString()}
                                                    </td>
                                                    <td className="px-6 py-4 text-center">
                                                        {p.status === 'active' ? (
                                                            <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Activo</span>
                                                        ) : (
                                                            <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">Pausado</span>
                                                        )}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <span className="text-[11px] font-bold text-slate-500">{p.creationDate}</span>
                                                    </td>
                                                    <td className="px-6 py-4 text-right">
                                                        {p.isPublishedToReal ? (
                                                            <div className="flex items-center justify-end gap-1 text-green-600 dark:text-green-400 font-bold text-[9px] bg-green-50 dark:bg-green-900/20 px-2 py-1 rounded w-fit ml-auto border border-green-200 dark:border-green-800/50">
                                                                <span className="material-symbols-outlined text-[14px]">verified</span>
                                                                EN MERCADOLIBRE
                                                            </div>
                                                        ) : (
                                                            <div className="flex items-center justify-end gap-2">
                                                                <button 
                                                                    onClick={() => handlePublishToReal(p.id)}
                                                                    className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-lg text-[10px] font-black shadow-sm transition-all"
                                                                >
                                                                    Publicar Real
                                                                </button>
                                                                <button 
                                                                    onClick={() => handleDelete(p.id, p.meliId)}
                                                                    className="p-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg transition-all"
                                                                    title="Eliminar producto"
                                                                >
                                                                    <span className="material-symbols-outlined text-[18px]">delete</span>
                                                                </button>
                                                            </div>
                                                        )}
                                                    </td>
                                                </tr>
                                            )
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            
                            {/* Pagination */}
                            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700 flex justify-between items-center text-xs text-slate-500 font-bold">
                                <div>Mostrando {filteredProducts.length} productos filtrados</div>
                                <div className="flex gap-2">
                                    <button className="p-1 rounded border border-slate-200 dark:border-slate-700 opacity-50"><span className="material-symbols-outlined text-[20px]">chevron_left</span></button>
                                    <button className="p-1 rounded border border-slate-200 dark:border-slate-700 opacity-50"><span className="material-symbols-outlined text-[20px]">chevron_right</span></button>
                                </div>
                            </div>
                        </div>

                        {/* Bulk Actions */}
                        <div className="flex flex-wrap items-center gap-3 mt-4 p-5 bg-white dark:bg-slate-800 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 shadow-sm">
                            <p className="text-sm font-bold text-slate-500 flex items-center gap-2 mr-2">
                                <span className="material-symbols-outlined text-primary">auto_fix_high</span>
                                Acciones masivas ({selectedIds.length} seleccionados):
                            </p>
                            <button
                                onClick={handleBulkPublish}
                                disabled={selectedIds.length === 0}
                                className={`text-xs font-bold px-4 py-2 rounded-lg transition-all ${selectedIds.length > 0 ? 'bg-primary text-white shadow-md hover:bg-primary-dark' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
                            >
                                Publicar seleccionados en MercadoLibre
                            </button>
                            <button
                                onClick={handleBulkDelete}
                                disabled={selectedIds.length === 0}
                                className={`text-xs font-bold px-4 py-2 rounded-lg transition-all border ${selectedIds.length > 0 ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800' : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'}`}
                            >
                                Eliminar seleccionados
                            </button>
                            <span className="text-slate-300 dark:text-slate-700 hidden sm:block">|</span>
                            <button
                                onClick={clearSandbox}
                                className="text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-2 rounded-lg transition-colors border border-transparent hover:border-red-200"
                            >
                                Limpiar todo el Sandbox
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};