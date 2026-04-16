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
  const r = 36;
  const circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * circ;
  const color = pct < 10 ? '#ef4444' : pct < 25 ? '#f59e0b' : '#10b981';
  return (
    <svg width="100" height="100" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r={r} fill="none" stroke="#1e293b" strokeWidth="10" />
      <circle
        cx="50" cy="50" r={r} fill="none"
        stroke={color} strokeWidth="10"
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="54" textAnchor="middle" fill={color} fontSize="16" fontWeight="bold">
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
  const [timeFilter, setTimeFilter] = useState<'3m' | '6m' | '12m'>('6m');
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
    const count = timeFilter === '3m' ? 3 : timeFilter === '6m' ? 6 : 12;
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

  // ── Derived slices ────────────────────────────────────────────────────────────
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

  // ── Cost helper ───────────────────────────────────────────────────────────────
  const orderCostMXN = useCallback((o: Order): number => {
    if (!o.amazonPurchasePrice) return 0;
    const currency = currencyMap[o.amazonAsin] ?? 'USD';
    return currency === 'USD' ? o.amazonPurchasePrice * exchangeRate : o.amazonPurchasePrice;
  }, [currencyMap, exchangeRate]);

  // ── KPIs ──────────────────────────────────────────────────────────────────────
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

  // ── Chart data ────────────────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    const count = timeFilter === '3m' ? 3 : timeFilter === '6m' ? 6 : 12;
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

  // ── Product rows ──────────────────────────────────────────────────────────────
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

  // ── Expense handlers ──────────────────────────────────────────────────────────
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

  const deltaArrow = (pct: number | null) => {
    if (pct === null) return null;
    const up = pct >= 0;
    return (
      <span style={{ color: up ? '#10b981' : '#ef4444', fontSize: '0.75rem' }}>
        {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
      </span>
    );
  };

  // ── Shared styles ─────────────────────────────────────────────────────────────
  const card: React.CSSProperties = {
    background: '#1e293b', borderRadius: '0.75rem',
    padding: '1.25rem', border: '1px solid #334155',
  };
  const inputStyle: React.CSSProperties = {
    background: '#0f172a', border: '1px solid #334155',
    borderRadius: '0.4rem', color: '#f1f5f9',
    padding: '0.5rem 0.75rem', fontSize: '0.85rem',
  };
  const th: React.CSSProperties = {
    padding: '0.5rem 0.75rem', fontWeight: 500,
    color: '#64748b', borderBottom: '1px solid #334155',
    whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = { padding: '0.6rem 0.75rem' };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div
      style={{ padding: '1.5rem', background: '#0f172a', minHeight: '100vh', color: '#f1f5f9' }}
      onClick={() => showPicker && setShowPicker(false)}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Analítica</h1>
          <p style={{ color: '#94a3b8', margin: '0.25rem 0 0', fontSize: '0.875rem' }}>
            Resultados financieros históricos
          </p>
        </div>

        {/* Month picker */}
        <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setShowPicker(!showPicker)}
            style={{ ...inputStyle, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
          >
            📅 {ymLabel(selectedYM)} <span style={{ color: '#94a3b8' }}>▾</span>
          </button>
          {showPicker && (
            <div style={{ position: 'absolute', right: 0, top: '110%', background: '#1e293b', border: '1px solid #334155', borderRadius: '0.75rem', padding: '1rem', zIndex: 50, width: '240px', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <button onClick={() => setPickerYear(y => y - 1)}
                  style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '1.4rem', lineHeight: 1 }}>‹</button>
                <span style={{ fontWeight: 600 }}>{pickerYear}</span>
                <button onClick={() => setPickerYear(y => y + 1)}
                  disabled={pickerYear >= new Date().getFullYear()}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.4rem', lineHeight: 1, color: pickerYear >= new Date().getFullYear() ? '#334155' : '#94a3b8' }}>›</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.4rem' }}>
                {MONTH_NAMES.map((mn, i) => {
                  const ym = `${pickerYear}-${String(i + 1).padStart(2, '0')}`;
                  const isFuture = ym > today;
                  const isSelected = ym === selectedYM;
                  return (
                    <button key={mn} disabled={isFuture}
                      onClick={() => { setSelectedYM(ym); setShowPicker(false); }}
                      style={{ padding: '0.4rem', borderRadius: '0.4rem', border: 'none', cursor: isFuture ? 'not-allowed' : 'pointer', fontSize: '0.8rem', fontWeight: isSelected ? 700 : 400, background: isSelected ? '#6366f1' : '#0f172a', color: isSelected ? '#fff' : isFuture ? '#334155' : '#94a3b8' }}>
                      {mn}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', color: '#6366f1', padding: '1rem', fontSize: '0.875rem' }}>
          Cargando datos...
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={card}>
          <div style={{ color: '#94a3b8', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Ingresos Brutos</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{fmt(kpis.ingresos)}</div>
          <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', color: '#64748b' }}>
            {kpis.ordersCount} órdenes &nbsp;{deltaArrow(kpis.deltaIngresos)}
          </div>
        </div>

        <div style={card}>
          <div style={{ color: '#94a3b8', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Ganancia Bruta</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: kpis.ganBruta >= 0 ? '#10b981' : '#ef4444' }}>{fmt(kpis.ganBruta)}</div>
          <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', color: '#64748b' }}>
            Neto ML − Costo Amazon &nbsp;{deltaArrow(kpis.deltaGanBruta)}
          </div>
        </div>

        <div style={card}>
          <div style={{ color: '#94a3b8', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Gastos Operativos</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f59e0b' }}>{fmt(kpis.gastos)}</div>
          <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', color: '#64748b' }}>
            {monthExpenses.length} conceptos &nbsp;{deltaArrow(kpis.deltaGastos)}
          </div>
        </div>

        <div style={card}>
          <div style={{ color: '#94a3b8', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>Ganancia Neta Real</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: kpis.ganNeta >= 0 ? '#10b981' : '#ef4444' }}>{fmt(kpis.ganNeta)}</div>
          <div style={{ marginTop: '0.25rem', fontSize: '0.75rem', color: '#64748b' }}>
            Gan. Bruta − Gastos &nbsp;{deltaArrow(kpis.deltaGanNeta)}
          </div>
        </div>

        <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ color: '#94a3b8', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem', textAlign: 'center' }}>Margen Neto</div>
          <MarginRing pct={kpis.margen} />
        </div>
      </div>

      {/* Chart */}
      <div style={{ ...card, marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Evolución Mensual</h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {(['3m', '6m', '12m'] as const).map(f => (
              <button key={f} onClick={() => setTimeFilter(f)}
                style={{ padding: '0.25rem 0.75rem', borderRadius: '0.4rem', border: 'none', cursor: 'pointer', fontSize: '0.8rem', background: timeFilter === f ? '#6366f1' : '#0f172a', color: timeFilter === f ? '#fff' : '#94a3b8' }}>
                {f}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.75rem', fontSize: '0.75rem', color: '#94a3b8' }}>
          <span>
            <span style={{ display: 'inline-block', width: '10px', height: '10px', background: '#10b981', borderRadius: '2px', marginRight: '4px' }} />
            Ingresos Brutos
          </span>
          <span>
            <span style={{ display: 'inline-block', width: '10px', height: '10px', background: '#6366f1', borderRadius: '2px', marginRight: '4px' }} />
            Ganancia Neta
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.4rem', height: '230px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height: '180px', color: '#64748b', fontSize: '0.68rem', textAlign: 'right', minWidth: '38px', marginBottom: '30px' }}>
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
                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', justifyContent: 'flex-end', height: '230px' }}
                title={`${d.label}\nIngresos: ${fmt(d.ingresos)}\nGan. Neta: ${fmt(d.ganNeta)}${d.deltaVsPrev !== null ? `\nvs anterior: ${d.deltaVsPrev > 0 ? '+' : ''}${d.deltaVsPrev.toFixed(1)}%` : ''}`}>
                {/* delta badge */}
                <div style={{ height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '2px' }}>
                  {d.deltaVsPrev !== null && (
                    <span style={{ fontSize: '0.58rem', fontWeight: 700, color: up ? '#10b981' : '#ef4444', background: up ? '#064e3b' : '#450a0a', borderRadius: '999px', padding: '1px 5px', whiteSpace: 'nowrap' }}>
                      {up ? '▲' : '▼'}{Math.abs(d.deltaVsPrev).toFixed(0)}%
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '180px' }}>
                  <div style={{ width: '12px', height: `${ingH}px`, background: isSelected ? '#34d399' : '#10b981', borderRadius: '3px 3px 0 0', transition: 'height 0.3s' }} />
                  <div style={{ width: '12px', height: `${netH}px`, background: isSelected ? '#818cf8' : '#6366f1', borderRadius: '3px 3px 0 0', transition: 'height 0.3s' }} />
                </div>
                <span style={{ fontSize: '0.62rem', color: isSelected ? '#f1f5f9' : '#64748b', marginTop: '4px', whiteSpace: 'nowrap' }}>
                  {d.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1.5rem', alignItems: 'start' }}>

        {/* Gastos Operativos Panel */}
        <div style={card}>
          <h2 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>
            Gastos — {ymLabel(selectedYM)}
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
            <input placeholder="Concepto" value={newConcept}
              onChange={e => setNewConcept(e.target.value)}
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input placeholder="Monto (MXN)" type="number" value={newAmount}
                onChange={e => setNewAmount(e.target.value)}
                style={{ ...inputStyle, flex: 1 }} />
              <select value={newPeriod} onChange={e => setNewPeriod(e.target.value)}
                style={{ ...inputStyle, cursor: 'pointer' }}>
                <option>Mensual</option>
                <option>Semanal</option>
                <option>Anual</option>
                <option>Único</option>
              </select>
            </div>
            <button onClick={handleAddExpense}
              disabled={saving || !newConcept.trim() || !newAmount.trim()}
              style={{ background: saving || !newConcept.trim() || !newAmount.trim() ? '#334155' : '#6366f1', border: 'none', borderRadius: '0.4rem', color: '#fff', padding: '0.5rem', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
              {saving ? 'Guardando...' : '+ Agregar gasto'}
            </button>
          </div>

          {monthExpenses.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: '0.85rem', textAlign: 'center', padding: '1rem 0' }}>
              Sin gastos registrados este mes
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {monthExpenses.map(e => (
                <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.75rem', background: '#0f172a', borderRadius: '0.4rem', gap: '0.5rem' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.concept}</div>
                    <div style={{ fontSize: '0.7rem', color: '#64748b' }}>{e.period}</div>
                  </div>
                  <span style={{ color: '#f59e0b', fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap' }}>{fmt(e.amount)}</span>
                  <button onClick={() => handleDeleteExpense(e.id)}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '1.1rem', padding: '0 0.2rem', lineHeight: 1 }}>×</button>
                </div>
              ))}
              <div style={{ borderTop: '1px solid #334155', paddingTop: '0.5rem', display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', fontWeight: 700 }}>
                <span style={{ color: '#94a3b8' }}>Total</span>
                <span style={{ color: '#f59e0b' }}>{fmt(kpis.gastos)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Product Profitability Table */}
        <div style={{ ...card, overflowX: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Rentabilidad por Producto</h2>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <input placeholder="Buscar producto / ASIN" value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ ...inputStyle, width: '180px' }} />
              <select value={roiFilter} onChange={e => setRoiFilter(e.target.value as any)}
                style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="all">Todo ROI</option>
                <option value="positive">ROI positivo</option>
                <option value="negative">ROI negativo</option>
              </select>
              <select value={rentableFilter} onChange={e => setRentableFilter(e.target.value as any)}
                style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="all">Todos</option>
                <option value="yes">Rentables</option>
                <option value="no">No rentables</option>
              </select>
            </div>
          </div>

          {filteredRows.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: '0.875rem', textAlign: 'center', padding: '2rem 0' }}>
              {orders.length === 0 ? 'Sin órdenes en este período' : 'Sin resultados para los filtros aplicados'}
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'left' }}>Producto</th>
                  <th style={{ ...th, textAlign: 'right' }}>Venta ML</th>
                  <th style={{ ...th, textAlign: 'right' }}>Costo Amazon</th>
                  <th style={{ ...th, textAlign: 'right' }}>Neto ML</th>
                  <th style={{ ...th, textAlign: 'right' }}>Gan. Neta</th>
                  <th style={{ ...th, textAlign: 'right' }}>ROI%</th>
                  <th style={{ ...th, textAlign: 'right' }}>Margen%</th>
                  <th style={{ ...th, textAlign: 'center' }}>¿Rentable?</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(r => (
                  <tr key={r.key} style={{ borderBottom: '1px solid #0f172a' }}>
                    <td style={{ ...td, maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.name}>{r.name}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmt(r.ventaML)}</td>
                    <td style={{ ...td, textAlign: 'right', color: '#94a3b8' }}>{fmt(r.costoAmazon)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{fmt(r.netoML)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: r.gananciaNeta >= 0 ? '#10b981' : '#ef4444' }}>{fmt(r.gananciaNeta)}</td>
                    <td style={{ ...td, textAlign: 'right', color: r.roi === null ? '#64748b' : r.roi >= 0 ? '#10b981' : '#ef4444' }}>
                      {r.roi !== null ? `${r.roi.toFixed(1)}%` : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: r.margen === null ? '#64748b' : r.margen >= 0 ? '#10b981' : '#ef4444' }}>
                      {r.margen !== null ? `${r.margen.toFixed(1)}%` : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <span style={{ background: r.rentable ? '#064e3b' : '#450a0a', color: r.rentable ? '#34d399' : '#f87171', borderRadius: '999px', padding: '0.2rem 0.6rem', fontSize: '0.7rem', fontWeight: 600 }}>
                        {r.rentable ? 'Sí' : 'No'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #334155', fontWeight: 700 }}>
                  <td style={{ ...td, color: '#94a3b8' }}>Totales ({filteredRows.length})</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmt(filteredRows.reduce((s, r) => s + r.ventaML, 0))}</td>
                  <td style={{ ...td, textAlign: 'right', color: '#94a3b8' }}>{fmt(filteredRows.reduce((s, r) => s + r.costoAmazon, 0))}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmt(filteredRows.reduce((s, r) => s + r.netoML, 0))}</td>
                  <td style={{ ...td, textAlign: 'right', color: '#10b981' }}>{fmt(filteredRows.reduce((s, r) => s + r.gananciaNeta, 0))}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
