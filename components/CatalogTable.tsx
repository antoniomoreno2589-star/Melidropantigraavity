import React, { useState, useEffect } from 'react';
import { Product } from '../types';
import { useNavigate } from 'react-router-dom';
import { meliService } from '../services/meliService';
import { api } from '../services/api';
import { amazonDomainForCurrency } from '../services/amazonService';
import { SyncStatus } from './SyncStatus';

const calculatePrice = (costUSD: number, settings: any) => {
  const { exchangeRate, usaRules, usaDefaultMargin } = settings;
  const costMXN = costUSD * exchangeRate;
  const rule = usaRules.find((r: any) => {
    if (r.max === null) return costUSD >= r.min;
    return costUSD >= r.min && costUSD <= r.max;
  });
  const margin = rule ? rule.margin : usaDefaultMargin;
  return { costMXN, finalPrice: costMXN * (1 + margin / 100), marginUsed: margin };
};

export const CatalogTable: React.FC = () => {
  const navigate = useNavigate();

  // Server-side data
  const [products, setProducts] = useState<Product[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [statusCounts, setStatusCounts] = useState<{ active: number; paused: number; under_review: number; inactive: number; closed: number }>({
    active: 0, paused: 0, under_review: 0, inactive: 0, closed: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filter State
  const [filter, setFilter] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [searchCategory, setSearchCategory] = useState<'title' | 'sku' | 'meliId'>('title');
  const [dateType, setDateType] = useState<'updated' | 'created'>('updated');
  const [dateValue, setDateValue] = useState('');

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;
  const totalPages = Math.ceil(totalCount / itemsPerPage);

  // Selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Wizard State
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [wizardCalculations, setWizardCalculations] = useState<any>(null);

  // Edit Modal State
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Product>>({});

  // Image Preview State
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // Massive Actions State
  const [massiveModal, setMassiveModal] = useState<{ isOpen: boolean; action: string; value: string }>({
    isOpen: false, action: '', value: '',
  });

  // Sync State
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState({ phase: 'idle', current: 0, total: 0 });
  const [lastSyncData, setLastSyncData] = useState<{ finished_at: string; items_synced: number } | null>(null);

  // Debounce search input → triggers fetch
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Fetch products + status counts whenever page/filter/search/refreshKey changes
  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [result, counts] = await Promise.all([
          api.products.listPaginated(currentPage, itemsPerPage, { status: filter, search, searchCategory }),
          api.products.getStatusCounts(),
        ]);
        if (cancelled) return;
        setProducts(result.products);
        setTotalCount(result.total);
        setStatusCounts(counts);
      } catch (err) {
        if (!cancelled) console.error('Error fetching products:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchData();
    return () => { cancelled = true; };
  }, [currentPage, filter, search, searchCategory, refreshKey]);

  // Fetch last sync info on mount
  useEffect(() => {
    api.sync.getLastSync().then(setLastSyncData).catch(console.error);
  }, []);

  const refresh = () => {
    setSelectedIds([]);
    setRefreshKey(k => k + 1);
  };

  // Selection
  const toggleSelectAll = () => {
    if (selectedIds.length === products.length && products.length > 0) {
      setSelectedIds([]);
    } else {
      setSelectedIds(products.map(p => p.id));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(sid => sid !== id) : [...prev, id]);
  };

  // Bulk Actions
  const handleBulkAction = async (action: string) => {
    if (action === 'delete') {
      if (!confirm(`¿Estás seguro de eliminar ${selectedIds.length} productos?`)) return;
      try {
        await api.products.bulkDelete(selectedIds);
        refresh();
      } catch (err) {
        console.error('Error deleting products:', err);
        alert('Error al eliminar productos');
      }
    } else if (action === 'activate' || action === 'pause') {
      const status = action === 'activate' ? 'active' : 'paused';
      try {
        await api.products.bulkUpdateStatus(selectedIds, status);
        refresh();
      } catch (err) {
        console.error('Error updating status:', err);
        alert('Error al actualizar estado');
      }
    } else {
      setMassiveModal({ isOpen: true, action, value: '' });
    }
  };

  const applyMassiveUpdate = async () => {
    const { action, value } = massiveModal;
    if (!value) return;
    if (action === 'quantity') {
      try {
        await api.products.bulkUpdateStock(selectedIds, parseInt(value));
        refresh();
      } catch (err) {
        console.error('Error updating stock:', err);
        alert('Error al actualizar cantidad');
      }
    } else if (action === 'handling_time' || action === 'listing_type' || action === 'shipping') {
      // These edit Mercado Libre directly (unlike quantity/status above, which
      // only touch our Supabase cache) — there's no "handling_time" or
      // "listing_type_id" column on `products` for a background sync to pick
      // up later, so without a real API call here this button did nothing
      // but show a fake success alert.
      const targets = products.filter(p => selectedIds.includes(p.id) && p.meliId);
      const skipped = selectedIds.length - targets.length;
      const payload =
        action === 'handling_time' ? { shipping: { handling_time: parseInt(value) } } :
        action === 'listing_type'  ? { listing_type_id: value } :
                                      { shipping: { mode: value } };

      const errors: string[] = [];
      let okCount = 0;
      for (const p of targets) {
        const result = await meliService.updateItem(p.meliId!, payload);
        if (result.ok) okCount++;
        else errors.push(`${p.sku}: ${result.error}`);
      }

      const skippedMsg = skipped > 0 ? `\n${skipped} sin publicar en ML, omitidos.` : '';
      if (errors.length === 0) {
        alert(`✅ ${okCount} publicaciones actualizadas en Mercado Libre.${skippedMsg}`);
      } else {
        alert(`⚠️ ${okCount} actualizadas, ${errors.length} con error:\n${errors.slice(0, 5).join('\n')}${skippedMsg}`);
      }
      refresh();
    }
    setMassiveModal({ isOpen: false, action: '', value: '' });
  };

  // Sync Logic
  const handleSync = async () => {
    setIsSyncing(true);
    setSyncProgress({ phase: 'idle', current: 0, total: 0 });
    let syncLogId = '';
    try {
      syncLogId = await api.sync.startSync();
      const count = await meliService.syncItemsToSupabase((phase, current, total) => {
        setSyncProgress({ phase, current, total });
      });
      await api.sync.finishSync(syncLogId, count);
      const lastSync = await api.sync.getLastSync();
      setLastSyncData(lastSync);
      alert(`Sincronización terminada. Se procesaron ${count} publicaciones.`);
      refresh();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('Sync error:', error);
      if (syncLogId) await api.sync.finishSync(syncLogId, 0, errorMsg);
      alert(`Error al sincronizar publicaciones:\n${errorMsg}`);
    } finally {
      setIsSyncing(false);
    }
  };

  // Wizard Logic
  const openWizard = (product: Product) => {
    setSelectedProduct(product);
    const settings = {
      exchangeRate: parseFloat(localStorage.getItem('melidrop_exchange_rate') || '18.24'),
      usaRules: JSON.parse(localStorage.getItem('melidrop_usa_rules') || '[]'),
      usaDefaultMargin: parseFloat(localStorage.getItem('melidrop_usa_default_margin') || '30.0'),
    };
    if (settings.usaRules.length === 0) {
      settings.usaRules = [
        { id: 1, min: 0, max: 20, margin: 200 },
        { id: 2, min: 21, max: 50, margin: 100 },
        { id: 3, min: 51, max: null, margin: 50 },
      ];
    }
    setWizardCalculations(calculatePrice(product.costUSD, settings));
    setWizardStep(1);
    setIsWizardOpen(true);
  };

  const closeWizard = () => {
    setIsWizardOpen(false);
    setSelectedProduct(null);
    setWizardCalculations(null);
  };

  const handlePublish = async () => {
    if (!selectedProduct || !wizardCalculations) return;
    const updated: Product = {
      ...selectedProduct,
      status: 'active',
      meliId: `MLM${Math.floor(Math.random() * 10000000)}`,
      stockMeli: selectedProduct.stockProvider,
      priceMXN: wizardCalculations.finalPrice,
    };
    try {
      await api.products.update(updated);
      alert('¡Publicación simulada en Mercado Libre exitosa!');
      closeWizard();
      refresh();
    } catch (err) {
      console.error('Error publishing:', err);
      alert('Error al publicar el producto');
    }
  };

  // Edit Logic
  const openEdit = (product: Product) => {
    setSelectedProduct(product);
    setEditForm({ ...product });
    setIsEditOpen(true);
  };

  const saveEdit = async () => {
    if (!selectedProduct || !editForm) return;
    const updated = { ...selectedProduct, ...editForm } as Product;
    try {
      await api.products.update(updated);
      setProducts(prev => prev.map(p => p.id === updated.id ? updated : p));
      setIsEditOpen(false);
      setEditForm({});
      setSelectedProduct(null);
    } catch (err) {
      console.error('Error saving edit:', err);
      alert('Error al guardar los cambios');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 scroll-smooth">
      <div className="max-w-7xl mx-auto flex flex-col gap-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-[#0d141b] dark:text-white text-3xl font-extrabold leading-tight tracking-[-0.033em]">Publicaciones</h1>
              <span className="bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 px-2.5 py-0.5 rounded-full text-sm font-bold border border-slate-200 dark:border-slate-700">
                {totalCount}
              </span>
            </div>
            <p className="text-gray-500 dark:text-gray-400 mt-1">Administra tus productos sincronizados en Mercado Libre en tiempo real.</p>
          </div>
          <div className="flex gap-2">
            <SyncStatus lastSyncAt={lastSyncData?.finished_at} />
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="flex items-center justify-center rounded-lg h-11 px-6 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-white gap-2 text-sm font-bold shadow-sm transition-all hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 min-w-[160px]">
              <span className={`material-symbols-outlined text-[20px] ${isSyncing ? 'animate-spin' : ''}`}>sync</span>
              <span>
                {isSyncing
                  ? syncProgress.phase === 'searching'
                    ? `Fase 1: Buscando... (${syncProgress.current})`
                    : `Fase 2: Bajando... (${syncProgress.current}/${syncProgress.total})`
                  : 'Sincronizar'}
              </span>
            </button>
            <button
              onClick={() => navigate('/importar')}
              className="flex items-center justify-center rounded-lg h-11 px-6 bg-primary hover:bg-primary-dark text-white gap-2 text-sm font-bold shadow-sm transition-all hover:shadow-md transform active:scale-95">
              <span className="material-symbols-outlined text-[20px]">add_circle</span>
              <span>Importar Nuevos Productos</span>
            </button>
          </div>
        </div>

        {/* Advanced Filters Block */}
        <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 p-6 space-y-6">
          {/* Row 1: Search */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex flex-1 min-w-[300px] items-center">
              <select
                value={searchCategory}
                onChange={(e) => { setSearchCategory(e.target.value as any); setCurrentPage(1); }}
                className="h-10 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-l-lg px-3 text-sm focus:ring-0 focus:border-primary border-r-0"
              >
                <option value="title">Título</option>
                <option value="sku">SKU</option>
                <option value="meliId">MLM ID</option>
              </select>
              <div className="relative flex-1">
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="w-full h-10 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 text-sm focus:ring-0 focus:border-primary"
                  placeholder="Escribir..."
                />
              </div>
              <button className="h-10 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 border-l-0 rounded-r-lg px-3 text-slate-400 hover:text-primary">
                <span className="material-symbols-outlined text-[20px]">search</span>
              </button>
            </div>
          </div>

          {/* Row 2: Date Filters */}
          <div className="flex items-center gap-2">
            <div className="relative">
              <select
                value={dateType}
                onChange={(e) => setDateType(e.target.value as any)}
                className="h-10 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg pl-3 pr-8 text-sm focus:ring-0 focus:border-primary appearance-none min-w-[120px]"
              >
                <option value="updated">Actualiz...</option>
                <option value="created">Creado...</option>
              </select>
              <span className="material-symbols-outlined absolute right-2 top-2.5 text-slate-400 pointer-events-none text-sm">expand_more</span>
            </div>
            <div className="relative flex-1 max-w-[200px]">
              <input
                type="date"
                value={dateValue}
                onChange={(e) => setDateValue(e.target.value)}
                className="w-full h-10 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg px-3 text-sm focus:ring-0 focus:border-primary"
              />
            </div>
            <button className="p-2 text-slate-400 hover:text-primary">
              <span className="material-symbols-outlined text-[20px]">filter_alt</span>
            </button>
          </div>

          {/* Row 3: Status Tabs */}
          <div className="flex flex-wrap items-center gap-6 border-b border-slate-100 dark:border-slate-800 pb-1">
            {[
              { id: 'active', label: 'Activa' },
              { id: 'paused', label: 'Pausada' },
              { id: 'under_review', label: 'Revisando' },
              { id: 'inactive', label: 'Inactiva' },
              { id: 'closed', label: 'Eliminada por Mercado Libre', icon: true },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => { setFilter(tab.id === filter ? 'all' : tab.id); setCurrentPage(1); }}
                className={`pb-3 px-1 text-sm font-bold flex items-center gap-1.5 border-b-2 transition-all ${filter === tab.id ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
              >
                {tab.label}
                {tab.icon && <span className="material-symbols-outlined text-slate-400 text-xs">help</span>}
                <span className={`text-[11px] ${filter === tab.id ? 'text-primary/60' : 'text-slate-400'}`}>{(statusCounts as any)[tab.id] || 0}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Bulk Action Header */}
        {selectedIds.length > 0 && (
          <div className="bg-primary/10 dark:bg-primary/20 border border-primary/20 rounded-xl p-3 flex items-center justify-between animate-fade-in">
            <span className="text-sm font-bold text-primary px-2">{selectedIds.length} seleccionados</span>
            <div className="relative group">
              <button className="flex items-center gap-2 bg-white dark:bg-slate-800 border border-primary/30 px-4 py-1.5 rounded-lg text-sm font-bold text-slate-700 dark:text-white shadow-sm hover:shadow">
                Acciones Masivas
                <span className="material-symbols-outlined text-sm">expand_more</span>
              </button>
              <div className="absolute right-0 top-full mt-2 w-48 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 z-20 hidden group-hover:block hover:block">
                <button onClick={() => handleBulkAction('activate')} className="w-full text-left px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-green-500 text-sm">play_circle</span> Activar
                </button>
                <button onClick={() => handleBulkAction('pause')} className="w-full text-left px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-orange-500 text-sm">pause_circle</span> Pausar
                </button>
                <button onClick={() => handleBulkAction('listing_type')} className="w-full text-left px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-blue-500 text-sm">workspace_premium</span> Tipo de publicación
                </button>
                <button onClick={() => handleBulkAction('quantity')} className="w-full text-left px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-purple-500 text-sm">inventory_2</span> Cantidad
                </button>
                <button onClick={() => handleBulkAction('handling_time')} className="w-full text-left px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-amber-500 text-sm">schedule</span> Tiempo elaboración
                </button>
                <button onClick={() => handleBulkAction('shipping')} className="w-full text-left px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-cyan-500 text-sm">local_shipping</span> Servicio entrega
                </button>
                <hr className="border-slate-100 dark:border-slate-700" />
                <button onClick={() => handleBulkAction('delete')} className="w-full text-left px-4 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 text-sm flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm">delete</span> Eliminar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col min-h-[400px]">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800/50">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-12">
                    <input
                      onChange={toggleSelectAll}
                      checked={selectedIds.length === products.length && products.length > 0}
                      className="h-4 w-4 text-primary focus:ring-primary border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600" type="checkbox"
                    />
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-24">Imagen</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider min-w-[280px]">Publicación</th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">SKU / ASIN</th>
                  <th className="px-6 py-4 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Stock</th>
                  <th className="px-6 py-4 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Precio</th>
                  <th className="px-6 py-4 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Estado</th>
                  <th className="px-6 py-4 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Acciones</th>
                </tr>
              </thead>
              <tbody className="bg-surface-light dark:bg-surface-dark divide-y divide-gray-200 dark:divide-gray-700">
                {isLoading ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-16 text-center text-slate-400">
                      <span className="material-symbols-outlined animate-spin text-3xl block mx-auto mb-2">sync</span>
                      Cargando productos...
                    </td>
                  </tr>
                ) : products.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-16 text-center text-slate-400">
                      No se encontraron productos
                    </td>
                  </tr>
                ) : products.map(product => (
                  <tr key={product.id} className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group ${selectedIds.includes(product.id) ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <input
                        onChange={() => toggleSelectOne(product.id)}
                        checked={selectedIds.includes(product.id)}
                        className="h-4 w-4 text-primary focus:ring-primary border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600" type="checkbox"
                      />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div
                        className="h-14 w-14 rounded-lg bg-gray-100 dark:bg-gray-800 overflow-hidden border border-gray-200 dark:border-gray-700 cursor-zoom-in hover:opacity-80 transition-opacity"
                        onClick={() => setPreviewImage(product.imageUrl)}
                      >
                        <div className="w-full h-full bg-cover bg-center" style={{ backgroundImage: `url('${product.imageUrl}')` }}></div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-col">
                        <span className="text-sm font-bold text-gray-900 dark:text-white line-clamp-2">{product.title}</span>
                        {product.meliId ? (
                          <div className="flex items-center gap-1 mt-1">
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">MLM</span>
                            <a
                              href={`https://articulo.mercadolibre.com.mx/MLM-${product.meliId?.replace('MLM', '')}-_JM`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-500 hover:text-blue-700 font-mono underline decoration-blue-500/30 hover:decoration-blue-700 flex items-center gap-0.5"
                            >
                              {product.meliId}
                              <span className="material-symbols-outlined text-[10px]">open_in_new</span>
                            </a>
                          </div>
                        ) : (
                          <span className="text-xs text-amber-500 mt-1">No publicado</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <a
                        href={`https://www.${amazonDomainForCurrency(product.currency)}/dp/${product.asin || product.sku}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md bg-gray-100 dark:bg-gray-700 px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 ring-1 ring-inset ring-gray-500/10 font-mono hover:bg-orange-50 dark:hover:bg-orange-900/20 hover:text-orange-600 dark:hover:text-orange-400 transition-colors"
                        title="Ver en Amazon"
                      >
                        {product.sku}
                        <span className="material-symbols-outlined text-[12px]">open_in_new</span>
                      </a>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="flex flex-col items-end">
                        {product.stockProvider < product.stockMeli && (
                          <div className="flex items-center text-red-500 text-xs font-bold mb-1" title="Stock proveedor insuficiente">
                            <span className="material-symbols-outlined text-[14px] mr-1">warning</span>
                            Alert
                          </div>
                        )}
                        <span className="text-sm text-gray-900 dark:text-white">{product.stockMeli} ML</span>
                        <span className="text-xs text-gray-400">({product.stockProvider} Prov)</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      <div className="text-sm font-bold text-gray-900 dark:text-white">${product.priceMXN.toLocaleString()}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      {product.status === 'active' && (
                        <span className="inline-flex items-center rounded-full bg-green-50 dark:bg-green-900/30 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-400 ring-1 ring-inset ring-green-600/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-600 mr-1.5"></span>Activo
                        </span>
                      )}
                      {product.status === 'paused' && (
                        <span className="inline-flex items-center rounded-full bg-orange-50 dark:bg-orange-900/30 px-2.5 py-0.5 text-xs font-medium text-orange-700 dark:text-orange-400 ring-1 ring-inset ring-orange-600/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 mr-1.5"></span>Pausado
                        </span>
                      )}
                      {product.status === 'under_review' && (
                        <span className="inline-flex items-center rounded-full bg-blue-50 dark:bg-blue-900/30 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400 ring-1 ring-inset ring-blue-600/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5"></span>Revisando
                        </span>
                      )}
                      {(product.status === 'inactive' || product.status === 'closed') && (
                        <span className="inline-flex items-center rounded-full bg-red-50 dark:bg-red-900/30 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:text-red-400 ring-1 ring-inset ring-red-600/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 mr-1.5"></span>Inactiva
                        </span>
                      )}
                      {product.status === 'draft' && (
                        <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400 ring-1 ring-inset ring-gray-500/10">
                          Borrador
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right">
                      {product.status === 'draft' ? (
                        <button onClick={() => openWizard(product)} className="text-primary hover:text-primary-dark text-xs font-bold uppercase tracking-wide">
                          Publicar
                        </button>
                      ) : (
                        <button onClick={() => openEdit(product)} className="text-text-secondary-light hover:text-text-main-light text-sm p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                          <span className="material-symbols-outlined">edit</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <div className="text-sm text-gray-500 dark:text-gray-400">
                Mostrando <span className="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> a <span className="font-medium">{Math.min(currentPage * itemsPerPage, totalCount)}</span> de <span className="font-medium">{totalCount}</span> resultados
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                  disabled={currentPage === 1 || isLoading}
                  className="flex items-center justify-center rounded-lg h-9 px-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-white text-sm font-bold shadow-sm transition-all hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50">
                  <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                  Anterior
                </button>
                <div className="flex items-center px-4 text-sm font-bold text-slate-700 dark:text-white">
                  Página {currentPage} de {totalPages}
                </div>
                <button
                  onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                  disabled={currentPage === totalPages || isLoading}
                  className="flex items-center justify-center rounded-lg h-9 px-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-white text-sm font-bold shadow-sm transition-all hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50">
                  Siguiente
                  <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      {isEditOpen && selectedProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
              <h3 className="font-bold text-lg text-slate-900 dark:text-white">Editar Producto</h3>
              <button onClick={() => setIsEditOpen(false)}><span className="material-symbols-outlined text-slate-400">close</span></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-500 block mb-1">Título</label>
                <input
                  className="w-full rounded border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm"
                  value={editForm.title}
                  onChange={e => setEditForm({ ...editForm, title: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-500 block mb-1">Precio (MXN)</label>
                  <input
                    type="number"
                    className="w-full rounded border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm"
                    value={editForm.priceMXN}
                    onChange={e => setEditForm({ ...editForm, priceMXN: parseFloat(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500 block mb-1">Stock (ML)</label>
                  <input
                    type="number"
                    className="w-full rounded border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm"
                    value={editForm.stockMeli}
                    onChange={e => setEditForm({ ...editForm, stockMeli: parseFloat(e.target.value) })}
                  />
                </div>
              </div>
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-900/50 flex justify-end gap-2">
              <button onClick={() => setIsEditOpen(false)} className="px-4 py-2 text-slate-600 text-sm font-bold">Cancelar</button>
              <button onClick={saveEdit} className="px-4 py-2 bg-primary text-white rounded text-sm font-bold">Guardar</button>
            </div>
          </div>
        </div>
      )}

      {/* Massive Updates Modal */}
      {massiveModal.isOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-sm overflow-hidden animate-scale-up">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
              <h3 className="font-bold text-slate-900 dark:text-white capitalize">
                {massiveModal.action.replace('_', ' ')}
              </h3>
              <button onClick={() => setMassiveModal({ ...massiveModal, isOpen: false })}><span className="material-symbols-outlined text-slate-400">close</span></button>
            </div>
            <div className="p-6">
              <p className="text-xs text-slate-500 mb-4 font-bold uppercase tracking-wider">
                Aplicar a {selectedIds.length} productos seleccionados
              </p>

              {massiveModal.action === 'listing_type' && (
                <select
                  className="w-full h-10 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 px-3 text-sm"
                  value={massiveModal.value}
                  onChange={(e) => setMassiveModal({ ...massiveModal, value: e.target.value })}
                >
                  <option value="">Seleccionar tipo...</option>
                  <option value="gold_special">Clásica (Oro)</option>
                  <option value="gold_pro">Premium (Oro Pro)</option>
                </select>
              )}

              {massiveModal.action === 'shipping' && (
                <select
                  className="w-full h-10 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 px-3 text-sm"
                  value={massiveModal.value}
                  onChange={(e) => setMassiveModal({ ...massiveModal, value: e.target.value })}
                >
                  <option value="">Seleccionar entrega...</option>
                  <option value="me2">Mercado Envíos (Full/Colecta)</option>
                  <option value="custom">Entrega a acordar</option>
                </select>
              )}

              {(massiveModal.action === 'quantity' || massiveModal.action === 'handling_time') && (
                <input
                  type="number"
                  className="w-full h-10 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-900 px-3 text-sm"
                  placeholder={massiveModal.action === 'quantity' ? "Ej: 100" : "Días (Ej: 2)"}
                  value={massiveModal.value}
                  onChange={(e) => setMassiveModal({ ...massiveModal, value: e.target.value })}
                />
              )}
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-900/50 flex justify-end gap-2">
              <button
                onClick={() => setMassiveModal({ ...massiveModal, isOpen: false })}
                className="px-4 py-2 text-slate-600 dark:text-slate-400 text-sm font-bold"
              >
                Cancelar
              </button>
              <button
                onClick={applyMassiveUpdate}
                disabled={!massiveModal.value}
                className="px-6 py-2 bg-primary text-white rounded-lg text-sm font-bold shadow-sm hover:shadow active:scale-95 transition-all disabled:opacity-50"
              >
                Aplicar Cambio
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Preview Modal */}
      {previewImage && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in cursor-zoom-out"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh] overflow-hidden rounded-2xl shadow-2xl animate-scale-up">
            <img src={previewImage} className="max-w-full max-h-[90vh] object-contain" onClick={(e) => e.stopPropagation()} />
            <button
              className="absolute top-4 right-4 bg-white/20 hover:bg-white/40 text-white rounded-full p-2 transition-colors"
              onClick={() => setPreviewImage(null)}
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>
      )}

      {/* Publish Wizard Modal */}
      {isWizardOpen && selectedProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Publicar en Mercado Libre</h3>
              <button onClick={closeWizard} className="text-slate-400 hover:text-slate-600"><span className="material-symbols-outlined">close</span></button>
            </div>

            <div className="p-6 overflow-y-auto">
              {/* Stepper */}
              <div className="flex items-center mb-8">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${wizardStep >= 1 ? 'bg-primary text-white' : 'bg-slate-200 text-slate-500'}`}>1</div>
                <div className={`flex-1 h-1 mx-2 ${wizardStep >= 2 ? 'bg-primary' : 'bg-slate-200'}`}></div>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${wizardStep >= 2 ? 'bg-primary text-white' : 'bg-slate-200 text-slate-500'}`}>2</div>
                <div className={`flex-1 h-1 mx-2 ${wizardStep >= 3 ? 'bg-primary' : 'bg-slate-200'}`}></div>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${wizardStep >= 3 ? 'bg-primary text-white' : 'bg-slate-200 text-slate-500'}`}>3</div>
              </div>

              {wizardStep === 1 && (
                <div className="space-y-4">
                  <h4 className="font-bold text-lg">Confirmar Datos del Producto</h4>
                  <div className="flex gap-4 p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
                    <img src={selectedProduct.imageUrl} className="w-20 h-20 object-cover rounded" />
                    <div>
                      <p className="font-bold text-slate-900 dark:text-white">{selectedProduct.title}</p>
                      <p className="text-sm text-slate-500">ASIN: {selectedProduct.asin}</p>
                      <div className="mt-2 text-xs bg-slate-200 dark:bg-slate-700 inline-block px-2 py-1 rounded">Origen: Amazon USA</div>
                    </div>
                  </div>
                </div>
              )}

              {wizardStep === 2 && wizardCalculations && (
                <div className="space-y-6">
                  <h4 className="font-bold text-lg">Cálculo de Precios (Inteligente)</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                      <p className="text-xs text-slate-500 uppercase font-bold mb-1">Costo Origen</p>
                      <p className="text-lg font-mono text-slate-700 dark:text-slate-300">${selectedProduct.costUSD} USD</p>
                      <p className="text-xs text-slate-400 mt-1">~ ${wizardCalculations.costMXN.toFixed(2)} MXN</p>
                    </div>
                    <div className="p-4 border border-primary bg-blue-50 dark:bg-blue-900/10 rounded-lg shadow-sm">
                      <p className="text-xs text-primary uppercase font-bold mb-1">Precio Público Sugerido</p>
                      <p className="text-2xl font-black text-primary">${wizardCalculations.finalPrice.toFixed(2)} MXN</p>
                    </div>
                  </div>
                  <div className="bg-slate-100 dark:bg-slate-900 rounded p-4 text-sm space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Regla aplicada:</span>
                      <span className="font-bold text-slate-700 dark:text-white">Margen {wizardCalculations.marginUsed}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Tipo de cambio:</span>
                      <span className="font-bold text-slate-700 dark:text-white">Local Storage</span>
                    </div>
                  </div>
                </div>
              )}

              {wizardStep === 3 && (
                <div className="text-center py-8">
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
                    <span className="material-symbols-outlined text-green-600 text-3xl">rocket_launch</span>
                  </div>
                  <h4 className="font-bold text-xl mb-2 text-slate-900 dark:text-white">¡Listo para publicar!</h4>
                  <p className="text-slate-500 mb-6">El producto se creará en tu cuenta de Mercado Libre con los precios calculados.</p>
                  <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-700/30 p-4 rounded-lg text-sm text-yellow-800 dark:text-yellow-200 text-left">
                    <p className="font-bold flex items-center gap-2"><span className="material-symbols-outlined text-sm">warning</span> Nota:</p>
                    Recuerda que la sincronización de stock comenzará automáticamente en 5 minutos.
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-3 bg-slate-50 dark:bg-slate-800/50">
              {wizardStep > 1 && (
                <button onClick={() => setWizardStep(s => s - 1)} className="px-4 py-2 text-slate-600 font-bold hover:bg-slate-200 rounded-lg transition-colors">Atrás</button>
              )}
              {wizardStep < 3 ? (
                <button onClick={() => setWizardStep(s => s + 1)} className="px-4 py-2 bg-primary text-white font-bold rounded-lg hover:bg-primary-dark transition-colors shadow-sm">Siguiente</button>
              ) : (
                <button onClick={handlePublish} className="px-4 py-2 bg-green-600 text-white font-bold rounded-lg hover:bg-green-700 transition-colors shadow-sm">Publicar Ahora</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
