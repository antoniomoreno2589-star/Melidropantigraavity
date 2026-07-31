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

const UPDATER_URL = `https://gbdrxwfywxvyoxroqcut.supabase.co/functions/v1/amazon-ml-updater`;
const ANON_KEY    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdiZHJ4d2Z5d3h2eW94cm9xY3V0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkxMzU1MTQsImV4cCI6MjA4NDcxMTUxNH0.8bGbL6bKSfGShizUiijZIJqRdyO_72hecEujK3vYvr4';

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
    const [maxSellers, setMaxSellers] = useState<number | null>(null);
    const [excludeAmazon, setExcludeAmazon] = useState(false);
    const [amazonStockFilter, setAmazonStockFilter] = useState<'all' | 'in-stock' | 'out-of-stock' | 'no-data'>('all');
    const [notOnAmazon, setNotOnAmazon] = useState(false);
    const [page, setPage] = useState(1);

    // "Sin actualización" tab — products with in_updater=false
    const [notEnrolledProducts, setNotEnrolledProducts] = useState<Product[]>([]);
    const [notEnrolledLoading, setNotEnrolledLoading] = useState(false);
    const [notEnrolledLoaded, setNotEnrolledLoaded] = useState(false);
    const PAGE_SIZE = 50;
    const [syncParams, setSyncParams] = useState<{ price: boolean; stock: boolean; shipping: boolean; description: boolean }>(() => {
        const saved = localStorage.getItem('melidrop_sync_params');
        return saved ? JSON.parse(saved) : { price: true, stock: true, shipping: false, description: false };
    });
    const [updateMode, setUpdateMode] = useState<'real' | 'fixed'>(() => {
        const saved = localStorage.getItem('melidrop_update_mode');
        return saved === 'fixed' ? 'fixed' : 'real';
    });
    const [fixedDeliveryDays, setFixedDeliveryDays] = useState<{ MX: number; US: number; CN: number; EU: number }>(() => {
        const saved = localStorage.getItem('melidrop_fixed_delivery_days');
        return saved ? JSON.parse(saved) : { MX: 2, US: 8, CN: 18, EU: 23 };
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
    const [syncRunning, setSyncRunning] = useState(false);
    const [syncResult, setSyncResult] = useState<string>('');
    const [prepDays, setPrepDays] = useState<number>(3);
    const [postalCode, setPostalCode] = useState<string>('');
    const [scrapeDebug, setScrapeDebug] = useState<{ product: Product; result: any } | null>(null);
    const [scrapeDebugLoading, setScrapeDebugLoading] = useState<string | null>(null);

    useEffect(() => {
        loadProducts();
        loadSyncStatus();
        const freq = parseInt(localStorage.getItem('melidrop_sync_frequency_hours') || '24');
        setSyncFreqHours(freq);

        const scheduleAutomaticSync = () => {
            const lastSyncTime = localStorage.getItem('melidrop_last_sync_7am');
            const lastSync = lastSyncTime ? new Date(lastSyncTime) : null;

            const checkAndRunSync = async () => {
                const now = new Date();
                const currentHour = now.getHours();
                if (currentHour !== 7) return;
                const timeSinceLastSync = lastSync ? (now.getTime() - lastSync.getTime()) : Infinity;
                const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
                if (timeSinceLastSync >= threeDaysMs) {
                    localStorage.setItem('melidrop_last_sync_7am', now.toISOString());
                    setSyncRunning(true);
                    setSyncResult('Ejecutando sincronización programada...');
                    try {
                        const res = await fetch(UPDATER_URL, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ force: true }),
                        });
                        const data = await res.json();
                        if (data.success) {
                            const s = data.summary?.[0];
                            if (!s) setSyncResult('✅ Sincronización programada completada.');
                            else if (s.skipped) setSyncResult('⏳ Sincronización programada: no era necesaria aún.');
                            else if (s.updated !== undefined) setSyncResult(`✅ Sincronización programada: ${s.updated} actualizados, ${s.errors} errores.`);
                            else setSyncResult('✅ Sincronización programada completada.');
                            const { data: { user } } = await supabase.auth.getUser();
                            if (user) {
                                const { data: job } = await supabase.from('sync_jobs').select('*').eq('user_id', user.id).order('started_at', { ascending: false }).limit(1).maybeSingle();
                                if (job) setSyncJob(job);
                            }
                        } else {
                            setSyncResult(`❌ Error en sincronización programada: ${data.error ?? data.message ?? 'Error desconocido'}`);
                        }
                    } catch (e: any) {
                        setSyncResult(`❌ Error de red en sincronización programada: ${e.message}`);
                    } finally {
                        setSyncRunning(false);
                    }
                }
            };
            const intervalId = setInterval(checkAndRunSync, 60 * 60 * 1000);
            checkAndRunSync();
            return intervalId;
        };

        const scheduleAutomaticUpdater = () => {
            const lastUpdaterTime = localStorage.getItem('melidrop_last_updater_8am');
            const lastUpdater = lastUpdaterTime ? new Date(lastUpdaterTime) : null;

            const checkAndRunUpdater = async () => {
                const now = new Date();
                const currentHour = now.getHours();
                if (currentHour !== 8) return;
                const timeSinceLastUpdater = lastUpdater ? (now.getTime() - lastUpdater.getTime()) : Infinity;
                const oneDayMs = 24 * 60 * 60 * 1000;
                if (timeSinceLastUpdater >= oneDayMs) {
                    localStorage.setItem('melidrop_last_updater_8am', now.toISOString());
                    setSyncRunning(true);
                    setSyncResult('Ejecutando actualización programada de productos...');
                    try {
                        const res = await fetch(UPDATER_URL, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ force: true }),
                        });
                        const data = await res.json();
                        if (data.success) {
                            const s = data.summary?.[0];
                            if (!s) setSyncResult('✅ Actualización programada completada.');
                            else if (s.skipped) setSyncResult('⏳ Actualización programada: no era necesaria aún.');
                            else if (s.updated !== undefined) setSyncResult(`✅ Actualización programada: ${s.updated} actualizados, ${s.errors} errores.`);
                            else setSyncResult('✅ Actualización programada completada.');
                            const { data: { user } } = await supabase.auth.getUser();
                            if (user) {
                                const { data: job } = await supabase.from('sync_jobs').select('*').eq('user_id', user.id).order('started_at', { ascending: false }).limit(1).maybeSingle();
                                if (job) setSyncJob(job);
                            }
                        } else {
                            setSyncResult(`❌ Error en actualización programada: ${data.error ?? data.message ?? 'Error desconocido'}`);
                        }
                    } catch (e: any) {
                        setSyncResult(`❌ Error de red en actualización programada: ${e.message}`);
                    } finally {
                        setSyncRunning(false);
                    }
                }
            };
            const updaterIntervalId = setInterval(checkAndRunUpdater, 60 * 60 * 1000);
            checkAndRunUpdater();
            return updaterIntervalId;
        };

        const intervalId = scheduleAutomaticSync();
        const updaterIntervalId = scheduleAutomaticUpdater();
        return () => {
            clearInterval(intervalId);
            clearInterval(updaterIntervalId);
        };
    }, []);

    const loadProducts = async () => {
        setLoading(true);
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            let allProducts: any[] = [];
            let from = 0;
            const step = 100;

            while (true) {
                const { data, error } = await supabase
                    .from('products')
                    .select('id, title, sku, asin, meli_id, price_mxn, cost_usd, stock_provider, stock_meli, status, image_url, last_updated, in_updater, amazon_seller_count, sold_by_amazon, amazon_available, pause_reason, shipping_days')
                    .eq('user_id', user.id)
                    .eq('in_updater', true)
                    .neq('status', 'closed')
                    .order('last_updated', { ascending: false })
                    .range(from, from + step - 1);

                if (error) throw error;
                if (!data || data.length === 0) break;

                allProducts = [...allProducts, ...data];
                if (data.length < step) break;
                from += step;
            }

            const mappedProducts: Product[] = allProducts.map(p => ({
                id: p.id,
                title: p.title,
                sku: p.sku,
                asin: p.asin,
                meliId: p.meli_id,
                priceMXN: p.price_mxn,
                costUSD: p.cost_usd,
                stockProvider: p.stock_provider,
                stockMeli: p.stock_meli,
                status: p.status,
                imageUrl: p.image_url,
                lastUpdated: new Date(p.last_updated),
                inUpdater: p.in_updater ?? false,
                amazonSellerCount: p.amazon_seller_count ?? null,
                soldByAmazon: p.sold_by_amazon ?? null,
                amazonStock: null,
                amazonAvailable: p.amazon_available ?? null,
                pauseReason: p.pause_reason ?? null,
                shippingDays: p.shipping_days ?? null,
            }));

            setProducts(mappedProducts);
        } catch (e) {
            console.error('Error loading products:', e);
        } finally {
            setLoading(false);
        }
    };

    const loadNotEnrolledProducts = async () => {
        setNotEnrolledLoading(true);
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            let allRows: any[] = [];
            let from = 0;
            const step = 100;

            while (true) {
                const { data, error } = await supabase
                    .from('products')
                    .select('id, title, sku, asin, meli_id, price_mxn, cost_usd, stock_provider, stock_meli, status, image_url, last_updated, in_updater, amazon_seller_count, sold_by_amazon, amazon_available, pause_reason, shipping_days')
                    .eq('user_id', user.id)
                    .eq('in_updater', false)
                    .neq('status', 'closed')
                    .order('last_updated', { ascending: false })
                    .range(from, from + step - 1);

                if (error) throw error;
                if (!data || data.length === 0) break;
                allRows = [...allRows, ...data];
                if (data.length < step) break;
                from += step;
            }

            setNotEnrolledProducts(allRows.map(p => ({
                id: p.id,
                title: p.title,
                sku: p.sku,
                asin: p.asin ?? '',
                meliId: p.meli_id,
                priceMXN: p.price_mxn,
                costUSD: p.cost_usd ?? 0,
                stockProvider: p.stock_provider ?? 0,
                stockMeli: p.stock_meli ?? 0,
                status: p.status,
                imageUrl: p.image_url,
                lastUpdated: new Date(p.last_updated),
                inUpdater: false,
                amazonSellerCount: p.amazon_seller_count ?? null,
                soldByAmazon: p.sold_by_amazon ?? null,
                amazonStock: null,
                amazonAvailable: p.amazon_available ?? null,
                pauseReason: p.pause_reason ?? null,
                shippingDays: p.shipping_days ?? null,
            })));
            setNotEnrolledLoaded(true);
        } catch (e) {
            console.error('Error loading not-enrolled products:', e);
        } finally {
            setNotEnrolledLoading(false);
        }
    };

    const loadSyncStatus = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const [{ data: jobData }, { data: connData }] = await Promise.all([
            supabase.from('sync_jobs').select('*').eq('user_id', user.id).order('started_at', { ascending: false }).limit(1).maybeSingle(),
            supabase.from('user_connections').select('margin_rules').eq('user_id', user.id).maybeSingle(),
        ]);
        if (jobData) setSyncJob(jobData);
        const rules = (connData as any)?.margin_rules ?? {};
        const pd = rules.prep_days ?? rules.handling_time_mx ?? 3;
        setPrepDays(typeof pd === 'number' ? pd : parseInt(pd) || 3);
        const pc = rules.postal_code ?? '';
        setPostalCode(typeof pc === 'string' ? pc : String(pc));
    };

    const handleDebugScrape = async (product: Product) => {
        setScrapeDebugLoading(product.id);
        try {
            const res = await fetch(UPDATER_URL, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ debugHtml: product.sku, zipcode: postalCode }),
            });
            const data = await res.json();
            setScrapeDebug({ product, result: data });
        } catch (e: any) {
            setScrapeDebug({ product, result: { error: e.message } });
        } finally {
            setScrapeDebugLoading(null);
        }
    };

    const filtered = useMemo(() => {
        let list = tab === 'all' ? notEnrolledProducts : products;

        if (statusFilter !== 'all') {
            if (statusFilter === 'inactive') {
                list = list.filter(p => ['inactive', 'closed', 'paused', 'not_yet_active'].includes(p.status));
            } else {
                list = list.filter(p => p.status === statusFilter);
            }
        }

        if (maxSellers !== null) {
            list = list.filter(p =>
                p.amazonSellerCount !== null &&
                p.amazonSellerCount !== undefined &&
                p.amazonSellerCount <= maxSellers
            );
        }

        if (excludeAmazon) {
            list = list.filter(p => p.soldByAmazon === false);
        }

        if (amazonStockFilter !== 'all') {
            if (amazonStockFilter === 'in-stock') {
                list = list.filter(p => p.amazonStock !== null && p.amazonStock > 0);
            } else if (amazonStockFilter === 'out-of-stock') {
                list = list.filter(p => p.amazonStock === 0);
            } else if (amazonStockFilter === 'no-data') {
                list = list.filter(p => p.amazonStock === null || p.amazonStock === undefined);
            }
        }

        if (notOnAmazon) {
            list = list.filter(p => p.amazonAvailable === false);
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
    }, [products, notEnrolledProducts, tab, statusFilter, search, maxSellers, excludeAmazon, amazonStockFilter, notOnAmazon]);

    const paginated = useMemo(() => {
        const start = (page - 1) * PAGE_SIZE;
        return filtered.slice(start, start + PAGE_SIZE);
    }, [filtered, page]);

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

    const enrolledCount = useMemo(() => products.length, [products]);

    const handleToggle = async (product: Product) => {
        const newValue = !product.inUpdater;
        setToggling(prev => new Set([...prev, product.id]));
        try {
            await api.products.toggleUpdater(product.id, newValue);
            if (newValue) {
                setNotEnrolledProducts(prev => prev.filter(p => p.id !== product.id));
                setProducts(prev => [{ ...product, inUpdater: true }, ...prev]);
            } else {
                setProducts(prev => prev.filter(p => p.id !== product.id));
                if (notEnrolledLoaded) {
                    setNotEnrolledProducts(prev => [{ ...product, inUpdater: false }, ...prev]);
                }
            }
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

    const handleRunNow = async () => {
        setSyncRunning(true);
        setSyncResult('Ejecutando sincronización...');
        try {
            const { data: { user } } = await supabase.auth.getUser();
            const res = await fetch(UPDATER_URL, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ force: true, userId: user?.id }),
            });
            const data = await res.json();
            if (data.success) {
                const s = data.summary?.[0];
                if (!s) {
                    setSyncResult('✅ Sincronización ejecutada (sin cambios).');
                } else if (s.skipped) {
                    setSyncResult(`⏳ No es necesario aún (próxima sincronización en ${syncFreqHours}h).`);
                } else if (s.completed === true) {
                    setSyncResult('✅ Sincronización completada (todos los productos procesados).');
                } else if (s.updated !== undefined || s.errors !== undefined) {
                    const hasErrors = (s.errors ?? 0) > 0;
                    const icon = hasErrors ? '⚠️' : '✅';
                    const errorDetail = hasErrors && s.firstError ? ` — ${s.firstError}` : '';
                    setSyncResult(`${icon} Lote procesado: ${s.updated ?? 0} actualizados, ${s.errors ?? 0} errores.${errorDetail}`);
                } else {
                    setSyncResult('✅ Lote procesado sin cambios.');
                }
                if (user) {
                    const { data: job } = await supabase.from('sync_jobs').select('*').eq('user_id', user.id).order('started_at', { ascending: false }).limit(1).maybeSingle();
                    if (job) setSyncJob(job);
                }
            } else {
                setSyncResult(`❌ Error: ${data.error ?? data.message ?? 'Error desconocido'}`);
            }
        } catch (e: any) {
            setSyncResult(`❌ Error de red: ${e.message}`);
        } finally {
            setSyncRunning(false);
        }
    };

    const handleSaveSyncSettings = async () => {
        localStorage.setItem('melidrop_sync_params', JSON.stringify(syncParams));
        localStorage.setItem('melidrop_default_stock', defaultStock.toString());
        localStorage.setItem('melidrop_auto_promos', autoPromos.toString());
        localStorage.setItem('melidrop_allow_price_decrease', allowPriceDecrease.toString());
        localStorage.setItem('melidrop_sync_frequency_hours', syncFreqHours.toString());
        localStorage.setItem('melidrop_update_mode', updateMode);
        localStorage.setItem('melidrop_fixed_delivery_days', JSON.stringify(fixedDeliveryDays));
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            const { data: existing } = await supabase.from('user_connections').select('margin_rules').eq('user_id', user.id).maybeSingle();
            const currentRules = (existing as any)?.margin_rules || {};
            await supabase.from('user_connections').upsert({
                user_id: user.id,
                margin_rules: {
                    ...currentRules,
                    sync_params: syncParams,
                    default_stock: defaultStock,
                    auto_promos: autoPromos,
                    allow_price_decrease: allowPriceDecrease,
                    sync_frequency_hours: syncFreqHours,
                    update_mode: updateMode,
                    fixed_delivery_days: fixedDeliveryDays,
                }
            }, { onConflict: 'user_id' });
        }
        alert('Configuración del actualizador guardada.');
    };

    return (
        <>
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

                {/* Sync Settings Card */}
                <div className="bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                    <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
                            <span className="material-symbols-outlined">tune</span>
                        </div>
                        <div>
                            <h2 className="text-base font-bold text-slate-900 dark:text-white uppercase tracking-tighter">Parámetros de Sincronización</h2>
                            <p className="text-xs text-slate-500">Configura qué se actualiza y con qué frecuencia.</p>
                        </div>
                    </div>
                    <div className="p-6 space-y-6">
                        <div>
                            <label className="text-xs font-black text-slate-500 uppercase mb-3 block">Tipo de Actualización</label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <button
                                    type="button"
                                    onClick={() => setUpdateMode('real')}
                                    className={`text-left p-4 rounded-xl border-2 transition-all ${updateMode === 'real' ? 'border-primary bg-primary/5' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}
                                >
                                    <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                        🔎 Actualización Real
                                        {updateMode === 'real' && <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-primary text-white uppercase">Activo</span>}
                                    </p>
                                    <p className="text-xs text-slate-500 mt-1">
                                        Lee la página real de Amazon (scraper) para precio, stock y tiempo de entrega. Más preciso, más lento — hasta 5 productos por corrida.
                                    </p>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setUpdateMode('fixed')}
                                    className={`text-left p-4 rounded-xl border-2 transition-all ${updateMode === 'fixed' ? 'border-primary bg-primary/5' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}
                                >
                                    <p className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                        ⚡ Valores Fijos
                                        {updateMode === 'fixed' && <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-primary text-white uppercase">Activo</span>}
                                    </p>
                                    <p className="text-xs text-slate-500 mt-1">
                                        Solo API oficial de Amazon, sin scraper. Precio y tiempo de entrega según la oferta ganadora (buybox → país → Prime → FBA) y una tabla fija de días por país (MX 2 · US 8 · CN 18 · Europa 23).
                                    </p>
                                </button>
                            </div>
                            {updateMode === 'fixed' && (
                                <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden animate-fade-in">
                                    <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                                        <p className="text-xs font-black text-slate-500 uppercase">Días de Entrega por País de Origen</p>
                                        <p className="text-xs text-slate-400 mt-0.5">Se usan según el país de envío de la oferta ganadora. Se suman a los días de preparación configurados en Ajustes.</p>
                                    </div>
                                    <div className="grid grid-cols-[1fr_100px] gap-3 px-4 py-2 text-xs font-bold text-slate-400 uppercase border-b border-slate-100 dark:border-slate-800">
                                        <span>País de origen</span>
                                        <span>Días</span>
                                    </div>
                                    <div className="divide-y divide-slate-100 dark:divide-slate-800">
                                        {([
                                            { key: 'MX', flag: '🇲🇽', label: 'México' },
                                            { key: 'US', flag: '🇺🇸', label: 'Estados Unidos' },
                                            { key: 'CN', flag: '🇨🇳', label: 'China' },
                                            { key: 'EU', flag: '🇪🇺', label: 'Europa' },
                                        ] as const).map(c => (
                                            <div key={c.key} className="grid grid-cols-[1fr_100px] gap-3 px-4 py-2.5 items-center">
                                                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{c.flag} {c.label}</span>
                                                <input
                                                    type="number" min="0" max="90"
                                                    value={fixedDeliveryDays[c.key]}
                                                    onChange={e => setFixedDeliveryDays(prev => ({ ...prev, [c.key]: Math.max(0, parseInt(e.target.value) || 0) }))}
                                                    className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-2 py-1.5 text-sm font-black text-center"
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
                            <div className="space-y-4">
                                <div>
                                    <label className="text-xs font-black text-slate-500 uppercase mb-3 block">Frecuencia de Actualización</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {([
                                            { hours: 24,  label: 'Cada día',    badge: '✓ Recomendado', color: 'text-green-600' },
                                            { hours: 72,  label: 'Cada 3 días', badge: 'Moderado',       color: 'text-blue-600'  },
                                            { hours: 120, label: 'Cada 5 días', badge: 'Conservador',    color: 'text-slate-500' },
                                        ] as const).map(opt => (
                                            <button key={opt.hours} onClick={() => setSyncFreqHours(opt.hours)}
                                                className={`p-3 rounded-xl border-2 text-left transition-all ${syncFreqHours === opt.hours ? 'border-primary bg-primary/5' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'}`}>
                                                <p className="font-bold text-slate-900 dark:text-white text-sm">{opt.label}</p>
                                                <p className={`text-xs font-black ${opt.color}`}>{opt.badge}</p>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="text-xs font-black text-slate-500 uppercase">Stock por Defecto al Importar</label>
                                    <div className="relative w-40 mt-2">
                                        <input
                                            type="number" min="1" max="999"
                                            value={defaultStock}
                                            onChange={e => setDefaultStock(Math.max(1, parseInt(e.target.value) || 1))}
                                            className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-sm font-black"
                                        />
                                        <span className="absolute right-3 top-2 text-slate-400 text-xs">pzas</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div>
                            <label className="text-xs font-black text-slate-500 uppercase mb-3 block">Opciones de Precio</label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-700">
                                    <div>
                                        <p className="text-sm font-bold text-slate-900 dark:text-white">🎯 Crear Promociones Automáticas</p>
                                        <p className="text-xs text-slate-500">Cuando Amazon baja el precio, crea una promoción en ML.</p>
                                    </div>
                                    <div onClick={() => setAutoPromos(v => !v)}
                                        className={`w-12 h-6 rounded-full transition-all cursor-pointer relative flex-shrink-0 ml-4 ${autoPromos ? 'bg-primary' : 'bg-slate-200 dark:bg-slate-700'}`}>
                                        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${autoPromos ? 'left-6' : 'left-0.5'}`} />
                                    </div>
                                </div>
                                <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-700">
                                    <div>
                                        <p className="text-sm font-bold text-slate-900 dark:text-white">📉 Permitir Fluctuación de Precios</p>
                                        <p className="text-xs text-slate-500">Desactivado: solo sube. Activado: sigue los cambios en ambas direcciones.</p>
                                    </div>
                                    <div onClick={() => setAllowPriceDecrease(v => !v)}
                                        className={`w-12 h-6 rounded-full transition-all cursor-pointer relative flex-shrink-0 ml-4 ${allowPriceDecrease ? 'bg-primary' : 'bg-slate-200 dark:bg-slate-700'}`}>
                                        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${allowPriceDecrease ? 'left-6' : 'left-0.5'}`} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    {syncResult && (
                        <div className="px-6 pb-2">
                            <p className={`text-xs font-mono ${syncResult.startsWith('✅') ? 'text-green-600' : syncResult.startsWith('❌') ? 'text-red-500' : 'text-slate-500'}`}>
                                {syncResult}
                            </p>
                        </div>
                    )}
                    <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex gap-3">
                        <button onClick={handleSaveSyncSettings} className="flex-1 bg-slate-800 hover:bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white font-black py-3 px-4 rounded-xl shadow-sm transition-all flex items-center justify-center gap-2 text-sm uppercase">
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
                </div>

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
                        onClick={() => { setTab('all'); setPage(1); setSelected(new Set()); if (!notEnrolledLoaded) loadNotEnrolledProducts(); }}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${tab === 'all' ? 'bg-white dark:bg-slate-700 text-primary shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                    >
                        Sin actualización
                        <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-black bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">{notEnrolledProducts.length.toLocaleString()}</span>
                    </button>
                </div>

                {/* Filters */}
                <div className="flex flex-col gap-3">
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
                    <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-xs font-black text-slate-500 uppercase flex items-center gap-1">
                            <span className="material-symbols-outlined text-[16px] text-amber-500">storefront</span>
                            Vendedores Amazon:
                        </span>
                        {[
                            { label: 'Todos', value: null },
                            { label: '≤ 1', value: 1 },
                            { label: '≤ 2', value: 2 },
                            { label: '≤ 5', value: 5 },
                            { label: '≤ 10', value: 10 },
                        ].map(opt => (
                            <button
                                key={String(opt.value)}
                                onClick={() => { setMaxSellers(opt.value); setPage(1); }}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${maxSellers === opt.value
                                    ? 'bg-amber-500 text-white border-amber-500'
                                    : 'bg-surface-light dark:bg-surface-dark border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-amber-400'}`}
                            >
                                {opt.label}
                            </button>
                        ))}
                        {maxSellers !== null && (
                            <span className="text-xs text-amber-600 font-bold">
                                {filtered.length} productos con ≤{maxSellers} vendedor{maxSellers !== 1 ? 'es' : ''}
                            </span>
                        )}
                        <button
                            onClick={() => { setExcludeAmazon(v => !v); setPage(1); }}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border flex items-center gap-1.5 ${excludeAmazon
                                ? 'bg-orange-500 text-white border-orange-500'
                                : 'bg-surface-light dark:bg-surface-dark border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-orange-400'}`}
                        >
                            <span>🅰</span>
                            Sin Amazon
                        </button>
                        {excludeAmazon && (
                            <span className="text-xs text-orange-600 font-bold">
                                Amazon no vende estos {filtered.length} productos
                            </span>
                        )}
                        <button
                            onClick={() => { setNotOnAmazon(v => !v); setPage(1); }}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border flex items-center gap-1.5 ${notOnAmazon
                                ? 'bg-red-500 text-white border-red-500'
                                : 'bg-surface-light dark:bg-surface-dark border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-red-400'}`}
                        >
                            <span className="material-symbols-outlined text-[14px]">block</span>
                            No en Amazon
                        </button>
                        {notOnAmazon && (
                            <span className="text-xs text-red-600 font-bold">
                                {filtered.length} producto{filtered.length !== 1 ? 's' : ''} no disponible{filtered.length !== 1 ? 's' : ''} en Amazon
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-xs font-black text-slate-500 uppercase flex items-center gap-1">
                            <span className="material-symbols-outlined text-[16px] text-blue-500">inventory_2</span>
                            Stock Amazon:
                        </span>
                        {[
                            { label: 'Todos', value: 'all' as const },
                            { label: '📦 En Stock', value: 'in-stock' as const },
                            { label: '❌ Sin Stock', value: 'out-of-stock' as const },
                            { label: '❓ Sin Datos', value: 'no-data' as const },
                        ].map(opt => (
                            <button
                                key={opt.value}
                                onClick={() => { setAmazonStockFilter(opt.value); setPage(1); }}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${amazonStockFilter === opt.value
                                    ? 'bg-blue-500 text-white border-blue-500'
                                    : 'bg-surface-light dark:bg-surface-dark border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-400'}`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Bulk Actions */}
                {selected.size > 0 && (
                    <div className="flex items-center justify-between px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl animate-fade-in">
                        <span className="text-sm font-bold text-primary">{selected.size} producto{selected.size !== 1 ? 's' : ''} seleccionado{selected.size !== 1 ? 's' : ''}</span>
                        <div className="flex gap-2">
                            <button onClick={() => handleBulkToggle(true)} disabled={bulkLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-bold hover:bg-primary-dark transition-all disabled:opacity-50">
                                <span className="material-symbols-outlined text-[16px]">add_circle</span>
                                Agregar al actualizador
                            </button>
                            <button onClick={() => handleBulkToggle(false)} disabled={bulkLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-bold hover:bg-slate-300 dark:hover:bg-slate-600 transition-all disabled:opacity-50">
                                <span className="material-symbols-outlined text-[16px]">remove_circle</span>
                                Quitar del actualizador
                            </button>
                            <button onClick={() => setSelected(new Set())} className="px-3 py-1.5 text-slate-500 hover:text-slate-700 text-xs font-bold">Cancelar</button>
                        </div>
                    </div>
                )}

                {/* Table */}
                <div className="bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                    <div className="grid grid-cols-[auto_56px_1fr_100px_110px_96px_88px_76px] gap-3 px-4 py-3 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-500 uppercase tracking-wider">
                        <div className="flex items-center">
                            <input type="checkbox" checked={paginated.length > 0 && selected.size === paginated.length} onChange={toggleSelectAll} className="w-4 h-4 rounded border-slate-300 text-primary cursor-pointer" />
                        </div>
                        <div></div>
                        <div>Producto</div>
                        <div className="hidden sm:block text-center">Estado</div>
                        <div className="hidden md:block text-right">Precio MXN</div>
                        <div className="hidden lg:block text-center" title="Vendedores en Amazon">Vendedores</div>
                        <div className="hidden xl:block text-center" title="Días de preparación en MercadoLibre">Días Prep.</div>
                        <div className="text-center">Actualizador</div>
                    </div>

                    {(tab === 'enrolled' && loading) || (tab === 'all' && notEnrolledLoading) ? (
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
                                    ? 'Ve a "Sin actualización" para agregar publicaciones al actualizador.'
                                    : 'Todos tus productos ya están en el actualizador.'}
                            </p>
                        </div>
                    ) : (
                        <div className="divide-y divide-slate-100 dark:divide-slate-800">
                            {paginated.map(product => (
                                <div
                                    key={product.id}
                                    className={`grid grid-cols-[auto_56px_1fr_100px_110px_96px_88px_76px] gap-3 px-4 py-3 items-center hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${selected.has(product.id) ? 'bg-primary/5 dark:bg-primary/10' : ''}`}
                                >
                                    <div>
                                        <input type="checkbox" checked={selected.has(product.id)} onChange={() => toggleSelect(product.id)} className="w-4 h-4 rounded border-slate-300 text-primary cursor-pointer" />
                                    </div>
                                    <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 flex-shrink-0">
                                        {product.imageUrl ? (
                                            <img src={product.imageUrl} alt="" className="w-full h-full object-contain" />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center">
                                                <span className="material-symbols-outlined text-slate-300 text-xl">image</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-sm font-semibold text-slate-900 dark:text-white truncate leading-tight">{product.title}</p>
                                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                            {product.sku && <span className="text-xs text-slate-400 font-mono">SKU: {product.sku}</span>}
                                            {product.asin && <span className="text-xs text-slate-400 font-mono">ASIN: {product.asin}</span>}
                                            {product.meliId && <span className="text-xs text-slate-400 font-mono">ML: {product.meliId}</span>}
                                        </div>
                                    </div>
                                    <div className="hidden sm:block">
                                        {product.amazonAvailable === false ? (
                                            <span className="px-2 py-0.5 rounded-full text-xs font-bold whitespace-nowrap bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 flex items-center gap-1">
                                                <span className="material-symbols-outlined text-[12px]">block</span>
                                                No en Amazon
                                            </span>
                                        ) : product.pauseReason === 'sin_buybox' ? (
                                            <span className="px-2 py-0.5 rounded-full text-xs font-bold whitespace-nowrap bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400 flex items-center gap-1">
                                                <span className="material-symbols-outlined text-[12px]">shopping_cart_off</span>
                                                Pausado - Sin Buybox
                                            </span>
                                        ) : (
                                            <span className={`px-2 py-0.5 rounded-full text-xs font-bold whitespace-nowrap ${STATUS_COLORS[product.status] || STATUS_COLORS.inactive}`}>
                                                {STATUS_LABELS[product.status] || product.status}
                                            </span>
                                        )}
                                    </div>
                                    <div className="hidden md:block text-right">
                                        <span className="text-sm font-bold text-slate-700 dark:text-slate-200 whitespace-nowrap">
                                            ${product.priceMXN?.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                    <div className="hidden lg:flex justify-center items-center gap-1">
                                        {product.amazonSellerCount === null || product.amazonSellerCount === undefined ? (
                                            <span className="text-xs text-slate-300 dark:text-slate-600">—</span>
                                        ) : (
                                            <>
                                                <span className={`px-2 py-0.5 rounded-full text-xs font-black ${
                                                    product.amazonSellerCount <= 1 ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400' :
                                                    product.amazonSellerCount <= 3 ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' :
                                                    product.amazonSellerCount <= 10 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' :
                                                    'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400'
                                                }`}>
                                                    {product.amazonSellerCount}
                                                </span>
                                                {product.soldByAmazon === true && (
                                                    <span title="Amazon vende este producto" className="px-1.5 py-0.5 rounded text-[10px] font-black bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400">AMZ</span>
                                                )}
                                            </>
                                        )}
                                    </div>
                                    <div className="hidden xl:flex justify-center items-center gap-1">
                                        {product.shippingDays === null || product.shippingDays === undefined ? (
                                            <span className="text-xs text-slate-300 dark:text-slate-600">—</span>
                                        ) : (
                                            <span className="px-2 py-0.5 rounded-full text-xs font-black bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" title={`Amazon: ${product.shippingDays}d + prep: ${prepDays}d`}>{product.shippingDays + prepDays} días</span>
                                        )}
                                        <button
                                            onClick={() => handleDebugScrape(product)}
                                            disabled={scrapeDebugLoading === product.id}
                                            title="Ver HTML que recibió el scraper"
                                            className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors disabled:opacity-50"
                                        >
                                            {scrapeDebugLoading === product.id
                                                ? <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
                                                : <span className="material-symbols-outlined text-[14px]">search</span>
                                            }
                                        </button>
                                    </div>
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

                    {!loading && filtered.length > PAGE_SIZE && (
                        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30">
                            <span className="text-xs text-slate-500">
                                Mostrando {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} de {filtered.length.toLocaleString()} productos
                            </span>
                            <div className="flex items-center gap-1">
                                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors">
                                    <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                                </button>
                                <span className="text-xs font-bold text-slate-600 dark:text-slate-300 px-2">{page} / {totalPages}</span>
                                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors">
                                    <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                                </button>
                            </div>
                        </div>
                    )}
                </div>

            </div>
        </div>

        {/* Modal debug scraper */}
        {scrapeDebug && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setScrapeDebug(null)}>
                <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
                    {/* Header */}
                    <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
                        <div>
                            <h2 className="text-base font-bold text-slate-900 dark:text-white">Debug scraper Amazon</h2>
                            <p className="text-xs text-slate-500 mt-0.5">SKU: <span className="font-mono">{scrapeDebug.product.sku}</span> · CP: <span className="font-mono">{postalCode || '(no configurado)'}</span></p>
                        </div>
                        <div className="flex items-center gap-2">
                            {scrapeDebug.result.rawHtml && (
                                <button
                                    onClick={() => {
                                        const blob = new Blob([scrapeDebug.result.rawHtml], { type: 'text/html' });
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = `amazon-${scrapeDebug.product.sku}.html`;
                                        a.click();
                                        URL.revokeObjectURL(url);
                                    }}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors"
                                >
                                    <span className="material-symbols-outlined text-[15px]">download</span>
                                    Descargar HTML
                                </button>
                            )}
                            <button onClick={() => setScrapeDebug(null)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                                <span className="material-symbols-outlined text-slate-500">close</span>
                            </button>
                        </div>
                    </div>

                    <div className="overflow-y-auto flex-1 p-5 space-y-4">
                        {scrapeDebug.result.error ? (
                            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-sm font-mono">{scrapeDebug.result.error}</div>
                        ) : (
                            <>
                                {/* Resumen */}
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                    {[
                                        { label: 'Scrape.do (días)', value: scrapeDebug.result.maxDays !== null ? `${scrapeDebug.result.maxDays} días` : '—', color: scrapeDebug.result.maxDays !== null ? 'text-blue-600' : 'text-slate-400' },
                                        { label: 'Oxylabs (días)', value: scrapeDebug.result.oxylabsDays !== null && scrapeDebug.result.oxylabsDays !== undefined ? `${scrapeDebug.result.oxylabsDays} días` : (scrapeDebug.result.oxylabsError ? '✕' : '—'), color: scrapeDebug.result.oxylabsDays !== null && scrapeDebug.result.oxylabsDays !== undefined ? 'text-emerald-600' : 'text-slate-400' },
                                        { label: 'Rainforest (días)', value: scrapeDebug.result.rainforestDays !== null && scrapeDebug.result.rainforestDays !== undefined ? `${scrapeDebug.result.rainforestDays} días` : (scrapeDebug.result.rainforestError === 'RAINFOREST_API_KEY not set' ? 'Sin clave' : scrapeDebug.result.rainforestError ? '✕' : '—'), color: scrapeDebug.result.rainforestDays !== null && scrapeDebug.result.rainforestDays !== undefined ? 'text-violet-600' : 'text-slate-400' },
                                        { label: 'AOD (días)', value: scrapeDebug.result.aodDays !== null && scrapeDebug.result.aodDays !== undefined ? `${scrapeDebug.result.aodDays} días` : (scrapeDebug.result.aodError ? '✕' : '—'), color: scrapeDebug.result.aodDays !== null && scrapeDebug.result.aodDays !== undefined ? 'text-teal-600' : 'text-slate-400' },
                                        { label: 'Producto de USA', value: scrapeDebug.result.isCrossBorder ? 'Sí (importado)' : 'No', color: scrapeDebug.result.isCrossBorder ? 'text-amber-600' : 'text-slate-600' },
                                        { label: 'Buy Box', value: scrapeDebug.result.hasBuyBox === true ? 'Sí' : scrapeDebug.result.hasBuyBox === false ? 'No' : '?', color: scrapeDebug.result.hasBuyBox ? 'text-green-600' : 'text-red-500' },
                                        { label: 'Sección entrega', value: scrapeDebug.result.deliverySectionFound ? 'Encontrada' : 'No encontrada', color: scrapeDebug.result.deliverySectionFound ? 'text-green-600' : 'text-amber-500' },
                                        { label: 'Tamaño HTML', value: scrapeDebug.result.htmlLen ? `${(scrapeDebug.result.htmlLen / 1024).toFixed(0)} KB` : '—', color: 'text-slate-600' },
                                    ].map(item => (
                                        <div key={item.label} className="bg-slate-50 dark:bg-slate-800 rounded-xl p-3">
                                            <p className="text-xs text-slate-400 mb-1">{item.label}</p>
                                            <p className={`text-sm font-bold ${item.color}`}>{item.value}</p>
                                        </div>
                                    ))}
                                </div>

                                {/* Veredicto cross-border */}
                                {scrapeDebug.result.isCrossBorder && (
                                    <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 text-xs leading-relaxed">
                                        <span className="font-semibold">Producto importado (Amazon Estados Unidos).</span>{' '}
                                        {scrapeDebug.result.rainforestDays !== null && scrapeDebug.result.rainforestDays !== undefined
                                            ? `Rainforest obtuvo la fecha: ${scrapeDebug.result.rainforestDays} días. ✓`
                                            : scrapeDebug.result.oxylabsDays !== null && scrapeDebug.result.oxylabsDays !== undefined
                                                ? `Oxylabs (parse:true) obtuvo la fecha: ${scrapeDebug.result.oxylabsDays} días. ✓`
                                                : scrapeDebug.result.aodDays !== null && scrapeDebug.result.aodDays !== undefined
                                                    ? `AOD (All Offers Display) obtuvo la fecha: ${scrapeDebug.result.aodDays} días. ✓`
                                                    : `Ningún scraper obtiene la fecha (gated por Prime). Rainforest${scrapeDebug.result.rainforestError ? ` (${scrapeDebug.result.rainforestError})` : ''}, Oxylabs${scrapeDebug.result.oxylabsError ? ` (${scrapeDebug.result.oxylabsError})` : ''}, AOD${scrapeDebug.result.aodError ? ` (${scrapeDebug.result.aodError})` : ''} — todos fallaron.`}
                                    </div>
                                )}

                                {/* Fechas encontradas */}
                                {scrapeDebug.result.datesFound?.length > 0 && (
                                    <div>
                                        <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Fechas encontradas (días desde hoy)</p>
                                        <div className="flex flex-wrap gap-2">
                                            {scrapeDebug.result.datesFound.map((d: number, i: number) => (
                                                <span key={i} className="px-2 py-1 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs font-mono font-bold">{d} días</span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Snippets de entrega */}
                                {scrapeDebug.result.allDeliverySnippets?.length > 0 && (
                                    <div>
                                        <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Texto de entrega que encontró Amazon ({scrapeDebug.result.allDeliverySnippets.length} coincidencias)</p>
                                        <div className="space-y-1.5">
                                            {scrapeDebug.result.allDeliverySnippets.map((s: string, i: number) => (
                                                <div key={i} className="px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 text-xs font-mono break-all">{s}</div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Sección de entrega (HTML) */}
                                {scrapeDebug.result.deliverySection && (
                                    <div>
                                        <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Sección de entrega (HTML raw · primeros 2000 chars)</p>
                                        <pre className="text-[11px] font-mono bg-slate-900 text-green-400 p-4 rounded-xl overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">{scrapeDebug.result.deliverySection}</pre>
                                    </div>
                                )}

                                {/* Rainforest raw response */}
                                {scrapeDebug.result.rainforestRaw !== undefined && scrapeDebug.result.rainforestRaw !== null && (
                                    <div>
                                        <p className="text-xs font-semibold text-violet-600 uppercase mb-2">Rainforest — respuesta raw (delivery + buybox)</p>
                                        <pre className="text-[11px] font-mono bg-slate-900 text-violet-300 p-4 rounded-xl overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">{JSON.stringify(scrapeDebug.result.rainforestRaw, null, 2)}</pre>
                                    </div>
                                )}

                                {/* Inicio del HTML */}
                                {scrapeDebug.result.rawHtml && (
                                    <div>
                                        <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Preview HTML (primeros 3000 chars · descarga el archivo para verlo completo)</p>
                                        <pre className="text-[11px] font-mono bg-slate-900 text-slate-300 p-4 rounded-xl overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">{scrapeDebug.result.rawHtml.slice(0, 3000)}</pre>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>
        )}
        </>
    );
};
