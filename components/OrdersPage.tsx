import React, { useState, useMemo, useEffect } from 'react';
import { api } from '../services/api';
import { Order } from '../types';

export const OrdersPage = () => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [amazonFilter, setAmazonFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [purchaseModal, setPurchaseModal] = useState<Order | null>(null);
  const [purchasePrice, setPurchasePrice] = useState('');

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  const todayStr = new Date().toISOString().split('T')[0];

  useEffect(() => {
    // Initial fetch
    api.orders.list()
      .then(data => {
        setOrders(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching orders:', err);
        setLoading(false);
      });
  }, []);

  const filteredOrders = useMemo(() => {
    return orders.filter(order => {
      const matchesSearch = order.id.toLowerCase().includes(search.toLowerCase()) ||
        order.buyerName.toLowerCase().includes(search.toLowerCase()) ||
        order.productTitle.toLowerCase().includes(search.toLowerCase()) ||
        order.amazonAsin.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = statusFilter === 'all' || order.status === statusFilter;
      const matchesAmazon = amazonFilter === 'all' || order.amazonStatus === amazonFilter;
      return matchesSearch && matchesStatus && matchesAmazon;
    });
  }, [orders, search, statusFilter, amazonFilter]);

  const shipTodayCount = useMemo(() => orders.filter(o => o.shippingDeadline === todayStr && o.status !== 'shipped' && o.status !== 'delivered').length, [orders, todayStr]);
  const pendingPurchaseCount = useMemo(() => orders.filter(o => o.amazonStatus === 'pending').length, [orders]);

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelectedIds(filteredOrders.map(o => o.id));
    } else {
      setSelectedIds([]);
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(sid => sid !== id) : [...prev, id]);
  };

  const handleRegisterPurchase = async () => {
    if (!purchaseModal || !purchasePrice) return;

    // Optimistic update
    const updatedOrder = { ...purchaseModal, amazonStatus: 'purchased' as const, amazonPurchasePrice: parseFloat(purchasePrice) };

    try {
      await api.orders.update(updatedOrder);
      setOrders(prev => prev.map(o => o.id === purchaseModal.id ? updatedOrder : o));
      setPurchaseModal(null);
      setPurchasePrice('');
      alert('Compra registrada exitosamente.');
    } catch (e) {
      console.error("Error updating order", e);
      alert('Error al registrar compra.');
    }
  };

  const getAmazonLink = (order: Order) => {
    const domain = order.amazonMarketplace === 'US' ? 'amazon.com' : 'amazon.com.mx';
    return `https://www.${domain}/dp/${order.amazonAsin}`;
  };

  const handleExport = () => {
    const header = "ID,Producto,Comprador,Fecha,Total,Estado,Status Amazon,Costo Amazon\n";
    const rows = filteredOrders.map(o =>
      `${o.id},"${o.productTitle}","${o.buyerName}",${o.date},${o.total},${o.status},${o.amazonStatus},${o.amazonPurchasePrice || 0}`
    ).join("\n");
    const csvContent = "data:text/csv;charset=utf-8," + encodeURIComponent(header + rows);
    const link = document.createElement("a");
    link.setAttribute("href", csvContent);
    link.setAttribute("download", "ordenes_melidrop.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 scroll-smooth bg-background-light dark:bg-background-dark">
      <div className="max-w-7xl mx-auto flex flex-col gap-8 pb-20">

        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Gestión de Órdenes</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1 font-medium">Panel operativo de compras en Amazon y envíos Mercado Libre.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => alert('Actualizando órdenes...')} className="bg-primary hover:bg-primary-dark text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all shadow-lg shadow-primary/20">
              <span className="material-symbols-outlined text-[20px]">sync</span>
              Sincronizar Ventas
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
              <span className="material-symbols-outlined text-6xl text-orange-500">local_shipping</span>
            </div>
            <p className="text-slate-500 dark:text-slate-400 text-xs font-black uppercase tracking-widest">Envíos para Hoy</p>
            <div className="flex items-end gap-3 mt-2">
              <p className="text-4xl font-black text-slate-900 dark:text-white">{shipTodayCount}</p>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${shipTodayCount > 0 ? 'bg-orange-100 text-orange-600 animate-pulse' : 'bg-slate-100 text-slate-400'}`}>
                {shipTodayCount > 0 ? 'URGENTE' : 'Al día'}
              </span>
            </div>
          </div>
          <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
              <span className="material-symbols-outlined text-6xl text-blue-500">shopping_cart</span>
            </div>
            <p className="text-slate-500 dark:text-slate-400 text-xs font-black uppercase tracking-widest">Pendientes Amazon</p>
            <div className="flex items-end gap-3 mt-2">
              <p className="text-4xl font-black text-slate-900 dark:text-white">{pendingPurchaseCount}</p>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-600">Por Comprar</span>
            </div>
          </div>
          <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between">
            <div>
              <p className="text-slate-500 dark:text-slate-400 text-xs font-black uppercase tracking-widest">Ingresos Proyectados</p>
              <p className="text-3xl font-black text-slate-900 dark:text-white mt-1">$45,200.00</p>
            </div>
            <div className="flex items-center gap-2 mt-4">
              <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full"><div className="h-full bg-green-500 rounded-full" style={{ width: '65%' }}></div></div>
              <span className="text-[10px] font-bold text-slate-400">Objetivo Mensual</span>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col lg:flex-row justify-between items-center gap-4">
          <div className="relative w-full lg:w-96">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">search</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-10 pr-4 py-2 bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:ring-primary" placeholder="Buscar ID, Comprador o ASIN..." />
          </div>
          <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="bg-white dark:bg-slate-900 border-slate-200 rounded-lg text-xs font-bold py-2"><option value="all">Estado ML: Todos</option><option value="pending">Pendiente</option><option value="shipped">Enviado</option></select>
            <select value={amazonFilter} onChange={(e) => setAmazonFilter(e.target.value)} className="bg-white dark:bg-slate-900 border-slate-200 rounded-lg text-xs font-bold py-2"><option value="all">Amazon: Todos</option><option value="pending">No Comprados</option><option value="purchased">Comprados</option></select>
            <button onClick={handleExport} className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors"><span className="material-symbols-outlined text-[18px]">download</span>Exportar CSV</button>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-sm overflow-hidden min-h-[500px]">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900 text-slate-400 uppercase text-[10px] font-black tracking-widest border-b">
                <tr>
                  <th className="px-6 py-4 w-12"><input type="checkbox" className="rounded" checked={filteredOrders.length > 0 && selectedIds.length === filteredOrders.length} onChange={handleSelectAll} /></th>
                  <th className="px-6 py-4">Orden</th>
                  <th className="px-6 py-4">Producto / Enlace</th>
                  <th className="px-6 py-4 text-center">Entrega Límite</th>
                  <th className="px-6 py-4 text-right">Venta</th>
                  <th className="px-6 py-4 text-center">Compra Amazon</th>
                  <th className="px-6 py-4 text-right">Costo Real</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredOrders.length === 0 ? (
                  <tr><td colSpan={7} className="px-6 py-20 text-center text-slate-400 italic">No hay órdenes para mostrar.</td></tr>
                ) : (
                  filteredOrders.map(order => (
                    <tr key={order.id} className={`hover:bg-slate-50 dark:hover:bg-slate-900/50 transition-colors ${selectedIds.includes(order.id) ? 'bg-primary/5' : ''}`}>
                      <td className="px-6 py-4"><input type="checkbox" className="rounded" checked={selectedIds.includes(order.id)} onChange={() => toggleSelectOne(order.id)} /></td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col"><span className="font-black text-slate-900 dark:text-white">{order.id}</span><span className="text-xs text-slate-500">{order.buyerName}</span></div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col max-w-[220px]"><span className="font-bold text-slate-700 dark:text-slate-300 text-xs line-clamp-1">{order.productTitle}</span><a href={getAmazonLink(order)} target="_blank" rel="noreferrer" onClick={() => { if (order.amazonStatus === 'pending') setPurchaseModal(order); }} className="inline-flex items-center gap-1.5 bg-slate-900 text-white px-2 py-1 rounded text-[10px] font-black mt-1">COMPRAR EN {order.amazonMarketplace}<span className="material-symbols-outlined text-[14px]">open_in_new</span></a></div>
                      </td>
                      <td className="px-6 py-4 text-center"><span className={`text-[11px] font-black px-2 py-1 rounded ${order.shippingDeadline === todayStr ? 'bg-orange-500 text-white' : 'text-slate-600'}`}>{order.shippingDeadline}</span></td>
                      <td className="px-6 py-4 text-right font-black">${order.total.toLocaleString()}</td>
                      <td className="px-6 py-4 text-center">{order.amazonStatus === 'pending' ? <span className="text-[9px] font-black uppercase text-red-500">PENDIENTE</span> : <span className="text-[9px] font-black uppercase text-green-500">COMPRADO</span>}</td>
                      <td className="px-6 py-4 text-right">{order.amazonStatus === 'purchased' ? <span className="text-sm font-black">${order.amazonPurchasePrice?.toLocaleString()}</span> : <span className="text-xs text-slate-300">N/A</span>}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {selectedIds.length > 0 && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-8 animate-slide-up z-50"><span className="text-sm font-black uppercase">{selectedIds.length} Seleccionadas</span><button onClick={() => setSelectedIds([])} className="text-[11px] font-black text-red-400">Descartar</button></div>
        )}
      </div>

      {purchaseModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md">
          <div className="bg-white dark:bg-slate-800 w-full max-w-md rounded-3xl shadow-2xl overflow-hidden">
            <div className="p-6 border-b flex justify-between items-center"><h3 className="text-lg font-black uppercase">Costo Real Amazon</h3><button onClick={() => setPurchaseModal(null)} className="text-slate-400"><span className="material-symbols-outlined">close</span></button></div>
            <div className="p-8 space-y-6">
              <div className="space-y-3"><label className="text-[10px] font-black text-slate-500 uppercase">Monto Final Pagado</label><div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-black text-xl">$</span><input type="number" autoFocus value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} className="w-full pl-10 pr-4 py-4 bg-slate-50 dark:bg-slate-900 border-2 rounded-2xl font-black text-2xl text-slate-900 dark:text-white focus:border-primary" /></div></div>
            </div>
            <div className="p-6 bg-slate-50 dark:bg-slate-900/50 flex gap-4"><button onClick={() => setPurchaseModal(null)} className="flex-1 py-4 text-xs font-black text-slate-500 uppercase">Cancelar</button><button onClick={handleRegisterPurchase} disabled={!purchasePrice} className="flex-1 py-4 text-xs font-black bg-primary text-white rounded-2xl">REGISTRAR</button></div>
          </div>
        </div>
      )}
    </div>
  );
};