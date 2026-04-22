import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../services/supabase';
import { api } from '../services/api';
import { Product } from '../types';

type Tab = 'enrolled' | 'all';
type StatusFilter = 'all' | 'active' | 'paused' | 'inactive';

const STATUS_LABELS: Record<string, string> = {
    active: 'Activo',
    paused: 'Pausado',
    under_review: 'En revisión',
    not_yet_active: 'No activo',
    payment_required: 'Pago requerido',
    inactive: 'Inactivo',
    closed: 'Cerrado',
    draft: 'Borrador',
};

const STATUS_COLORS: Record<string, string> = {
    active: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
    paused: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400',
    under_review: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
    not_yet_active: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
    payment_required: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
    inactive: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500',
    closed: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500',
    draft: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400',
};

export const UpdaterPage: React.FC = () => {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState<Tab>('enrolled');
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [toggling, setToggling] = useState<Set<string>>(new Set());
    const [bulkLoading, setBulkLoading] = useState(false);
    const [syncJob, setSyncJob] = useState<any>(null);
    const [syncFreqHours, setSyncFreqHours] = useState(24);
    const [page, setPage] = useState(1);
    const PAGE_SIZE = 50;

    useEffect(() => {
        loadProducts();
        loadSyncStatus();
        const freq = parseInt(localStorage.getItem('melidrop_sync_frequency_hours') || '24');
        setSyncFreqHours(freq);
    }, []);

    const loadProducts = async () => {
        setLoading(true);
        try {
            const data = await api.products.list();
            setProducts(data);
        } catch (e) {
            console.error('Error loading products:', e);
        } finally {
            setLoading(false);
        }
    };

    const loadSyncStatus = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { data } = await supabase
            .from('sync_jobs')
            .select('*')
            .eq('user_id', user.id)
            .order('started_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (data) setSyncJob(data);
    };

    const filtered = useMemo(() => {
        let list = products;

        if (tab === 'enrolled') {
            list = list.filter(p => p.inUpdater);
        }

        if (statusFilter !== 'all') {
            if (statusFilter === 'inactive') {
                list = list.filter(p => ['inactive', 'closed', 'paused', 'not_yet_active'].includes(p.status));
            } else {
                list = list.filter(p => p.status === statusFilter);
            }
        }

        if (search.trim()) {
            const q = search.toLowerCase();
            list = list.filter(p =>
                p.title.toLowerCase().includes(q) ||
                p.sku?.toLowerCase().includes(q) ||
                p.asin?.toLowerCase().includes(q) ||
                p.meliId?.toLowerCase().includes(q)
            );
        }

        return list;
    }, [products, tab, statusFilter, search]);

    const paginated = useMemo(() => {
        const start = (page - 1) * PAGE_SIZE;
        return filtered.slice(start, start + PAGE_SIZE);
    }, [filtered, page]);

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

    const enrolledCount = useMemo(() => products.filter(p => p.inUpdater).length, [products]);

    const handleToggle = async (product: Product) => {
        const newValue = !product.inUpdater;
        setToggling(prev => new Set([...prev, product.id]));
        try {
            await api.products.toggleUpdater(product.id, newValue);
            setProducts(prev => prev.map(p => p.id === product.id ? { ...p, inUpdater: newValue } : p));
        } catch (e) {
            console.error('Error toggling updater:', e);
        } finally {
            setToggling(prev => { const next = new Set(prev); next.delete(product.id); return next; });
        }
    };

    const handleBulkToggle = async (addToUpdater: boolean) => {
        if (selected.size === 0) return;
        setBulkLoading(true);
        const ids = [...selected];
        try {
            await api.products.bulkToggleUpdater(ids, addToUpdater);
            setProducts(prev => prev.map(p => ids.includes(p.id) ? { ...p, inUpdater: addToUpdater } : p));
            setSelected(new Set());
        } catch (e) {
            console.error('Error bulk toggling updater:', e);
        } finally {
            setBulkLoading(false);
        }
    };

    const toggleSelectAll = () => {
        if (selected.size === paginated.length) {
            setSelected(new Set());
        } else {
            setSelected(new Set(paginated.map(p => p.id)));
        }
    };

    const toggleSelect = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const formatDate = (d: any) => {
        if (!d) return '-';
        const date = new Date(d);
        return date.toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    };

    const syncProgress = syncJob
        ? Math.round(((syncJob.processed_count || 0) / Math.max(syncJob.total_products || 1, 1)) * 100)
        : 0;

    return (
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
            <div className="w-full max-w-7xl mx-auto flex flex-col gap-6">

                {/* Header */}
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <div>
                        <h1 className="text-3xl md:text-4xl font-black text-text-main-light dark:text-white tracking-tight uppercase">
                            Actualización
                        </h1>
                        <p className="text-text-secondary-light dark:text-text-secondary-dark text-base mt-1">
                            Gestiona qué productos se sincronizan automáticamente cada {syncFreqHours}h.
                        </p>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary rounded-xl font-bold text-sm">
                            <span className="material-symbols-outlined text-[18px]">autorenew</span>
                            <span>{enrolledCount.toLocaleString()} en actualización</span>
                        </div>
                        <div className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl font-bold text-sm">
                            <span className="material-symbols-outlined text-[18px]">inventory_2</span>
                            <span>{products.length.toLocaleString()} total</span>
                        </div>
                    </div>
                </div>

                {/* Sync Status Card */}
                {syncJob && (
                    <div className="bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-5">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className={`p-2 rounded-lg ${syncJob.status === 'running' ? 'bg-blue-100 text-blue-600' : syncJob.status === 'completed' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                                    <span className={`material-symbols-outlined ${syncJob.status === 'running' ? 'animate-spin' : ''}`}>
                                        {syncJob.status === 'running' ? 'sync' : syncJob.status === 'completed' ? 'check_circle' : 'error'}
                                    </span>
                                </div>
                                <div>
                                    <p className="font-bold text-slate-900 dark:text-white text-sm">
                                        {syncJob.status === 'running' ? 'Sincronización en progreso' : syncJob.status === 'completed' ? 'Última sincronización completada' : 'Última sincronización con errores'}
                                    </p>
                                    <p className="text-xs text-slate-500 mt-0.5">
                                        {syncJob.status === 'running'
                                            ? `${syncJob.processed_count || 0} / ${syncJob.total_products || '?'} productos`
                                            : `${syncJob.updated_count || 0} actualizados · ${syncJob.error_count || 0} errores · ${formatDate(syncJob.finished_at)}`}
                                    </p>
                                </div>
                            </div>
                            {syncJob.status === 'running' && (
                                <div className="w-full sm:w-56">
                                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                                        <span>{syncProgress}%</span>
                                        <span>{syncJob.processed_count || 0} / {syncJob.total_products}</span>
                                    </div>
                                    <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                                        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${syncProgress}%` }} />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Tabs */}
                <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl w-fit">
                    <button
                        onClick={() => { setTab('enrolled'); setPage(1); setSelected(new Set()); }}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${tab === 'enrolled' ? 'bg-white dark:bg-slate-700 text-primary shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                    >
                        En actualización
                        <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-black bg-primary/10 text-primary">{enrolledCount.toLocaleString()}</span>
                    </button>
                    <button
                        onClick={() => { setTab('all'); setPage(1); setSelected(new Set()); }}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${tab === 'all' ? 'bg-white dark:bg-slate-700 text-primary shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                    >
                        Todos los productos
                        <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-black bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">{products.length.toLocaleString()}</span>
                    </button>
                </div>

                {/* Filters */}
                <div className="flex flex-col sm:flex-row gap-3">
                    <div className="relative flex-1">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-400 text-[20px]">search</span>
                        <input
                            type="text"
                            value={search}
                            onChange={e => { setSearch(e.target.value); setPage(1); }}
                            placeholder="Buscar por título, SKU, ASIN o ID de MercadoLibre..."
                            className="w-full pl-10 pr-4 py-2.5 bg-surface-light dark:bg-surface-dark border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                        {search && (
                            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                <span className="material-symbols-outlined text-[18px]">close</span>
                            </button>
                        )}
                    </div>
                    <div className="flex gap-2 flex-wrap">
                        {(['all', 'active', 'paused', 'inactive'] as StatusFilter[]).map(s => (
                            <button
                                key={s}
                                onClick={() => { setStatusFilter(s); setPage(1); }}
                                className={`px-3 py-2 rounded-lg text-xs font-bold transition-all border ${statusFilter === s
                                    ? 'bg-primary text-white border-primary'
                                    : 'bg-surface-light dark:bg-surface-dark border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-primary/50'}`}
                            >
                                {s === 'all' ? 'Todos' : s === 'active' ? 'Activos' : s === 'paused' ? 'Pausados' : 'Inactivos'}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Bulk Actions */}
                {selected.size > 0 && (
                    <div className="flex items-center justify-between px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl animate-fade-in">
                        <span className="text-sm font-bold text-primary">{selected.size} producto{selected.size !== 1 ? 's' : ''} seleccionado{selected.size !== 1 ? 's' : ''}</span>
                        <div className="flex gap-2">
                            <button
                                onClick={() => handleBulkToggle(true)}
                                disabled={bulkLoading}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-bold hover:bg-primary-dark transition-all disabled:opacity-50"
                            >
                                <span className="material-symbols-outlined text-[16px]">add_circle</span>
                                Agregar al actualizador
                            </button>
                            <button
                                onClick={() => handleBulkToggle(false)}
                                disabled={bulkLoading}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-bold hover:bg-slate-300 dark:hover:bg-slate-600 transition-all disabled:opacity-50"
                            >
                                <span className="material-symbols-outlined text-[16px]">remove_circle</span>
                                Quitar del actualizador
                            </button>
                            <button
                                onClick={() => setSelected(new Set())}
                                className="px-3 py-1.5 text-slate-500 hover:text-slate-700 text-xs font-bold"
                            >
                                Cancelar
                            </button>
                        </div>
                    </div>
                )}

                {/* Table */}
                <div className="bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                    {/* Table Header */}
                    <div className="grid grid-cols-[auto_56px_1fr_auto_auto_auto] gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-500 uppercase tracking-wider">
                        <div className="flex items-center">
                            <input
                                type="checkbox"
                                checked={paginated.length > 0 && selected.size === paginated.length}
                                onChange={toggleSelectAll}
                                className="w-4 h-4 rounded border-slate-300 text-primary cursor-pointer"
                            />
                        </div>
                        <div></div>
                        <div>Producto</div>
                        <div className="hidden sm:block text-center">Estado</div>
                        <div className="hidden md:block text-right">Precio MXN</div>
                        <div className="text-center">Actualizador</div>
                    </div>

                    {/* Loading */}
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-20 gap-3">
                            <span className="material-symbols-outlined text-4xl text-slate-300 animate-spin">sync</span>
                            <p className="text-slate-400 text-sm">Cargando productos...</p>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 gap-3">
                            <span className="material-symbols-outlined text-5xl text-slate-300">autorenew</span>
                            <p className="text-slate-500 font-bold">
                                {tab === 'enrolled' ? 'No hay productos en el actualizador' : 'No se encontraron productos'}
                            </p>
                            <p className="text-slate-400 text-sm text-center max-w-sm">
                                {tab === 'enrolled'
                                    ? 'Ve a "Todos los productos" para agregar productos al actualizador.'
                                    : 'Intenta con otro término de búsqueda.'}
                            </p>
                        </div>
                    ) : (
                        <div className="divide-y divide-slate-100 dark:divide-slate-800">
                            {paginated.map(product => (
                                <div
                                    key={product.id}
                                    className={`grid grid-cols-[auto_56px_1fr_auto_auto_auto] gap-3 px-4 py-3 items-center hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${selected.has(product.id) ? 'bg-primary/5 dark:bg-primary/10' : ''}`}
                                >
                                    {/* Checkbox */}
                                    <div>
                                        <input
                                            type="checkbox"
                                            checked={selected.has(product.id)}
                                            onChange={() => toggleSelect(product.id)}
                                            className="w-4 h-4 rounded border-slate-300 text-primary cursor-pointer"
                                        />
                                    </div>

                                    {/* Image */}
                                    <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 flex-shrink-0">
                                        {product.imageUrl ? (
                                            <img src={product.imageUrl} alt="" className="w-full h-full object-contain" />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center">
                                                <span className="material-symbols-outlined text-slate-300 text-xl">image</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Title + Meta */}
                                    <div className="min-w-0">
                                        <p className="text-sm font-semibold text-slate-900 dark:text-white truncate leading-tight">{product.title}</p>
                                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                            {product.sku && <span className="text-xs text-slate-400 font-mono">SKU: {product.sku}</span>}
                                            {product.asin && <span className="text-xs text-slate-400 font-mono">ASIN: {product.asin}</span>}
                                            {product.meliId && <span className="text-xs text-slate-400 font-mono">ML: {product.meliId}</span>}
                                        </div>
                                    </div>

                                    {/* Status */}
                                    <div className="hidden sm:block">
                                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold whitespace-nowrap ${STATUS_COLORS[product.status] || STATUS_COLORS.inactive}`}>
                                            {STATUS_LABELS[product.status] || product.status}
                                        </span>
                                    </div>

                                    {/* Price */}
                                    <div className="hidden md:block text-right">
                                        <span className="text-sm font-bold text-slate-700 dark:text-slate-200 whitespace-nowrap">
                                            ${product.priceMXN?.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                        </span>
                                    </div>

                                    {/* Toggle */}
                                    <div className="flex justify-center">
                                        <button
                                            onClick={() => handleToggle(product)}
                                            disabled={toggling.has(product.id)}
                                            title={product.inUpdater ? 'Quitar del actualizador' : 'Agregar al actualizador'}
                                            className={`relative w-10 h-6 rounded-full transition-all duration-200 focus:outline-none disabled:opacity-50 ${product.inUpdater ? 'bg-primary' : 'bg-slate-300 dark:bg-slate-600'}`}
                                        >
                                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${product.inUpdater ? 'translate-x-4' : 'translate-x-0'}`} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Pagination */}
                    {!loading && filtered.length > PAGE_SIZE && (
                        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30">
                            <span className="text-xs text-slate-500">
                                Mostrando {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} de {filtered.length.toLocaleString()} productos
                            </span>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => setPage(p => Math.max(1, p - 1))}
                                    disabled={page === 1}
                                    className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors"
                                >
                                    <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                                </button>
                                <span className="text-xs font-bold text-slate-600 dark:text-slate-300 px-2">
                                    {page} / {totalPages}
                                </span>
                                <button
                                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                    disabled={page === totalPages}
                                    className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors"
                                >
                                    <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                                </button>
                            </div>
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
};
