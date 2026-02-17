import React, { useState, useMemo } from 'react';

interface Expense {
  id: number;
  concept: string;
  amount: number;
  period: string;
}

interface ProductProfit {
  id: string;
  name: string;
  asin: string;
  cost: number;
  shipping: number;
  package: number;
  sale: number;
  image: string;
}

export const AnalyticsPage = () => {
  // Period State
  const [selectedMonth, setSelectedMonth] = useState('Octubre');
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const monthAbbr = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  // Time and Chart State
  const [timeFilter, setTimeFilter] = useState<'1m' | '3m' | '6m' | '12m'>('6m');

  // Expenses State
  const [expenses, setExpenses] = useState<Expense[]>([
    { id: 1, concept: 'Suscripción Software', amount: 1200, period: 'Mensual' },
    { id: 2, concept: 'Internet Fibra', amount: 890, period: 'Mensual' },
    { id: 3, concept: 'Asistente Virtual', amount: 4500, period: 'Salario' },
    { id: 4, concept: 'Publicidad Ads', amount: 8610, period: 'Presupuesto' }
  ]);
  const [newConcept, setNewConcept] = useState('');
  const [newAmount, setNewAmount] = useState('');

  // Table State
  const [searchQuery, setSearchQuery] = useState('');
  const [roiFilter, setRoiFilter] = useState('all');

  const productsProfitData: ProductProfit[] = [
    { id: '1', name: 'Nike Air Max Red - Size 10', asin: 'B08XYZ1234', cost: 1200, shipping: 150, package: 25, sale: 2100, image: 'https://picsum.photos/100/100?random=50' },
    { id: '2', name: 'Sony Wireless Headphones WH-1000XM4', asin: 'B08ABC9876', cost: 4500, shipping: 200, package: 40, sale: 6800, image: 'https://picsum.photos/100/100?random=51' },
    { id: '3', name: 'Canon EF 50mm f/1.8 STM Lens', asin: 'B08LENS456', cost: 2800, shipping: 180, package: 30, sale: 3400, image: 'https://picsum.photos/100/100?random=52' },
    { id: '4', name: 'Keychron K2 Mechanical Keyboard', asin: 'B08KEY7890', cost: 1800, shipping: 160, package: 35, sale: 3200, image: 'https://picsum.photos/100/100?random=53' }
  ];

  // Logic: Totals
  const totalExpenses = useMemo(() => expenses.reduce((acc, curr) => acc + curr.amount, 0), [expenses]);
  const totalRevenue = 450200; 
  const grossProfit = 120500; 
  const netProfit = grossProfit - totalExpenses;

  // Handlers
  const handleAddExpense = () => {
    if (!newConcept.trim() || !newAmount) return;
    const expense: Expense = {
      id: Date.now(),
      concept: newConcept,
      amount: parseFloat(newAmount),
      period: 'Manual'
    };
    setExpenses(prev => [...prev, expense]);
    setNewConcept('');
    setNewAmount('');
  };

  const handleDeleteExpense = (id: number) => {
    setExpenses(prev => prev.filter(e => e.id !== id));
  };

  const handleExport = () => {
    const header = "Balance " + selectedMonth + " 2025\nConcepto,Monto\n";
    const summary = `Ingresos,${totalRevenue}\nGastos Operativos,${totalExpenses}\nGanancia Neta,${netProfit}\n\n`;
    const detailsHeader = "Detalle Productos\nNombre,ASIN,Venta,Costo Total,Ganancia\n";
    const details = productsProfitData.map(p => {
        const totalC = p.cost + p.shipping + p.package;
        const prof = p.sale - totalC;
        return `"${p.name}",${p.asin},${p.sale},${totalC},${prof}`;
    }).join("\n");
    
    const csvContent = "data:text/csv;charset=utf-8," + encodeURIComponent(header + summary + detailsHeader + details);
    const link = document.createElement("a");
    link.setAttribute("href", csvContent);
    link.setAttribute("download", `reporte_melidrop_${selectedMonth.toLowerCase()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filter Table
  const filteredProducts = useMemo(() => {
    return productsProfitData.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                            p.asin.toLowerCase().includes(searchQuery.toLowerCase());
      
      const totalCost = p.cost + p.shipping + p.package;
      const profit = p.sale - totalCost;
      const roi = (profit / totalCost) * 100;
      
      let matchesRoi = true;
      if (roiFilter === 'low') matchesRoi = roi < 15;
      if (roiFilter === 'high') matchesRoi = roi >= 15;
      
      return matchesSearch && matchesRoi;
    });
  }, [searchQuery, roiFilter]);

  // Chart Data Simulation with actual month names
  const chartPoints = useMemo(() => {
    const pointsMap = { '1m': 4, '3m': 3, '6m': 6, '12m': 12 };
    const count = pointsMap[timeFilter] || 6;
    const currentMonthIdx = 9; // Oct
    
    return Array.from({ length: count }).map((_, i) => {
        const mIdx = (currentMonthIdx - (count - 1 - i) + 12) % 12;
        const rev = Math.floor(Math.random() * 40) + 50;
        const exp = Math.floor(Math.random() * 20) + 10;
        const label = count === 4 ? `S${i + 1}` : monthAbbr[mIdx];
        return { rev, exp, label };
    });
  }, [timeFilter]);

  const yAxisLabels = ['$100k', '$75k', '$50k', '$25k', '$0'];

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 space-y-6 bg-background-light dark:bg-background-dark">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-black tracking-tight text-slate-900 dark:text-white uppercase">Métricas de Rentabilidad</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1 font-medium italic">Balance real considerando gastos operativos y costos de Amazon.</p>
        </div>
        <div className="flex gap-2 relative">
            <div className="relative">
                <button 
                  onClick={() => setShowMonthPicker(!showMonthPicker)}
                  className="flex items-center gap-2 px-4 h-11 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-black text-slate-700 dark:text-slate-200 hover:border-primary transition-all shadow-sm"
                >
                    <span className="material-symbols-outlined text-[20px] text-primary">calendar_month</span>
                    <span>{selectedMonth} 2025</span>
                    <span className="material-symbols-outlined text-[16px]">expand_more</span>
                </button>
                {showMonthPicker && (
                  <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-slate-800 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 z-50 overflow-hidden grid grid-cols-1 divide-y divide-slate-50 dark:divide-slate-700 animate-fade-in">
                    {months.map(m => (
                      <button 
                        key={m} 
                        onClick={() => { setSelectedMonth(m); setShowMonthPicker(false); }} 
                        className={`px-4 py-2 text-left text-xs font-bold transition-colors ${selectedMonth === m ? 'bg-primary text-white' : 'hover:bg-primary/10 text-slate-600 dark:text-slate-300'}`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          <button 
            onClick={handleExport}
            className="flex items-center gap-2 px-6 py-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-xl text-sm font-black hover:opacity-90 transition-all shadow-lg active:scale-95"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            Exportar CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between h-36 border-b-4 border-b-green-500">
          <p className="text-slate-500 dark:text-slate-400 text-[10px] font-black uppercase tracking-widest">Ingresos Brutos</p>
          <div>
            <p className="text-3xl font-black text-slate-900 dark:text-white tracking-tighter">${totalRevenue.toLocaleString()}</p>
            <div className="flex items-center gap-1 mt-2 text-[10px] font-black text-green-600 uppercase">
              <span className="material-symbols-outlined text-[14px]">trending_up</span> +12%
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between h-36 border-b-4 border-b-blue-500">
          <p className="text-slate-500 dark:text-slate-400 text-[10px] font-black uppercase tracking-widest">Ganancia Bruta</p>
          <div>
            <p className="text-3xl font-black text-slate-900 dark:text-white tracking-tighter">${grossProfit.toLocaleString()}</p>
            <p className="text-slate-400 text-[10px] font-bold mt-2 uppercase">Margen: 34%</p>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between h-36 border-b-4 border-b-red-500">
          <p className="text-slate-500 dark:text-slate-400 text-[10px] font-black uppercase tracking-widest">Gastos Operativos</p>
          <div>
            <p className="text-3xl font-black text-slate-900 dark:text-white tracking-tighter">${totalExpenses.toLocaleString()}</p>
            <p className="text-red-500 text-[10px] font-bold mt-2 uppercase">{expenses.length} conceptos</p>
          </div>
        </div>
        <div className="bg-primary rounded-2xl p-6 shadow-xl shadow-primary/20 flex flex-col justify-between h-36">
          <p className="text-white/70 text-[10px] font-black uppercase tracking-widest">Ganancia Neta Real</p>
          <div>
            <p className="text-3xl font-black text-white tracking-tighter">${netProfit.toLocaleString()}</p>
            <p className="text-white/50 text-[10px] font-bold mt-2 uppercase italic">Efectivo final</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* CHART SECTION */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm p-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
            <div>
              <h3 className="text-lg font-black text-slate-900 dark:text-white uppercase tracking-tighter">Tendencia de Ganancias</h3>
              <p className="text-xs text-slate-500 font-bold">Histórico comparativo de salud financiera</p>
            </div>
            <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-xl">
              {(['1m', '3m', '6m', '12m'] as const).map(f => (
                <button 
                  key={f} 
                  onClick={() => setTimeFilter(f)} 
                  className={`px-4 py-1.5 text-[10px] font-black rounded-lg transition-all ${timeFilter === f ? 'bg-primary text-white shadow-md' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          
          <div className="flex w-full">
            {/* Y-Axis Labels */}
            <div className="flex flex-col justify-between items-end pr-4 pb-8 h-64 text-[10px] font-black text-slate-400 uppercase tracking-tighter w-14">
              {yAxisLabels.map(label => <span key={label}>{label}</span>)}
            </div>
            
            {/* Chart Plot Area */}
            <div className="flex-1">
              <div className="h-64 flex items-end justify-between relative px-2">
                <div className="absolute inset-0 flex flex-col justify-between pointer-events-none pb-0.5">
                  {[0,1,2,3,4].map(i => <div key={i} className="w-full border-t border-slate-100 dark:border-slate-700/50"></div>)}
                </div>

                {chartPoints.map((p, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center group relative h-full justify-end z-10">
                    <div className="flex gap-1 items-end h-full w-full justify-center px-1">
                      <div className="w-2.5 bg-green-500 rounded-t-md shadow-sm transition-all group-hover:brightness-110" style={{ height: `${p.rev}%` }}></div>
                      <div className="w-2.5 bg-red-500 rounded-t-md shadow-sm transition-all group-hover:brightness-110" style={{ height: `${p.exp}%` }}></div>
                      <div className="w-2.5 bg-primary rounded-t-md shadow-sm transition-all group-hover:brightness-110" style={{ height: `${Math.max(5, p.rev - p.exp)}%` }}></div>
                    </div>
                    
                    <div className="absolute -top-16 opacity-0 group-hover:opacity-100 transition-all scale-95 group-hover:scale-100 bg-slate-900 text-white text-[10px] p-3 rounded-xl shadow-2xl z-20 w-32 font-bold pointer-events-none">
                        <div className="flex justify-between"><span>Ventas:</span> <span>${p.rev}k</span></div>
                        <div className="flex justify-between text-red-400"><span>Gastos:</span> <span>${p.exp}k</span></div>
                        <div className="h-px bg-slate-700/50 my-1"></div>
                        <div className="flex justify-between text-green-400"><span>Neto:</span> <span>${p.rev - p.exp}k</span></div>
                    </div>
                  </div>
                ))}
              </div>
              
              <div className="flex justify-between items-start mt-3 px-2">
                {chartPoints.map((p, i) => (
                  <span key={i} className="flex-1 text-center text-[10px] font-black text-slate-500 uppercase tracking-widest">{p.label}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-6 mt-10 justify-center border-t border-slate-100 dark:border-slate-700/50 pt-6">
              <div className="flex items-center gap-2"><div className="size-3 rounded-sm bg-green-500 shadow-sm"></div><span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Ingresos</span></div>
              <div className="flex items-center gap-2"><div className="size-3 rounded-sm bg-red-500 shadow-sm"></div><span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Gastos</span></div>
              <div className="flex items-center gap-2"><div className="size-3 rounded-sm bg-primary shadow-sm"></div><span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Ganancia Real</span></div>
          </div>
        </div>

        {/* Expenses Management */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col overflow-hidden">
          <div className="p-6 border-b border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50">
            <h3 className="text-base font-black text-slate-900 dark:text-white uppercase tracking-tighter">Gastos Operativos</h3>
            <p className="text-xs text-slate-500 font-bold">Ingresar nuevos costos fijos</p>
          </div>
          
          <div className="p-6 space-y-4">
            <div className="flex flex-col gap-2">
              <input 
                value={newConcept}
                onChange={(e) => setNewConcept(e.target.value)}
                className="w-full text-xs font-bold rounded-xl border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-3 focus:ring-primary" 
                placeholder="Concepto..." 
                type="text" 
              />
              <div className="flex gap-2">
                <input 
                  value={newAmount}
                  onChange={(e) => setNewAmount(e.target.value)}
                  className="w-full text-xs font-bold rounded-xl border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-3 focus:ring-primary" 
                  placeholder="$ Monto" 
                  type="number" 
                />
                <button 
                  onClick={handleAddExpense}
                  className="bg-primary hover:bg-primary-dark text-white px-5 rounded-xl text-sm font-bold shadow-lg shadow-primary/20 transition-all active:scale-95"
                >
                  <span className="material-symbols-outlined">add</span>
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 space-y-2 pb-6">
            {expenses.map(e => (
              <div key={e.id} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900/50 rounded-xl group border border-transparent hover:border-slate-200 transition-all">
                <div className="flex flex-col">
                  <p className="text-xs font-black text-slate-900 dark:text-white uppercase">{e.concept}</p>
                  <p className="text-[9px] text-slate-400 font-bold uppercase">{e.period}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-black text-slate-900 dark:text-white">${e.amount.toLocaleString()}</span>
                  <button onClick={() => handleDeleteExpense(e.id)} className="text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100">
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="p-5 bg-primary/5 dark:bg-primary/10 border-t border-primary/10 flex justify-between items-center px-6">
              <span className="text-xs font-black text-slate-500 uppercase tracking-widest">Total Gastos</span>
              <span className="text-xl font-black text-primary">${totalExpenses.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl flex flex-col overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-50/30 dark:bg-slate-900/50">
          <div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white uppercase tracking-tighter">Rentabilidad por Producto</h3>
            <p className="text-xs text-slate-500 font-bold">Rendimiento neto por cada ASIN.</p>
          </div>
          <div className="flex flex-wrap gap-2 w-full lg:w-auto">
            <div className="relative flex-1 lg:flex-none">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-[20px]">search</span>
              <input 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-4 py-2 w-full lg:w-64 rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-bold focus:ring-primary shadow-sm" 
                placeholder="Buscar ASIN o Nombre..." 
                type="text" 
              />
            </div>
            <select 
              value={roiFilter}
              onChange={(e) => setRoiFilter(e.target.value)}
              className="px-4 py-2 rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-black focus:ring-primary uppercase shadow-sm"
            >
              <option value="all">Filtro ROI: Todos</option>
              <option value="low">Bajo ROI (&lt; 15%)</option>
              <option value="high">Alto ROI (&gt;= 15%)</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/50 dark:bg-slate-900 text-slate-400 uppercase text-[10px] font-black tracking-widest border-b border-slate-100 dark:border-slate-700">
              <tr>
                <th className="px-6 py-4">Producto</th>
                <th className="px-6 py-4 text-right">Costo Amz</th>
                <th className="px-6 py-4 text-right">Logística</th>
                <th className="px-6 py-4 text-right">Venta ML</th>
                <th className="px-6 py-4 text-right">Ganancia</th>
                <th className="px-6 py-4 text-center">ROI %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredProducts.map(p => {
                const totalCost = p.cost + p.shipping + p.package;
                const profit = p.sale - totalCost;
                const roi = (profit / totalCost) * 100;
                return (
                  <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="size-10 bg-slate-100 dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700 overflow-hidden"><img src={p.image} className="w-full h-full object-cover" /></div>
                        <div>
                          <p className="font-black text-slate-900 dark:text-white text-xs line-clamp-1 uppercase tracking-tighter">{p.name}</p>
                          <span className="text-[10px] text-primary font-bold">ASIN: {p.asin}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right font-bold text-slate-500">${p.cost.toLocaleString()}</td>
                    <td className="px-6 py-4 text-right font-bold text-slate-500">${(p.shipping + p.package).toLocaleString()}</td>
                    <td className="px-6 py-4 text-right font-black text-slate-900 dark:text-white">${p.sale.toLocaleString()}</td>
                    <td className={`px-6 py-4 text-right font-black ${profit > 500 ? 'text-green-600' : 'text-orange-500'}`}>+${profit.toLocaleString()}</td>
                    <td className="px-6 py-4 text-center">
                      <span className={`px-2 py-1 rounded text-[10px] font-black uppercase border ${roi > 20 ? 'bg-green-100 text-green-700 border-green-200' : 'bg-orange-100 text-orange-700 border-orange-200'}`}>
                        {roi.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};