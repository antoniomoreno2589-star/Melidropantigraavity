import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { Order, Expense } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function subtractMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

function ymLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const names = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${names[m - 1]} ${y}`;
}

function fmt(n: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency', currency: 'MXN', maximumFractionDigits: 0,
  }).format(n);
}

function fmtShort(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

// ─── MarginRing ───────────────────────────────────────────────────────────────

const MarginRing: React.FC<{ pct: number }> = ({ pct }) => {
  const r = 32;
  const circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * circ;
  const color = pct < 10 ? '#dc2626' : pct < 25 ? '#f59e0b' : '#10b981';
  return (
    <svg width="80" height="80" viewBox="0 0 80 80" className="flex-shrink-0">
      <circle cx="40" cy="40" r={r} fill="none" stroke="#e5e7eb" strokeWidth="8" />
      <circle
        cx="40" cy="40" r={r} fill="none"
        stroke={color} strokeWidth="8"
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 40 40)"
      />
      <text x="40" y="45" textAnchor="middle" fill={color} fontSize="14" fontWeight="bold">
        {pct.toFixed(1)}%
      </text>
    </svg>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

const MONTH_NAMES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

export const AnalyticsPage: React.FC = () => {
  const today = nowYM();

  const [selectedYM, setSelectedYM] = useState(today);
  const [timeFilter, setTimeFilter] = useState<'1m' | '3m' | '6m' | '12m'>('6m');
  const [showPicker, setShowPicker] = useState(false);
  const [pickerYear, setPickerYear] = useState(new Date().getFullYear());

  const [chartOrders, setChartOrders] = useState<Order[]>([]);
  const [chartExpenses, setChartExpenses] = useState<Expense[]>([]);
  const [currencyMap, setCurrencyMap] = useState<Record<string, 'USD' | 'MXN'>>({});
  const [loading, setLoading] = useState(false);

  const [newConcept, setNewConcept] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newPeriod, setNewPeriod] = useState('Mensual');
  const [saving, setSaving] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [roiFilter, setRoiFilter] = useState<'all' | 'positive' | 'negative'>('all');
  const [rentableFilter, setRentableFilter] = useState<'all' | 'yes' | 'no'>('all');

  const exchangeRate = parseFloat(localStorage.getItem('melidrop_exchange_rate') ?? '18.5');

  // ── Load data ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const countMap = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 };
    const count = countMap[timeFilter];
    const fromYM = subtractMonths(selectedYM, count - 1);
    const { from: fromDate } = monthRange(fromYM);
    const { to: toDate } = monthRange(selectedYM);

    setLoading(true);
    Promise.all([
      api.orders.listWithDateRange(fromDate, toDate),
      api.expenses.listRange(fromYM, selectedYM),
      api.products.getCurrencyMap(),
    ])
      .then(([ord, exp, cmap]) => {
        setChartOrders(ord);
        setChartExpenses(exp);
        setCurrencyMap(cmap);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedYM, timeFilter]);

  const prevYM = subtractMonths(selectedYM, 1);

  const orders = useMemo(
    () => chartOrders.filter(o => o.date?.startsWith(selectedYM)),
    [chartOrders, selectedYM],
  );
  const prevOrders = useMemo(
    () => chartOrders.filter(o => o.date?.startsWith(prevYM)),
    [chartOrders, prevYM],
  );
  const monthExpenses = useMemo(
    () => chartExpenses.filter(e => e.year_month === selectedYM),
    [chartExpenses, selectedYM],
  );

  const orderCostMXN = useCallback((o: Order): number => {
    if (!o.amazonPurchasePrice) return 0;
    const currency = currencyMap[o.amazonAsin] ?? 'USD';
    return currency === 'USD' ? o.amazonPurchasePrice * exchangeRate : o.amazonPurchasePrice;
  }, [currencyMap, exchangeRate]);

  const kpis = useMemo(() => {
    const calc = (ords: Order[], exps: Expense[]) => {
      const ingresos = ords.reduce((s, o) => s + (o.total ?? 0), 0);
      const ganBruta = ords.reduce((s, o) => s + (o.netIncome ?? 0) - orderCostMXN(o), 0);
      const gastos = exps.reduce((s, e) => s + e.amount, 0);
      return { ingresos, ganBruta, gastos, ganNeta: ganBruta - gastos };
    };

    const curr = calc(orders, monthExpenses);
    const prev = calc(prevOrders, chartExpenses.filter(e => e.year_month === prevYM));
    const delta = (c: number, p: number) => p !== 0 ? ((c - p) / Math.abs(p)) * 100 : null;
    const margen = curr.ingresos > 0 ? (curr.ganNeta / curr.ingresos) * 100 : 0;

    return {
      ...curr,
      margen,
      ordersCount: orders.length,
      deltaIngresos: delta(curr.ingresos, prev.ingresos),
      deltaGanBruta: delta(curr.ganBruta, prev.ganBruta),
      deltaGastos: delta(curr.gastos, prev.gastos),
      deltaGanNeta: delta(curr.ganNeta, prev.ganNeta),
    };
  }, [orders, prevOrders, monthExpenses, chartExpenses, prevYM, orderCostMXN]);

  const chartData = useMemo(() => {
    const countMap = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 };
    const count = countMap[timeFilter];
    const months: string[] = [];
    for (let i = count - 1; i >= 0; i--) months.push(subtractMonths(selectedYM, i));

    const entries = months.map(ym => {
      const mOrders = chartOrders.filter(o => o.date?.startsWith(ym));
      const mExpenses = chartExpenses.filter(e => e.year_month === ym);
      const ingresos = mOrders.reduce((s, o) => s + (o.total ?? 0), 0);
      const ganBruta = mOrders.reduce((s, o) => s + (o.netIncome ?? 0) - orderCostMXN(o), 0);
      const gastos = mExpenses.reduce((s, e) => s + e.amount, 0);
      return { ym, label: ymLabel(ym), ingresos, ganNeta: ganBruta - gastos };
    });

    return entries.map((d, i) => {
      const prev = i > 0 ? entries[i - 1] : null;
      const deltaVsPrev = prev && prev.ingresos > 0
        ? ((d.ingresos - prev.ingresos) / prev.ingresos) * 100
        : null;
      return { ...d, deltaVsPrev };
    });
  }, [chartOrders, chartExpenses, selectedYM, timeFilter, orderCostMXN]);

  const chartMax = useMemo(
    () => Math.max(...chartData.map(d => Math.max(d.ingresos, d.ganNeta, 0)), 1),
    [chartData],
  );

  const productRows = useMemo(() => {
    const map = new Map<string, {
      key: string; name: string;
      ventaML: number; costoAmazon: number; netoML: number; gananciaNeta: number;
    }>();

    for (const o of orders) {
      const key = o.amazonAsin || o.productTitle;
      const costMXN = orderCostMXN(o);
      const existing = map.get(key);
      if (existing) {
        existing.ventaML += o.total ?? 0;
        existing.costoAmazon += costMXN;
        existing.netoML += o.netIncome ?? 0;
        existing.gananciaNeta += (o.netIncome ?? 0) - costMXN;
      } else {
        map.set(key, {
          key, name: o.productTitle,
          ventaML: o.total ?? 0,
          costoAmazon: costMXN,
          netoML: o.netIncome ?? 0,
          gananciaNeta: (o.netIncome ?? 0) - costMXN,
        });
      }
    }

    return Array.from(map.values())
      .map(r => ({
        ...r,
        roi: r.costoAmazon > 0 ? (r.gananciaNeta / r.costoAmazon) * 100 : null,
        margen: r.ventaML > 0 ? (r.gananciaNeta / r.ventaML) * 100 : null,
        rentable: r.gananciaNeta > 0,
      }))
      .sort((a, b) => b.ventaML - a.ventaML);
  }, [orders, orderCostMXN]);

  const filteredRows = useMemo(() => productRows.filter(r => {
    if (searchQuery && !r.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !r.key.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (roiFilter === 'positive' && (r.roi === null || r.roi <= 0)) return false;
    if (roiFilter === 'negative' && (r.roi === null || r.roi > 0)) return false;
    if (rentableFilter === 'yes' && !r.rentable) return false;
    if (rentableFilter === 'no' && r.rentable) return false;
    return true;
  }), [productRows, searchQuery, roiFilter, rentableFilter]);

  const handleAddExpense = async () => {
    if (!newConcept.trim() || !newAmount.trim()) return;
    setSaving(true);
    try {
      const created = await api.expenses.create({
        concept: newConcept.trim(),
        amount: parseFloat(newAmount),
        period: newPeriod,
        year_month: selectedYM,
      });
      setChartExpenses(prev => [...prev, created]);
      setNewConcept('');
      setNewAmount('');
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteExpense = async (id: number) => {
    setChartExpenses(prev => prev.filter(e => e.id !== id));
    api.expenses.delete(id).catch(console.error);
  };

  const handleExport = () => {
    const header = 'Producto,Venta ML,Costo Amazon,Neto ML,Ganancia Neta,ROI%,Margen%,Rentable\n';
    const rows = filteredRows.map(r =>
      `"${r.name}",${r.ventaML},${r.costoAmazon},${r.netoML},${r.gananciaNeta},${r.roi?.toFixed(1) ?? 'N/A'},${r.margen?.toFixed(1) ?? 'N/A'},${r.rentable ? 'Sí' : 'No'}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rentabilidad_${selectedYM}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const deltaArrow = (pct: number | null) => {
    if (pct === null) return null;
    const up = pct >= 0;
    return (
      <span className={up ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
        {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
      </span>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 scroll-smooth bg-background-light dark:bg-background-dark">
      <div className="max-w-7xl mx-auto flex flex-col gap-6 pb-20">

        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black text-text-main-light dark:text-white tracking-tight uppercase">
              Métricas de Rentabilidad
            </h1>
            <p className="text-text-secondary-light dark:text-text-secondary-dark mt-2 font-medium italic">
              Balance real considerando gastos operativos y costos de Amazon.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Month picker */}
            <div className="relative">
              <button
                onClick={() => setShowPicker(!showPicker)}
                className="px-4 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-semibold text-text-main-light dark:text-white hover:shadow-sm transition-all flex items-center gap-2"
              >
                📅 {ymLabel(selectedYM)} ▾
              </button>
              {showPicker && (
                <div className="absolute right-0 top-12 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-4 shadow-xl">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <button onClick={() => setPickerYear(y => y - 1)}
                      className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 text-xl">‹</button>
                    <span className="font-bold text-sm text-text-main-light dark:text-white">{pickerYear}</span>
                    <button onClick={() => setPickerYear(y => y + 1)}
                      disabled={pickerYear >= new Date().getFullYear()}
                      className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 text-xl disabled:opacity-30">›</button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {MONTH_NAMES.map((mn, i) => {
                      const ym = `${pickerYear}-${String(i + 1).padStart(2, '0')}`;
                      const isFuture = ym > today;
                      const isSelected = ym === selectedYM;
                      return (
                        <button key={mn} disabled={isFuture}
                          onClick={() => { setSelectedYM(ym); setShowPicker(false); }}
                          className={`px-3 py-2 text-xs font-semibold rounded-lg transition-all ${
                            isSelected ? 'bg-primary text-white' : isFuture ? 'bg-slate-100 dark:bg-slate-700 text-slate-300 cursor-not-allowed' : 'bg-slate-100 dark:bg-slate-700 text-text-main-light dark:text-white hover:bg-slate-200 dark:hover:bg-slate-600'
                          }`}>
                          {mn}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Export CSV button */}
            <button
              onClick={handleExport}
              className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-sm font-semibold flex items-center gap-2 transition-all shadow-md hover:shadow-lg"
            >
              <span className="material-symbols-outlined text-[18px]">download</span>
              Exportar CSV
            </button>
          </div>
        </div>

        {loading && (
          <div className="text-center text-primary font-semibold py-4">Cargando datos...</div>
        )}

        {/* KPI Cards - 4 cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Ingresos Brutos */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 border-b-4 border-b-green-500 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-widest text-text-secondary-light dark:text-text-secondary-dark mb-2">
              Ingresos Brutos
            </div>
            <div className="text-3xl font-black text-text-main-light dark:text-white mb-2">
              {fmt(kpis.ingresos)}
            </div>
            <div className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
              {kpis.ordersCount} órdenes · {deltaArrow(kpis.deltaIngresos)}
            </div>
          </div>

          {/* Ganancia Bruta */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 border-b-4 border-b-blue-500 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-widest text-text-secondary-light dark:text-text-secondary-dark mb-2">
              Ganancia Bruta
            </div>
            <div className={`text-3xl font-black mb-2 ${kpis.ganBruta >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {fmt(kpis.ganBruta)}
            </div>
            <div className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
              Neto ML − Costo Amazon · {deltaArrow(kpis.deltaGanBruta)}
            </div>
          </div>

          {/* Gastos Operativos */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 border-b-4 border-b-red-500 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-widest text-text-secondary-light dark:text-text-secondary-dark mb-2">
              Gastos Operativos
            </div>
            <div className="text-3xl font-black text-text-main-light dark:text-white mb-2">
              {fmt(kpis.gastos)}
            </div>
            <div className="text-xs text-text-secondary-light dark:text-text-secondary-dark">
              {monthExpenses.length} conceptos · {deltaArrow(kpis.deltaGastos)}
            </div>
          </div>

          {/* Ganancia Neta Real - BLUE CARD with Margen Ring */}
          <div className="bg-primary text-white rounded-2xl p-6 shadow-xl shadow-primary/20 flex flex-col justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-blue-100 mb-2">
                Ganancia Neta Real
              </div>
              <div className={`text-3xl font-black mb-2 ${kpis.ganNeta >= 0 ? 'text-white' : 'text-blue-100'}`}>
                {fmt(kpis.ganNeta)}
              </div>
              <div className="text-xs text-blue-100">
                Gan. Bruta − Gastos · {deltaArrow(kpis.deltaGanNeta)}
              </div>
            </div>
            <div className="flex justify-end mt-4">
              <MarginRing pct={kpis.margen} />
            </div>
          </div>
        </div>

        {/* Chart Section */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
            <div>
              <h2 className="text-xl font-black text-text-main-light dark:text-white uppercase">
                Tendencia de Ganancias
              </h2>
              <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark mt-1">
                Histórico comparativo de salud financiera
              </p>
            </div>
            <div className="flex gap-2">
              {(['1m', '3m', '6m', '12m'] as const).map((f) => {
                const label = f.toUpperCase();
                return (
                  <button key={f} onClick={() => setTimeFilter(f)}
                    className={`px-3 py-2 text-xs font-bold rounded-lg transition-all ${
                      timeFilter === f
                        ? 'bg-primary text-white'
                        : 'bg-slate-100 dark:bg-slate-700 text-text-main-light dark:text-white hover:bg-slate-200 dark:hover:bg-slate-600'
                    }`}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mb-4 flex gap-4 text-xs">
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 bg-green-500 rounded"></span>
              Ingresos Brutos
            </span>
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 bg-primary rounded"></span>
              Ganancia Neta
            </span>
          </div>

          <div className="flex items-end gap-2 h-64 overflow-x-auto pb-2">
            <div className="flex flex-col justify-between h-48 text-xs text-text-secondary-light dark:text-text-secondary-dark pr-2">
              <span>{fmtShort(chartMax)}</span>
              <span>{fmtShort(chartMax / 2)}</span>
              <span>$0</span>
            </div>
            {chartData.map(d => {
              const ingH = chartMax > 0 ? (d.ingresos / chartMax) * 180 : 0;
              const netH = chartMax > 0 ? (Math.max(0, d.ganNeta) / chartMax) * 180 : 0;
              const isSelected = d.ym === selectedYM;
              const up = d.deltaVsPrev !== null && d.deltaVsPrev >= 0;
              return (
                <div key={d.ym} onClick={() => setSelectedYM(d.ym)}
                  className="flex flex-col items-center flex-1 cursor-pointer group"
                  title={`${d.label}\nIngresos: ${fmt(d.ingresos)}\nGan. Neta: ${fmt(d.ganNeta)}${d.deltaVsPrev !== null ? `\nvs anterior: ${d.deltaVsPrev > 0 ? '+' : ''}${d.deltaVsPrev.toFixed(1)}%` : ''}`}>
                  {d.deltaVsPrev !== null && (
                    <div className="h-5 flex items-center justify-center mb-1">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                        up ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      }`}>
                        {up ? '▲' : '▼'}{Math.abs(d.deltaVsPrev).toFixed(0)}%
                      </span>
                    </div>
                  )}
                  <div className="flex gap-1 items-end h-48">
                    <div className={`w-3 transition-all ${ingH}px rounded-t-sm ${isSelected ? 'bg-green-400' : 'bg-green-500'}`} />
                    <div className={`w-3 transition-all ${netH}px rounded-t-sm ${isSelected ? 'bg-blue-400' : 'bg-primary'}`} />
                  </div>
                  <span className={`text-xs font-semibold mt-2 whitespace-nowrap ${isSelected ? 'text-text-main-light dark:text-white' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
                    {d.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Gastos Operativos Panel */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm">
            <h2 className="text-lg font-black text-text-main-light dark:text-white mb-4 uppercase">
              Gastos — {ymLabel(selectedYM)}
            </h2>

            <div className="space-y-3 mb-4">
              <input
                placeholder="Concepto"
                value={newConcept}
                onChange={e => setNewConcept(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-700 rounded-lg text-sm text-text-main-light dark:text-white placeholder-text-secondary-light dark:placeholder-text-secondary-dark focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <div className="flex gap-2">
                <input
                  placeholder="Monto (MXN)"
                  type="number"
                  value={newAmount}
                  onChange={e => setNewAmount(e.target.value)}
                  className="flex-1 px-3 py-2 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-700 rounded-lg text-sm text-text-main-light dark:text-white placeholder-text-secondary-light dark:placeholder-text-secondary-dark focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <select
                  value={newPeriod}
                  onChange={e => setNewPeriod(e.target.value)}
                  className="px-3 py-2 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-700 rounded-lg text-sm text-text-main-light dark:text-white focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option>Mensual</option>
                  <option>Semanal</option>
                  <option>Anual</option>
                  <option>Único</option>
                </select>
              </div>
              <button
                onClick={handleAddExpense}
                disabled={saving || !newConcept.trim() || !newAmount.trim()}
                className="w-full px-3 py-2 bg-primary hover:bg-primary-dark disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-all"
              >
                {saving ? 'Guardando...' : '+ Agregar gasto'}
              </button>
            </div>

            {monthExpenses.length === 0 ? (
              <p className="text-center text-text-secondary-light dark:text-text-secondary-dark text-sm py-4">
                Sin gastos registrados este mes
              </p>
            ) : (
              <div className="space-y-2">
                {monthExpenses.map(e => (
                  <div key={e.id} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-main-light dark:text-white truncate">{e.concept}</div>
                      <div className="text-xs text-text-secondary-light dark:text-text-secondary-dark">{e.period}</div>
                    </div>
                    <span className="font-semibold text-primary text-sm whitespace-nowrap">{fmt(e.amount)}</span>
                    <button
                      onClick={() => handleDeleteExpense(e.id)}
                      className="text-red-500 hover:text-red-700 text-lg leading-none"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="border-t border-slate-200 dark:border-slate-700 pt-2 mt-2 flex justify-between font-semibold text-sm">
                  <span className="text-text-secondary-light dark:text-text-secondary-dark">Total</span>
                  <span className="text-primary">{fmt(kpis.gastos)}</span>
                </div>
              </div>
            )}
          </div>

          {/* Product Profitability Table */}
          <div className="lg:col-span-2 bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
              <h2 className="text-lg font-black text-text-main-light dark:text-white uppercase">
                Rentabilidad por Producto
              </h2>
              <div className="flex gap-2 flex-wrap">
                <input
                  placeholder="Buscar..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="px-3 py-2 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-700 rounded-lg text-sm text-text-main-light dark:text-white placeholder-text-secondary-light focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <select
                  value={roiFilter}
                  onChange={e => setRoiFilter(e.target.value as any)}
                  className="px-3 py-2 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-700 rounded-lg text-sm text-text-main-light dark:text-white focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="all">Todo ROI</option>
                  <option value="positive">ROI +</option>
                  <option value="negative">ROI -</option>
                </select>
                <select
                  value={rentableFilter}
                  onChange={e => setRentableFilter(e.target.value as any)}
                  className="px-3 py-2 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-700 rounded-lg text-sm text-text-main-light dark:text-white focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="all">Todos</option>
                  <option value="yes">Rentables</option>
                  <option value="no">No rentables</option>
                </select>
              </div>
            </div>

            {filteredRows.length === 0 ? (
              <p className="text-center text-text-secondary-light dark:text-text-secondary-dark text-sm py-8">
                {orders.length === 0 ? 'Sin órdenes en este período' : 'Sin resultados para los filtros aplicados'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left px-3 py-2 font-bold text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase">Producto</th>
                      <th className="text-right px-3 py-2 font-bold text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase">Venta ML</th>
                      <th className="text-right px-3 py-2 font-bold text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase">Costo Amazon</th>
                      <th className="text-right px-3 py-2 font-bold text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase">Neto ML</th>
                      <th className="text-right px-3 py-2 font-bold text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase">Gan. Neta</th>
                      <th className="text-right px-3 py-2 font-bold text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase">ROI%</th>
                      <th className="text-right px-3 py-2 font-bold text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase">Margen%</th>
                      <th className="text-center px-3 py-2 font-bold text-text-secondary-light dark:text-text-secondary-dark text-xs uppercase">¿Rentable?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map(r => (
                      <tr key={r.key} className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30">
                        <td className="px-3 py-3 text-text-main-light dark:text-white truncate max-w-xs" title={r.name}>{r.name}</td>
                        <td className="text-right px-3 py-3 text-text-main-light dark:text-white font-medium">{fmt(r.ventaML)}</td>
                        <td className="text-right px-3 py-3 text-text-secondary-light dark:text-text-secondary-dark">{fmt(r.costoAmazon)}</td>
                        <td className="text-right px-3 py-3 text-text-main-light dark:text-white font-medium">{fmt(r.netoML)}</td>
                        <td className={`text-right px-3 py-3 font-bold ${r.gananciaNeta >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{fmt(r.gananciaNeta)}</td>
                        <td className={`text-right px-3 py-3 ${r.roi === null ? 'text-text-secondary-light dark:text-text-secondary-dark' : r.roi >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {r.roi !== null ? `${r.roi.toFixed(1)}%` : '—'}
                        </td>
                        <td className={`text-right px-3 py-3 ${r.margen === null ? 'text-text-secondary-light dark:text-text-secondary-dark' : r.margen >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {r.margen !== null ? `${r.margen.toFixed(1)}%` : '—'}
                        </td>
                        <td className="text-center px-3 py-3">
                          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                            r.rentable ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          }`}>
                            {r.rentable ? 'Sí' : 'No'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 dark:border-slate-700 font-bold text-text-main-light dark:text-white">
                      <td className="px-3 py-3">Totales ({filteredRows.length})</td>
                      <td className="text-right px-3 py-3">{fmt(filteredRows.reduce((s, r) => s + r.ventaML, 0))}</td>
                      <td className="text-right px-3 py-3 text-text-secondary-light dark:text-text-secondary-dark">{fmt(filteredRows.reduce((s, r) => s + r.costoAmazon, 0))}</td>
                      <td className="text-right px-3 py-3">{fmt(filteredRows.reduce((s, r) => s + r.netoML, 0))}</td>
                      <td className="text-right px-3 py-3 text-green-600 dark:text-green-400">{fmt(filteredRows.reduce((s, r) => s + r.gananciaNeta, 0))}</td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
