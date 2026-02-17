import React, { useState } from 'react';
import { DashboardStats } from '../types';
import { useNavigate } from 'react-router-dom';

interface DashboardPageProps {
  user: any;
  stats: DashboardStats;
  meliData?: any;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ user, stats, meliData }) => {
  const navigate = useNavigate();
  const [timeFilter, setTimeFilter] = useState('7d');
  const [metricFilter, setMetricFilter] = useState('money');
  const [showCustomPicker, setShowCustomPicker] = useState(false);

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 scroll-smooth bg-background-light dark:bg-background-dark">
      <div className="max-w-7xl mx-auto flex flex-col gap-6">

        {/* 1. Header con Saludo y Reputación */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm transition-all hover:shadow-md">
          <div className="flex items-center gap-4">
            <div className="relative">
              <img className="w-16 h-16 rounded-2xl object-cover border-2 border-primary/20 p-0.5" alt="Profile" src={user?.avatarUrl} />
              <div className="absolute -bottom-1 -right-1 bg-green-500 w-4 h-4 rounded-full border-2 border-white dark:border-slate-800"></div>
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-black text-slate-900 dark:text-white tracking-tight">¡Hola, {user?.name?.split(' ')[0] || 'Usuario'}! 👋</h1>
              <div className="flex items-center gap-2 mt-1">
                <span className="bg-primary/10 text-primary text-[10px] font-bold px-2 py-0.5 rounded-full border border-primary/20 uppercase tracking-tighter">
                  {user?.level?.includes('Nivel') ? `Nivel de Vendedor` : user?.level || 'Vendedor'}
                </span>
                <span className="text-slate-400 text-xs font-medium">•</span>
                <span className="text-slate-500 dark:text-slate-400 text-xs font-medium italic">{user?.email}</span>
              </div>
            </div>
          </div>

          {/* Semáforo de Reputación Dinámico */}
          <div className="flex flex-col gap-2 min-w-[280px]">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Tu Reputación</span>
              <span className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-1 ${meliData?.user?.reputation?.includes('green') ? 'text-green-500' :
                meliData?.user?.reputation?.includes('yellow') ? 'text-yellow-500' : 'text-red-500'
                }`}>
                {meliData?.user?.reputation?.includes('green') ? 'Excelente salud' :
                  meliData?.user?.reputation?.includes('yellow') ? 'Atención necesaria' : 'Riesgo Crítico'}
                <span className="material-symbols-outlined text-[14px]">
                  {meliData?.user?.reputation?.includes('green') ? 'check_circle' : 'warning'}
                </span>
              </span>
            </div>
            <div className="flex gap-1.5 h-3">
              {[
                { id: '1_red', color: 'bg-red-500' },
                { id: '2_orange', color: 'bg-orange-500' },
                { id: '3_yellow', color: 'bg-yellow-500' },
                { id: '4_light_green', color: 'bg-green-400' },
                { id: '5_green', color: 'bg-green-500' }
              ].map((level, idx) => {
                const isActive = meliData?.user?.reputation === level.id ||
                  (meliData?.user?.reputation === 'unknown' && idx === 4); // Default to green if unknown for now or handle appropriately

                return (
                  <div
                    key={level.id}
                    className={`flex-1 rounded-full transition-all duration-500 ${isActive ? `${level.color} shadow-[0_0_12px_rgba(34,197,94,0.3)]` : `${level.color}/20`
                      } relative group`}
                  >
                    {isActive && <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-white rounded-full"></div>}
                    <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[9px] py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap font-bold pointer-events-none z-20">
                      {user?.level}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-1">
              <p className="text-[9px] font-bold text-slate-400 italic">Datos en tiempo real de Mercado Libre</p>
              <button
                onClick={() => window.open('https://www.mercadolibre.com.mx/reputation', '_blank')}
                className="text-[9px] font-black text-primary hover:underline uppercase tracking-tighter"
              >
                Ver en ML
              </button>
            </div>
          </div>
        </div>

        {/* 2. BLOQUE DE KPIs (RESTORED FROM IMAGE) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 bg-green-50 dark:bg-green-900/20 rounded-lg text-green-500">
                <span className="material-symbols-outlined text-[20px]">shopping_bag</span>
              </div>
              <span className="text-sm font-medium text-slate-500 dark:text-slate-400">Ventas</span>
            </div>
            <p className="text-3xl font-black text-slate-900 dark:text-white leading-none">{stats.salesToday}</p>
            <div className="flex items-center gap-1 mt-2 text-xs font-bold text-green-500">
              <span className="material-symbols-outlined text-[14px]">trending_up</span>
              <span>+15% vs ayer</span>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg text-yellow-500">
                <span className="material-symbols-outlined text-[20px]">payments</span>
              </div>
              <span className="text-sm font-medium text-slate-500 dark:text-slate-400">Ingresos</span>
            </div>
            <p className="text-3xl font-black text-slate-900 dark:text-white leading-none">${stats.incomeToday.toLocaleString()}</p>
            <p className="text-[10px] font-bold text-slate-400 mt-2 uppercase tracking-tight">MXN total</p>
          </div>

          <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 bg-purple-50 dark:bg-purple-900/20 rounded-lg text-purple-500">
                <span className="material-symbols-outlined text-[20px]">help_center</span>
              </div>
              <span className="text-sm font-medium text-slate-500 dark:text-slate-400">Preguntas</span>
            </div>
            <p className="text-3xl font-black text-slate-900 dark:text-white leading-none">{meliData ? stats.questionsUnanswered : '--'}</p>
            <p className="text-[10px] font-bold text-purple-500 mt-2 uppercase tracking-tight">Sin responder</p>
          </div>

          <div className="bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-blue-500">
                <span className="material-symbols-outlined text-[20px]">receipt_long</span>
              </div>
              <span className="text-sm font-medium text-slate-500 dark:text-slate-400">Ticket Prom.</span>
            </div>
            <p className="text-3xl font-black text-slate-900 dark:text-white leading-none">${stats.avgTicket.toLocaleString()}</p>
            <p className="text-[10px] font-bold text-slate-400 mt-2 uppercase tracking-tight">MXN por venta</p>
          </div>
        </div>

        {/* 3. RESUMEN DE RENTABILIDAD (RESTORED FROM IMAGE) */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
          <div className="p-6 flex justify-between items-center border-b border-slate-50 dark:border-slate-700/50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-50 dark:bg-green-900/20 rounded-lg text-green-600">
                <span className="material-symbols-outlined">savings</span>
              </div>
              <div>
                <h2 className="text-lg font-black text-slate-900 dark:text-white">Resumen de Rentabilidad</h2>
                <p className="text-xs text-slate-500">Indicadores financieros clave de tu operación</p>
              </div>
            </div>
            <button onClick={() => navigate('/analitica')} className="text-xs font-black text-primary flex items-center gap-1 uppercase tracking-tighter hover:underline">
              Ver Analítica <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-100 dark:divide-slate-700">
            <div className="p-6">
              <div className="flex justify-between items-start mb-2">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Ganancia Neta (Hoy)</p>
                <div className="size-10 bg-green-50 dark:bg-green-900/20 text-green-600 flex items-center justify-center rounded-xl">
                  <span className="material-symbols-outlined text-[20px]">account_balance_wallet</span>
                </div>
              </div>
              <p className="text-4xl font-black text-slate-900 dark:text-white">${(stats.incomeToday * 0.15).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
              <div className="flex items-center gap-2 mt-3">
                <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">trending_up</span> +12%
                </span>
                <span className="text-[10px] text-slate-400 font-medium">calculado al 15%</span>
              </div>
            </div>
            <div className="p-6">
              <div className="flex justify-between items-start mb-2">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">ROI Promedio</p>
                <div className="size-10 bg-blue-50 dark:bg-blue-900/20 text-blue-600 flex items-center justify-center rounded-xl">
                  <span className="material-symbols-outlined text-[20px]">analytics</span>
                </div>
              </div>
              <p className="text-4xl font-black text-slate-900 dark:text-white">28.4%</p>
              <div className="flex items-center gap-2 mt-3">
                <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">trending_up</span> Estimado
                </span>
              </div>
            </div>
            <div className="p-6">
              <div className="flex justify-between items-start mb-2">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Margen Bruto</p>
                <div className="size-10 bg-purple-50 dark:bg-purple-900/20 text-purple-600 flex items-center justify-center rounded-xl">
                  <span className="material-symbols-outlined text-[20px]">pie_chart</span>
                </div>
              </div>
              <p className="text-4xl font-black text-slate-900 dark:text-white">34.2%</p>
              <div className="flex items-center gap-2 mt-3">
                <span className="text-[10px] text-slate-400 font-medium">Proyectado</span>
              </div>
            </div>
          </div>
        </div>

        {/* 4. Sección Mercado Pago */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden flex flex-col sm:flex-row">
          <div className="p-6 bg-meli-yellow flex flex-col justify-center items-center sm:items-start min-w-[200px]">
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined text-meli-purple font-bold">account_balance_wallet</span>
              <h3 className="text-meli-purple font-black text-xs uppercase tracking-wider">Mercado Pago</h3>
            </div>
            <p className="text-xs text-meli-purple/70 font-bold">Dinero en cuenta</p>
            <p className="text-2xl font-black text-meli-purple mt-1">${meliData?.balance?.total.toLocaleString() || '0.00'}</p>
          </div>
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-100 dark:divide-slate-700">
            <div className="p-6 flex flex-col justify-center">
              <p className="text-xs font-bold text-slate-400 uppercase mb-1">Disponible</p>
              <p className="text-xl font-bold text-green-600">${meliData?.balance?.available.toLocaleString() || '0.00'}</p>
              <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1 font-medium">
                <span className="material-symbols-outlined text-[14px]">bolt</span> Retiro inmediato
              </p>
            </div>
            <div className="p-6 flex flex-col justify-center">
              <p className="text-xs font-bold text-slate-400 uppercase mb-1">A Liquidar</p>
              <p className="text-xl font-bold text-blue-600">${meliData?.balance?.unavailable.toLocaleString() || '0.00'}</p>
              <p className="text-[10px] text-slate-500 mt-1 flex items-center gap-1 font-medium">
                <span className="material-symbols-outlined text-[14px]">schedule</span> Ventas en proceso
              </p>
            </div>
            <div className="p-6 bg-slate-50/50 dark:bg-slate-900/20 flex flex-col justify-center items-center">
              <button className="w-full bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-meli-purple dark:text-white py-2.5 rounded-xl text-xs font-bold shadow-sm hover:shadow transition-all active:scale-95">
                Ver detalle de cuenta
              </button>
            </div>
          </div>
        </div>

        {/* 5. Atajos de Mensajería y Tiempo */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-surface-light dark:bg-surface-dark p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between hover:shadow-md transition-shadow">
            <div className="flex justify-between items-start mb-4">
              <div className="bg-red-50 dark:bg-red-900/20 p-2.5 rounded-lg text-red-600 dark:text-red-400">
                <span className="material-symbols-outlined">forum</span>
              </div>
              <span className="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs font-bold px-2.5 py-1 rounded-full animate-pulse">Urgente</span>
            </div>
            <div>
              <p className="text-text-secondary-light dark:text-text-secondary-dark text-sm font-medium">Preguntas sin responder</p>
              <p className="text-4xl font-bold text-text-main-light dark:text-white mt-1">{stats.questionsUnanswered}</p>
            </div>
            <button
              onClick={() => navigate('/mensajeria?tab=questions')}
              className="mt-4 w-full py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-text-main-light dark:text-white text-sm font-bold rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
            >
              Responder preguntas
            </button>
          </div>
          <div className="bg-surface-light dark:bg-surface-dark p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between hover:shadow-md transition-shadow">
            <div className="flex justify-between items-start mb-4">
              <div className="bg-blue-50 dark:bg-blue-900/20 p-2.5 rounded-lg text-blue-600 dark:text-blue-400">
                <span className="material-symbols-outlined">mail</span>
              </div>
              <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs font-bold px-2.5 py-1 rounded-full">Atención</span>
            </div>
            <div>
              <p className="text-text-secondary-light dark:text-text-secondary-dark text-sm font-medium">Mensajes sin leer</p>
              <p className="text-4xl font-bold text-text-main-light dark:text-white mt-1">{meliData ? (stats.messagesUnread || 0) : '--'}</p>
            </div>
            <button
              onClick={() => navigate('/mensajeria?tab=messages')}
              className="mt-4 w-full py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-text-main-light dark:text-white text-sm font-bold rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
            >
              Ver mensajes
            </button>
          </div>

          <div className="bg-surface-light dark:bg-surface-dark p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col relative overflow-hidden h-full min-h-[220px]">
            <div className="w-full flex justify-between items-start z-10 mb-2">
              <h3 className="text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark">Tiempo de respuesta</h3>
              <span className="material-symbols-outlined text-slate-300 dark:text-slate-600">timer</span>
            </div>
            <div className="flex-1 flex items-center justify-center z-10 w-full relative">
              <div className="relative w-32 h-32 flex items-center justify-center">
                <svg className="w-full h-full transform -rotate-90 drop-shadow-sm" viewBox="0 0 100 100">
                  <circle className="text-slate-100 dark:text-slate-800" cx="50" cy="50" r="45" fill="none" stroke="currentColor" strokeWidth="10" />
                  <circle cx="50" cy="50" r="45" fill="none" stroke="#22c55e" strokeWidth="10" strokeDasharray="283" strokeDashoffset="60" strokeLinecap="round" />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-3xl font-extrabold text-text-main-light dark:text-white leading-none tracking-tight">
                    {meliData?.stats?.responseTime || '--'}
                  </span>
                  <p className="text-[8px] font-bold text-text-secondary-light dark:text-text-secondary-dark uppercase mt-1">Promedio</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 6. Performance y Gráfica */}
        <div className="bg-surface-light dark:bg-surface-dark p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col">
          <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-8">
            <div>
              <h3 className="text-lg font-extrabold text-text-main-light dark:text-white">Performance y Rentabilidad</h3>
              <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">Monitorea tu crecimiento diario.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-xl border border-slate-100 dark:border-slate-700">
              <div className="flex bg-white dark:bg-slate-900 rounded-lg p-1 shadow-sm border border-slate-200 dark:border-slate-700">
                {['7d', '15d', '30d', 'Mes'].map(t => (
                  <button
                    key={t}
                    onClick={() => setTimeFilter(t)}
                    className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all ${timeFilter === t ? 'bg-primary text-white shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                  >
                    {t.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="flex bg-white dark:bg-slate-900 rounded-lg p-1 shadow-sm border border-slate-200 dark:border-slate-700">
                <button onClick={() => setMetricFilter('money')} className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all flex items-center gap-1 ${metricFilter === 'money' ? 'bg-primary text-white shadow-sm' : 'text-slate-500'}`}>
                  <span className="material-symbols-outlined text-sm">attach_money</span> DINERO
                </button>
                <button onClick={() => setMetricFilter('units')} className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all flex items-center gap-1 ${metricFilter === 'units' ? 'bg-primary text-white shadow-sm' : 'text-slate-500'}`}>
                  <span className="material-symbols-outlined text-sm">inventory_2</span> PRODUCTOS
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-[200px] relative w-full flex items-end justify-between gap-3 px-2 pb-6 mb-2">
            <div className="absolute inset-0 flex flex-col justify-between pointer-events-none opacity-50">
              {[1, 2, 3, 4].map(l => <div key={l} className="w-full h-px bg-slate-100 dark:bg-slate-800"></div>)}
            </div>
            {[
              { h: '30%', val: 120 }, { h: '45%', val: 145 }, { h: '35%', val: 132 }, { h: '80%', val: 210 },
              { h: '65%', val: 180 }, { h: '95%', val: 255 }, { h: '75%', val: 225 },
            ].map((bar, i) => (
              <div key={i} className="relative w-full group flex flex-col items-center">
                <div className={`w-full max-w-[40px] rounded-t-lg transition-all duration-300 group-hover:scale-x-110 shadow-sm ${metricFilter === 'money' ? 'bg-primary' : 'bg-orange-400'}`} style={{ height: bar.h }}>
                  <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-opacity z-20 font-bold shadow-xl border border-slate-700">
                    {metricFilter === 'money' ? `$${bar.val * 100}` : bar.val}
                  </div>
                </div>
                <div className="absolute bottom-[-24px] text-[10px] font-bold text-slate-400">Día {i + 1}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 7. BLOQUE DE PUBLICACIONES (DINÁMICO CON DESGLOSE) */}
        <div className="bg-white dark:bg-slate-800 p-8 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col relative w-full max-w-lg mx-auto sm:mx-0">
          <div className="flex justify-between items-center mb-10">
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">Relación de Publicaciones</h3>
            <button onClick={() => navigate('/publicaciones')} className="text-primary text-sm font-bold hover:underline">Ver todas</button>
          </div>

          <div className="flex flex-col items-center">
            {/* Gráfico de Dona SVG Dinámico */}
            <div className="relative w-56 h-56 flex items-center justify-center mb-10">
              {(() => {
                const breakdown = meliData?.itemsBreakdown || { total: 0, active: 0, paused: 0, premium: 0, classic: 0 };
                const total = breakdown.total || 854;
                const circumference = 263.89; // 2 * PI * 42

                // Calculamos porcentajes y offsets
                const activeClassicPct = (breakdown.classic / total) * 100;
                const activePremiumPct = (breakdown.premium / total) * 100;
                const pausedPct = (breakdown.paused / total) * 100;

                const classicOffset = 0;
                const premiumOffset = (activeClassicPct / 100) * circumference;
                const pausedOffset = ((activeClassicPct + activePremiumPct) / 100) * circumference;

                return (
                  <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="42" fill="transparent" stroke="#f1f5f9" strokeWidth="12" />
                    {/* Clásica (Azul) */}
                    <circle cx="50" cy="50" r="42" fill="transparent" stroke="#137fec" strokeWidth="12"
                      strokeDasharray={`${(activeClassicPct / 100) * circumference} ${circumference}`}
                      strokeDashoffset={-classicOffset} strokeLinecap="round" />
                    {/* Premium (Amarillo) */}
                    <circle cx="50" cy="50" r="42" fill="transparent" stroke="#facc15" strokeWidth="12"
                      strokeDasharray={`${(activePremiumPct / 100) * circumference} ${circumference}`}
                      strokeDashoffset={-premiumOffset} strokeLinecap="round" />
                    {/* Pausada (Gris) */}
                    <circle cx="50" cy="50" r="42" fill="transparent" stroke="#cbd5e1" strokeWidth="12"
                      strokeDasharray={`${(pausedPct / 100) * circumference} ${circumference}`}
                      strokeDashoffset={-pausedOffset} strokeLinecap="round" />
                  </svg>
                );
              })()}
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-5xl font-bold text-slate-900 dark:text-white">{meliData?.itemsBreakdown?.total || meliData?.itemsCount || '0'}</span>
                <span className="text-sm text-slate-400 font-medium">Totales</span>
              </div>
            </div>

            {/* Leyenda Detallada */}
            <div className="w-full grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1 p-3 bg-slate-50 dark:bg-slate-900/40 rounded-xl">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#137fec]"></span>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">Clásicas</span>
                </div>
                <span className="text-lg font-black text-slate-900 dark:text-white">
                  {meliData?.itemsBreakdown?.classic ?? '0'}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-3 bg-slate-50 dark:bg-slate-900/40 rounded-xl">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#facc15]"></span>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">Premium</span>
                </div>
                <span className="text-lg font-black text-slate-900 dark:text-white">
                  {meliData?.itemsBreakdown?.premium ?? '0'}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-3 bg-slate-50 dark:bg-slate-900/40 rounded-xl">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#22c55e]"></span>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">Activas</span>
                </div>
                <span className="text-lg font-black text-slate-900 dark:text-white">
                  {meliData?.itemsBreakdown?.active ?? '0'}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-3 bg-slate-50 dark:bg-slate-900/40 rounded-xl">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#cbd5e1]"></span>
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">Pausadas</span>
                </div>
                <span className="text-lg font-black text-slate-900 dark:text-white">
                  {meliData?.itemsBreakdown?.paused ?? '0'}
                </span>
              </div>
            </div>
          </div>
        </div>

        <footer className="mt-8 text-center text-xs text-text-secondary-light dark:text-text-secondary-dark pb-4">
          <p>© 2024 MeliDrop. Panel optimizado para Mercado Líder Platinum.</p>
        </footer>
      </div>
    </div>
  );
};