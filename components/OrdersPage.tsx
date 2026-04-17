import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { meliService } from '../services/meliService';
import { amazonService } from '../services/amazonService';
import { supabase } from '../services/supabase';
import { Order } from '../types';

type DatePreset = 'today' | '7d' | '15d' | '30d' | 'custom';

// ── helpers ────────────────────────────────────────────────────────────────

function addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}

function getPresetRange(preset: DatePreset, customFrom: string, customTo: string, today: string): { from: string; to: string } {
    if (preset === 'today')  return { from: today, to: today };
    if (preset === 'custom') return { from: customFrom, to: customTo };
    const days = preset === '7d' ? 7 : preset === '15d' ? 15 : 30;
    return { from: addDays(today, -days), to: today };
}

function mapMlStatus(o: any): Order['status'] {
    if (o.status === 'cancelled') return 'cancelled';
    const ss = o.shipping?.status ?? '';
    if (ss === 'delivered') return 'delivered';
    if (['shipped', 'me2', 'in_transit', 'almost_there'].includes(ss)) return 'shipped';
    if (o.status === 'paid') return 'paid';
    return 'pending';
}

// ── component ──────────────────────────────────────────────────────────────

export const OrdersPage = () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const exchangeRate = parseFloat(localStorage.getItem('melidrop_exchange_rate') ?? '18.5');

    // ── state ──────────────────────────────────────────────────────────
    const [orders, setOrders] = useState<Order[]>([]);
    const [currencyMap, setCurrencyMap] = useState<Record<string, 'USD' | 'MXN'>>({});
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [syncError, setSyncError] = useState<string | null>(null);

    const [preset, setPreset] = useState<DatePreset>('7d');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState(todayStr);

    const [search, setSearch] = useState('');
    const [mlStatusFilter, setMlStatusFilter] = useState('all');
    const [amazonFilter, setAmazonFilter] = useState('all');
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
    const [buyLoading, setBuyLoading] = useState<Set<string>>(new Set());
    const [quickFilter, setQuickFilter] = useState<'shipToday' | 'pendingAmazon' | null>(null);

    // ── date range ─────────────────────────────────────────────────────
    const range = useMemo(
        () => getPresetRange(preset, customFrom, customTo, todayStr),
        [preset, customFrom, customTo, todayStr]
    );

    // ── load currency map (once) ────────────────────────────────────────
    useEffect(() => {
        api.products.getCurrencyMap()
            .then(setCurrencyMap)
            .catch(err => console.error('getCurrencyMap error:', err));
    }, []);

    // ── load orders from Supabase ───────────────────────────────────────
    const loadOrders = useCallback(async () => {
        if (!range.from || !range.to) return;
        setLoading(true);
        try {
            setOrders(await api.orders.listWithDateRange(range.from, range.to));
        } catch (e) {
            console.error('loadOrders error:', e);
        } finally {
            setLoading(false);
        }
    }, [range]);

    useEffect(() => { loadOrders(); }, [loadOrders]);

    // ── sync from ML ───────────────────────────────────────────────────
    const handleSync = async () => {
        setSyncing(true);
        setSyncError(null);
        try {
            const dateFrom = `${range.from}T00:00:00.000-06:00`;
            const dateTo   = `${range.to}T23:59:59.999-06:00`;
            const raw = await meliService.getOrdersFiltered(dateFrom, dateTo);

            if (raw.length > 0) {
                // Log first order's payment object so we can verify ML field names
                console.log('[Melidrop] Sample order payment data:', JSON.stringify(raw[0]?.payments?.[0] ?? null, null, 2));
                console.log('[Melidrop] Sample order keys:', Object.keys(raw[0] ?? {}));

                const { data: { user } } = await supabase.auth.getUser();
                const payloads = raw.map((o: any) => {
                    const dateCreated = o.date_created?.split('T')[0] ?? todayStr;
                    const asin = o.order_items?.[0]?.item?.seller_custom_field ?? '';
                    const pmt = o.payments?.[0];
                    const totalAmt = o.total_amount ?? 0;
                    // ML may return the amount under different keys depending on version
                    const netReceived = pmt?.net_received_amount
                        ?? pmt?.amount_received
                        ?? pmt?.net_amount
                        ?? null;
                    const fee = pmt?.marketplace_fee ?? pmt?.commission_amount ?? null;
                    const shipping = pmt?.shipping_cost ?? pmt?.shipping_amount ?? null;
                    const netIncome = netReceived != null ? netReceived
                        : (fee != null || shipping != null)
                            ? totalAmt - (fee ?? 0) - (shipping ?? 0)
                            : null;
                    // amazon_status intentionally excluded so existing 'purchased' marks
                    // are never overwritten on re-sync (DB DEFAULT 'pending' covers new rows)
                    return {
                        id: o.id.toString(),
                        user_id: user?.id,
                        product_title: o.order_items?.[0]?.item?.title ?? 'Producto',
                        buyer_name: o.buyer?.nickname ?? 'Comprador',
                        total:         totalAmt,
                        net_income:    netIncome,
                        ml_commission: fee,
                        meli_item_id:  o.order_items?.[0]?.item?.id ?? null,
                        status: mapMlStatus(o),
                        date: dateCreated,
                        shipping_deadline: addDays(dateCreated, 3),
                        amazon_asin: asin,
                        amazon_marketplace: currencyMap[asin] === 'USD' ? 'US' : 'MX',
                    };
                });
                await api.orders.bulkUpsert(payloads);
            }
            await loadOrders();
        } catch (e: any) {
            const msg = [e.message, e.code && `[${e.code}]`, e.details, e.hint]
                .filter(Boolean).join(' — ');
            setSyncError(msg || 'Error al sincronizar');
        } finally {
            setSyncing(false);
        }
    };

    // ── amazon link / buy ──────────────────────────────────────────────
    const getAmazonDomain = (asin: string) =>
        currencyMap[asin] === 'USD' ? 'amazon.com' : 'amazon.com.mx';

    const handleBuyClick = async (order: Order) => {
        if (order.amazonAsin) {
            window.open(`https://www.${getAmazonDomain(order.amazonAsin)}/dp/${order.amazonAsin}`, '_blank', 'noreferrer');
        }
        if (order.amazonStatus !== 'pending') return;

        setBuyLoading(prev => new Set([...prev, order.id]));
        let autoCostMXN: number | undefined;
        try {
            if (order.amazonAsin && amazonService.isAuthenticated()) {
                const product = await amazonService.getProduct(order.amazonAsin);
                if (product.price > 0) {
                    autoCostMXN = product.currency === 'USD'
                        ? Math.round(product.price * exchangeRate * 100) / 100
                        : product.price;
                }
            }
        } catch { /* price fetch failed — user can fill manually */ }
        setBuyLoading(prev => { const s = new Set(prev); s.delete(order.id); return s; });

        const updated = {
            ...order,
            amazonStatus: 'purchased' as const,
            ...(autoCostMXN != null ? { amazonPurchasePrice: autoCostMXN } : {})
        };
        setOrders(prev => prev.map(o => o.id === order.id ? updated : o));
        try { await api.orders.update(updated); }
        catch { setOrders(prev => prev.map(o => o.id === order.id ? order : o)); }
    };

    const handleCostBlur = async (order: Order, rawValue: string) => {
        const price = parseFloat(rawValue);
        if (isNaN(price) || price < 0) return;
        const updated = { ...order, amazonPurchasePrice: price };
        setOrders(prev => prev.map(o => o.id === order.id ? updated : o));
        try { await api.orders.update(updated); }
        catch (e) { console.error('Error saving cost', e); }
    };

    // amazonPurchasePrice is always stored in MXN (auto-filled or typed by user)
    const costMXN = (order: Order) => order.amazonPurchasePrice ?? 0;

    // Shipping cost implied by ML payment breakdown
    const shippingCost = (order: Order) =>
        Math.max(0, order.total - order.netIncome - (order.mlCommission ?? 0));

    // Days until shipping deadline (negative = overdue)
    const daysUntil = (deadline: string): number => {
        if (!deadline) return 999;
        const diff = new Date(deadline + 'T12:00:00').getTime() - new Date(todayStr + 'T12:00:00').getTime();
        return Math.round(diff / 86400000);
    };

    // ── filtered list & stats ──────────────────────────────────────────
    const filteredOrders = useMemo(() => orders.filter(o => {
        if (quickFilter === 'shipToday')
            return o.shippingDeadline === todayStr && !['shipped', 'delivered', 'cancelled'].includes(o.status);
        if (quickFilter === 'pendingAmazon')
            return o.amazonStatus === 'pending' && o.status !== 'cancelled';
        if (search) {
            const q = search.toLowerCase();
            if (!o.id.toLowerCase().includes(q) &&
                !o.buyerName.toLowerCase().includes(q) &&
                !o.productTitle.toLowerCase().includes(q) &&
                !o.amazonAsin.toLowerCase().includes(q)) return false;
        }
        if (mlStatusFilter !== 'all' && o.status !== mlStatusFilter) return false;
        if (amazonFilter !== 'all' && o.amazonStatus !== amazonFilter) return false;
        return true;
    }), [orders, search, mlStatusFilter, amazonFilter, quickFilter, todayStr]);

    const stats = useMemo(() => {
        const shipToday    = filteredOrders.filter(o => o.shippingDeadline === todayStr && !['shipped','delivered','cancelled'].includes(o.status)).length;
        const pendingBuy   = filteredOrders.filter(o => o.amazonStatus === 'pending' && o.status !== 'cancelled').length;
        const totalNet     = filteredOrders.reduce((s, o) => s + o.netIncome, 0);
        const totalCost    = filteredOrders.reduce((s, o) => s + costMXN(o), 0);
        const purchased    = filteredOrders.filter(o => o.amazonStatus === 'purchased').length;
        return { shipToday, pendingBuy, totalNet, projectedProfit: totalNet - totalCost, purchased };
    }, [filteredOrders, todayStr, exchangeRate, currencyMap]);

    // ── select all ─────────────────────────────────────────────────────
    const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) =>
        setSelectedIds(e.target.checked ? filteredOrders.map(o => o.id) : []);

    // ── export csv ─────────────────────────────────────────────────────
    const handleExport = () => {
        const header = 'ID,Comprador,Producto,ASIN,Fecha,Entrega,Estado ML,Total MXN,Neto MXN,Comisión,Estado Amazon,Costo Real,Moneda,Ganancia MXN\n';
        const rows = filteredOrders.map(o => {
            const currency = currencyMap[o.amazonAsin] ?? 'USD';
            const gan      = o.amazonPurchasePrice != null ? (o.netIncome - costMXN(o)).toFixed(2) : '';
            return `${o.id},"${o.buyerName}","${o.productTitle}",${o.amazonAsin},${o.date},${o.shippingDeadline ?? ''},${o.status},${o.total},${o.netIncome},${o.mlCommission},${o.amazonStatus},${o.amazonPurchasePrice ?? ''},${currency},${gan}`;
        }).join('\n');
        const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = 'ordenes_melidrop.csv';
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    };

    // ── misc ────────────────────────────────────────────────────────────
    const fmt = (n: number) => n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const statusBadge: Record<string, { label: string; cls: string }> = {
        pending:   { label: 'Pendiente', cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
        paid:      { label: 'Pagada',    cls: 'bg-blue-100   text-blue-700   dark:bg-blue-900/30   dark:text-blue-400'   },
        shipped:   { label: 'Enviada',   cls: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' },
        delivered: { label: 'Entregada', cls: 'bg-green-100  text-green-700  dark:bg-green-900/30  dark:text-green-400'  },
        cancelled: { label: 'Cancelada', cls: 'bg-red-100    text-red-600    dark:bg-red-900/30    dark:text-red-400'    },
    };

    const datePresets: { value: DatePreset; label: string }[] = [
        { value: 'today', label: 'Hoy'          },
        { value: '7d',    label: '7 días'        },
        { value: '15d',   label: '15 días'       },
        { value: '30d',   label: '30 días'       },
        { value: 'custom', label: 'Personalizado' },
    ];

    // ── render ──────────────────────────────────────────────────────────
    return (
        <div className="flex-1 overflow-y-auto p-4 md:p-8 scroll-smooth bg-background-light dark:bg-background-dark">
            <div className="max-w-[1600px] mx-auto flex flex-col gap-6 pb-20">

                {/* ── Header ── */}
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Gestión de Órdenes</h1>
                        <p className="text-slate-500 dark:text-slate-400 mt-1 font-medium">Panel operativo de compras en Amazon y envíos Mercado Libre.</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                        <button
                            onClick={handleSync}
                            disabled={syncing}
                            className="bg-primary hover:bg-primary-dark disabled:opacity-60 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg shadow-primary/20"
                        >
                            <span className={`material-symbols-outlined text-[20px] ${syncing ? 'animate-spin' : ''}`}>sync</span>
                            {syncing ? 'Sincronizando...' : 'Sincronizar Ventas'}
                        </button>
                        {syncError && <p className="text-xs text-red-500 font-bold">{syncError}</p>}
                    </div>
                </div>

                {/* ── Date filter tabs ── */}
                <div className="flex flex-wrap items-center gap-2">
                    {datePresets.map(({ value, label }) => (
                        <button
                            key={value}
                            onClick={() => setPreset(value)}
                            className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wide transition-all ${
                                preset === value
                                    ? 'bg-primary text-white shadow-md shadow-primary/25'
                                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-primary/50'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                    {preset === 'custom' && (
                        <div className="flex items-center gap-2 ml-1">
                            <input
                                type="date"
                                value={customFrom}
                                onChange={e => setCustomFrom(e.target.value)}
                                className="px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                            />
                            <span className="text-slate-400 text-xs font-bold">—</span>
                            <input
                                type="date"
                                value={customTo}
                                onChange={e => setCustomTo(e.target.value)}
                                className="px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                            />
                        </div>
                    )}
                </div>

                {/* ── Stats cards ── */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <button
                        onClick={() => setQuickFilter(qf => qf === 'shipToday' ? null : 'shipToday')}
                        className={`text-left p-6 rounded-2xl border shadow-sm relative overflow-hidden group transition-all cursor-pointer ${
                            quickFilter === 'shipToday'
                                ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-400 ring-2 ring-orange-400'
                                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-orange-300'
                        }`}
                    >
                        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                            <span className="material-symbols-outlined text-6xl text-orange-500">local_shipping</span>
                        </div>
                        <p className="text-slate-500 dark:text-slate-400 text-xs font-black uppercase tracking-widest">Envíos para Hoy</p>
                        <div className="flex items-end gap-3 mt-2">
                            <p className="text-4xl font-black text-slate-900 dark:text-white">{stats.shipToday}</p>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${stats.shipToday > 0 ? 'bg-orange-100 text-orange-600 animate-pulse' : 'bg-slate-100 dark:bg-slate-700 text-slate-400'}`}>
                                {stats.shipToday > 0 ? 'URGENTE' : 'Al día'}
                            </span>
                        </div>
                        {quickFilter === 'shipToday' && (
                            <p className="text-[10px] text-orange-500 font-bold mt-2 flex items-center gap-1">
                                <span className="material-symbols-outlined text-[12px]">filter_alt</span>
                                Filtro activo — clic para quitar
                            </p>
                        )}
                    </button>

                    <button
                        onClick={() => setQuickFilter(qf => qf === 'pendingAmazon' ? null : 'pendingAmazon')}
                        className={`text-left p-6 rounded-2xl border shadow-sm relative overflow-hidden group transition-all cursor-pointer ${
                            quickFilter === 'pendingAmazon'
                                ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-400 ring-2 ring-blue-400'
                                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-blue-300'
                        }`}
                    >
                        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                            <span className="material-symbols-outlined text-6xl text-blue-500">shopping_cart</span>
                        </div>
                        <p className="text-slate-500 dark:text-slate-400 text-xs font-black uppercase tracking-widest">Pendientes Amazon</p>
                        <div className="flex items-end gap-3 mt-2">
                            <p className="text-4xl font-black text-slate-900 dark:text-white">{stats.pendingBuy}</p>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">Por Comprar</span>
                        </div>
                        {quickFilter === 'pendingAmazon' && (
                            <p className="text-[10px] text-blue-500 font-bold mt-2 flex items-center gap-1">
                                <span className="material-symbols-outlined text-[12px]">filter_alt</span>
                                Filtro activo — clic para quitar
                            </p>
                        )}
                    </button>

                    <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between">
                        <div>
                            <p className="text-slate-500 dark:text-slate-400 text-xs font-black uppercase tracking-widest">Ingresos Proyectados</p>
                            <p className="text-2xl font-black text-slate-900 dark:text-white mt-1">${fmt(stats.totalNet)}</p>
                            <p className={`text-xs mt-1 font-bold ${stats.projectedProfit >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                Ganancia est.:&nbsp;
                                {stats.projectedProfit >= 0 ? '+' : ''}${fmt(stats.projectedProfit)}
                                {stats.purchased > 0 && (
                                    <span className="text-slate-400 font-normal ml-1">({stats.purchased} costos registrados)</span>
                                )}
                            </p>
                        </div>
                        <div className="flex items-center gap-2 mt-4">
                            <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all ${stats.projectedProfit >= 0 ? 'bg-green-500' : 'bg-red-500'}`}
                                    style={{ width: `${stats.totalNet > 0 ? Math.min(100, (Math.abs(stats.projectedProfit) / stats.totalNet) * 100) : 0}%` }}
                                />
                            </div>
                            <span className="text-[10px] font-bold text-slate-400 shrink-0">Margen est.</span>
                        </div>
                    </div>
                </div>

                {/* ── Search / filter bar ── */}
                <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col lg:flex-row justify-between items-center gap-4">
                    <div className="relative w-full lg:w-96">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[20px]">search</span>
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400"
                            placeholder="Buscar por ID, comprador, producto o ASIN..."
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
                        <select
                            value={mlStatusFilter}
                            onChange={e => setMlStatusFilter(e.target.value)}
                            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-bold py-2 px-3 text-slate-700 dark:text-slate-200"
                        >
                            <option value="all">Estado ML: Todos</option>
                            <option value="pending">Pendiente</option>
                            <option value="paid">Pagada</option>
                            <option value="shipped">Enviada</option>
                            <option value="delivered">Entregada</option>
                            <option value="cancelled">Cancelada</option>
                        </select>
                        <select
                            value={amazonFilter}
                            onChange={e => setAmazonFilter(e.target.value)}
                            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-bold py-2 px-3 text-slate-700 dark:text-slate-200"
                        >
                            <option value="all">Amazon: Todos</option>
                            <option value="pending">No Comprados</option>
                            <option value="purchased">Comprados</option>
                        </select>
                        <button
                            onClick={handleExport}
                            className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-bold hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                        >
                            <span className="material-symbols-outlined text-[18px]">download</span>
                            Exportar CSV
                        </button>
                    </div>
                </div>

                {/* ── Table ── */}
                <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 dark:bg-slate-900 text-slate-400 uppercase text-[10px] font-black tracking-widest border-b border-slate-200 dark:border-slate-700">
                                <tr>
                                    <th className="px-4 py-4 w-10">
                                        <input
                                            type="checkbox"
                                            className="rounded"
                                            checked={filteredOrders.length > 0 && selectedIds.length === filteredOrders.length}
                                            onChange={handleSelectAll}
                                        />
                                    </th>
                                    <th className="px-4 py-4">Orden</th>
                                    <th className="px-4 py-4 min-w-[180px]">Producto</th>
                                    <th className="px-4 py-4 text-center">Entrega</th>
                                    <th className="px-4 py-4 text-right">Venta ML</th>
                                    <th className="px-4 py-4 text-right">Neto ML</th>
                                    <th className="px-4 py-4 text-center min-w-[155px]">Compra Amazon</th>
                                    <th className="px-4 py-4 text-right min-w-[130px]">Costo Real</th>
                                    <th className="px-4 py-4 text-right">Ganancia</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {loading ? (
                                    Array.from({ length: 6 }).map((_, i) => (
                                        <tr key={i}>
                                            {Array.from({ length: 9 }).map((__, j) => (
                                                <td key={j} className="px-4 py-4">
                                                    <div className="h-4 bg-slate-100 dark:bg-slate-700 rounded animate-pulse" style={{ width: `${55 + (j * 11) % 45}%` }} />
                                                </td>
                                            ))}
                                        </tr>
                                    ))
                                ) : filteredOrders.length === 0 ? (
                                    <tr>
                                        <td colSpan={9} className="px-6 py-20 text-center">
                                            <span className="material-symbols-outlined text-5xl text-slate-200 dark:text-slate-600 block mb-3">receipt_long</span>
                                            <p className="text-slate-500 dark:text-slate-400 font-bold">No hay órdenes para este período</p>
                                            <p className="text-slate-400 text-xs mt-1">Selecciona otro rango de fechas o sincroniza con Mercado Libre.</p>
                                        </td>
                                    </tr>
                                ) : filteredOrders.map(order => {
                                    const cost     = costMXN(order);
                                    const ganancia = order.amazonPurchasePrice != null ? order.netIncome - cost : null;
                                    const isUS     = currencyMap[order.amazonAsin] === 'USD';
                                    const sb       = statusBadge[order.status] ?? { label: order.status, cls: 'bg-slate-100 text-slate-500' };

                                    // Shipping deadline display
                                    const days = daysUntil(order.shippingDeadline ?? '');
                                    const isActive = !['delivered', 'cancelled', 'shipped'].includes(order.status);
                                    const deadlineBadge = !order.shippingDeadline ? null
                                        : isActive && days < 0  ? { label: 'Vencido',  cls: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' }
                                        : isActive && days === 0 ? { label: 'HOY',      cls: 'bg-orange-500 text-white animate-pulse' }
                                        : isActive && days === 1 ? { label: 'Mañana',   cls: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' }
                                        : isActive && days <= 3  ? { label: `En ${days}d`, cls: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' }
                                        : null;
                                    const fmtDate = (d: string) => {
                                        const [, m, day] = d.split('-');
                                        return `${parseInt(day)} ${['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][parseInt(m)]}`;
                                    };

                                    // ML breakdown
                                    const shipping = shippingCost(order);
                                    const showDetail = detailOrderId === order.id;

                                    return (
                                        <tr
                                            key={order.id}
                                            className={`hover:bg-slate-50 dark:hover:bg-slate-900/40 transition-colors ${selectedIds.includes(order.id) ? 'bg-primary/5' : ''}`}
                                        >
                                            <td className="px-4 py-3.5">
                                                <input
                                                    type="checkbox"
                                                    className="rounded"
                                                    checked={selectedIds.includes(order.id)}
                                                    onChange={() => setSelectedIds(prev =>
                                                        prev.includes(order.id) ? prev.filter(id => id !== order.id) : [...prev, order.id]
                                                    )}
                                                />
                                            </td>

                                            {/* Order */}
                                            <td className="px-4 py-3.5">
                                                <div className="flex flex-col gap-0.5">
                                                    <span className="font-black text-slate-900 dark:text-white text-[11px] tracking-wide">#{order.id}</span>
                                                    <span className="text-[11px] text-slate-500 dark:text-slate-400">{order.buyerName}</span>
                                                    <span className="text-[10px] text-slate-400">{order.date}</span>
                                                </div>
                                            </td>

                                            {/* Product */}
                                            <td className="px-4 py-3.5 max-w-[200px]">
                                                <p className="text-xs font-bold text-slate-700 dark:text-slate-300 line-clamp-2 leading-snug">{order.productTitle}</p>
                                                {order.amazonAsin && (
                                                    <span className="inline-block mt-1 text-xs font-mono font-bold text-primary bg-primary/10 px-2 py-0.5 rounded tracking-wider">{order.amazonAsin}</span>
                                                )}
                                                <span className={`inline-block mt-1 ml-1 text-[9px] font-black px-1.5 py-0.5 rounded ${sb.cls}`}>{sb.label}</span>
                                            </td>

                                            {/* Shipping deadline */}
                                            <td className="px-4 py-3.5 text-center">
                                                {order.shippingDeadline ? (
                                                    <div className="flex flex-col items-center gap-0.5">
                                                        {deadlineBadge && (
                                                            <span className={`text-[10px] font-black px-2 py-0.5 rounded-full whitespace-nowrap ${deadlineBadge.cls}`}>
                                                                {deadlineBadge.label}
                                                            </span>
                                                        )}
                                                        <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                                                            {fmtDate(order.shippingDeadline)}
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <span className="text-slate-300 dark:text-slate-600">—</span>
                                                )}
                                            </td>

                                            {/* Gross sale */}
                                            <td className="px-4 py-3.5 text-right">
                                                <span className="font-black text-slate-900 dark:text-white">${fmt(order.total)}</span>
                                            </td>

                                            {/* Net income + detail */}
                                            <td className="px-4 py-3.5 text-right relative">
                                                <span className="font-bold text-slate-700 dark:text-slate-300">${fmt(order.netIncome)}</span>
                                                <button
                                                    onClick={() => setDetailOrderId(showDetail ? null : order.id)}
                                                    className="block ml-auto text-[9px] text-primary hover:underline font-bold mt-0.5"
                                                >
                                                    {showDetail ? 'Ocultar' : 'Ver detalle'}
                                                </button>
                                                {showDetail && (
                                                    <div className="absolute right-2 top-full mt-1 z-20 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-xl shadow-xl p-3 text-left w-56">
                                                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Desglose ML</p>
                                                        <div className="flex justify-between text-xs py-1 border-b border-slate-100 dark:border-slate-700">
                                                            <span className="text-slate-600 dark:text-slate-300">Valor de venta</span>
                                                            <span className="font-bold text-slate-800 dark:text-white">${fmt(order.total)}</span>
                                                        </div>
                                                        {shipping > 0 && (
                                                            <div className="flex justify-between text-xs py-1 border-b border-slate-100 dark:border-slate-700">
                                                                <span className="text-slate-600 dark:text-slate-300">Costo de envío</span>
                                                                <span className="font-bold text-red-500">-${fmt(shipping)}</span>
                                                            </div>
                                                        )}
                                                        <div className="flex justify-between text-xs py-1 border-b border-slate-100 dark:border-slate-700">
                                                            <span className="text-slate-600 dark:text-slate-300">Comisión ML</span>
                                                            <span className="font-bold text-red-500">-${fmt(order.mlCommission ?? 0)}</span>
                                                        </div>
                                                        <div className="flex justify-between text-xs pt-2 mt-1">
                                                            <span className="font-black text-slate-800 dark:text-white">Te queda</span>
                                                            <span className="font-black text-green-600 dark:text-green-400">${fmt(order.netIncome)}</span>
                                                        </div>
                                                    </div>
                                                )}
                                            </td>

                                            {/* Amazon buy */}
                                            <td className="px-4 py-3.5 text-center">
                                                {order.amazonStatus === 'purchased' ? (
                                                    <span className="inline-flex items-center gap-1 text-[10px] font-black text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/30 px-2 py-1 rounded-lg">
                                                        <span className="material-symbols-outlined text-[13px]">check_circle</span>
                                                        COMPRADO
                                                    </span>
                                                ) : order.amazonAsin ? (
                                                    <button
                                                        onClick={() => handleBuyClick(order)}
                                                        disabled={buyLoading.has(order.id)}
                                                        title={`Abrir en ${getAmazonDomain(order.amazonAsin)} y marcar como comprado`}
                                                        className="inline-flex items-center gap-1 bg-slate-900 dark:bg-slate-200 text-white dark:text-slate-900 px-2.5 py-1.5 rounded-lg text-[10px] font-black hover:bg-slate-700 dark:hover:bg-white transition-colors disabled:opacity-50"
                                                    >
                                                        <span className={`material-symbols-outlined text-[12px] ${buyLoading.has(order.id) ? 'animate-spin' : ''}`}>
                                                            {buyLoading.has(order.id) ? 'progress_activity' : 'open_in_new'}
                                                        </span>
                                                        {isUS ? 'amazon.com' : 'amazon.mx'}
                                                    </button>
                                                ) : (
                                                    <span className="text-[10px] text-slate-300 dark:text-slate-600 italic">Sin ASIN</span>
                                                )}
                                            </td>

                                            {/* Real cost in MXN (inline editable) */}
                                            <td className="px-4 py-3.5 text-right">
                                                {order.amazonStatus === 'purchased' ? (
                                                    <div className="flex flex-col items-end gap-0.5">
                                                        <div className="flex items-center gap-0.5">
                                                            <span className="text-xs text-slate-400">$</span>
                                                            <input
                                                                type="number"
                                                                min="0"
                                                                step="0.01"
                                                                defaultValue={order.amazonPurchasePrice ?? ''}
                                                                key={`${order.id}-${order.amazonPurchasePrice ?? 'empty'}`}
                                                                onBlur={e => handleCostBlur(order, e.target.value)}
                                                                placeholder="0.00"
                                                                className="w-24 pr-1 py-1 text-xs text-right border border-slate-200 dark:border-slate-600 rounded-lg bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:border-primary outline-none font-bold"
                                                            />
                                                        </div>
                                                        <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wide">MXN</span>
                                                    </div>
                                                ) : (
                                                    <span className="text-xs text-slate-300 dark:text-slate-600">—</span>
                                                )}
                                            </td>

                                            {/* Profit */}
                                            <td className="px-4 py-3.5 text-right">
                                                {ganancia != null ? (
                                                    <span className={`text-sm font-black ${ganancia >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                                        {ganancia >= 0 ? '+' : ''}${fmt(ganancia)}
                                                    </span>
                                                ) : (
                                                    <span className="text-xs text-slate-300 dark:text-slate-600">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* Table footer */}
                    {!loading && filteredOrders.length > 0 && (
                        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs text-slate-400">
                            <span>{filteredOrders.length} orden{filteredOrders.length !== 1 ? 'es' : ''}</span>
                            <span>
                                {filteredOrders.filter(o => o.amazonStatus === 'purchased').length} compradas ·{' '}
                                {filteredOrders.filter(o => o.amazonStatus === 'pending' && o.status !== 'cancelled').length} pendientes
                            </span>
                        </div>
                    )}
                </div>

                {/* Bulk selection bar */}
                {selectedIds.length > 0 && (
                    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-8 z-50">
                        <span className="text-sm font-black uppercase">{selectedIds.length} seleccionada{selectedIds.length !== 1 ? 's' : ''}</span>
                        <button onClick={() => setSelectedIds([])} className="text-[11px] font-black text-red-400 hover:text-red-300">Descartar</button>
                    </div>
                )}
            </div>
        </div>
    );
};
