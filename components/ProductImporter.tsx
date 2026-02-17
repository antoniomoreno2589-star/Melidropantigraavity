import React, { useState } from 'react';
import { generateMockProductFromASIN } from '../services/mockService';
import { Product } from '../types';

interface SummaryResult {
  image: string;
  meliId: string;
  sku: string;
  title: string | null;
  price: number;
  result: string;
}

interface ProductImporterProps {
  onImport: (products: Product[]) => void;
}

export const ProductImporter: React.FC<ProductImporterProps> = ({ onImport }) => {
  const [inputText, setInputText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [categoryMode, setCategoryMode] = useState('auto');
  const [publicationType, setPublicationType] = useState('premium');
  const [showResults, setShowResults] = useState(false);

  // Mock results consistent with the user's screenshot
  const [results, setResults] = useState<SummaryResult[]>([
    {
      image: '',
      meliId: '6662null',
      sku: 'B07JPMCDM5',
      title: null,
      price: 0,
      result: 'Alcanzaste el límite de uso! Tienes -9 créditos de Prueba disponibles! Por favor recarga más créditos'
    }
  ]);

  const handleAction = (type: 'test' | 'publish') => {
    setIsProcessing(true);
    setTimeout(() => {
      const lines = inputText.split('\n').filter(line => line.trim().length > 0);
      const newProducts = lines.map(line => generateMockProductFromASIN(line.trim()));
      
      onImport(newProducts);
      setIsProcessing(false);
      setShowResults(true);
      if (type === 'publish') {
          alert(`Publicación finalizada. Revisa el resumen de resultados.`);
      }
    }, 1500);
  };

  const lineCount = inputText.split('\n').filter(line => line.trim().length > 0).length;

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-background-light dark:bg-background-dark">
      <div className="max-w-6xl mx-auto space-y-6 pb-20">
        
        {/* 1. Origen */}
        <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-800/50">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary text-white text-[10px] font-bold">1</span>
              Indique el origen de los productos:
            </h3>
          </div>
          <div className="p-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="cursor-pointer relative flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 transition-all">
                <input defaultChecked className="mt-1 h-4 w-4 text-primary focus:ring-primary cursor-pointer" name="source" type="radio"/>
                <div className="flex flex-col">
                  <span className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
                    <img alt="USA" className="h-3 w-auto" src="https://flagcdn.com/us.svg"/>
                    Amazon.com (USA)
                  </span>
                </div>
              </label>
              <label className="cursor-pointer relative flex items-start gap-3 rounded-lg border border-slate-200 dark:border-slate-700 p-3">
                <input className="mt-1 h-4 w-4 text-primary focus:ring-primary cursor-pointer" name="source" type="radio"/>
                <div className="flex flex-col">
                  <span className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
                    <img alt="MX" className="h-3 w-auto" src="https://flagcdn.com/mx.svg"/>
                    Amazon.com.mx (México)
                  </span>
                </div>
              </label>
            </div>
          </div>
        </div>

        {/* 2. Categoría */}
        <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-800/50">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary text-white text-[10px] font-bold">2</span>
              Indique la categoría del producto:
            </h3>
          </div>
          <div className="p-5">
            <div className="flex flex-col md:flex-row gap-6">
                <label className="flex items-center gap-2 cursor-pointer group">
                    <input 
                        type="radio" 
                        name="catMode" 
                        checked={categoryMode === 'phrase'} 
                        onChange={() => setCategoryMode('phrase')}
                        className="text-primary focus:ring-primary h-4 w-4"
                    />
                    <span className="text-sm text-slate-600 dark:text-slate-400 group-hover:text-primary transition-colors">Buscar categoría por frase</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer group">
                    <input 
                        type="radio" 
                        name="catMode" 
                        checked={categoryMode === 'keyword'} 
                        onChange={() => setCategoryMode('keyword')}
                        className="text-primary focus:ring-primary h-4 w-4"
                    />
                    <span className="text-sm text-slate-600 dark:text-slate-400 group-hover:text-primary transition-colors">Buscar categoría por palabra clave</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer group relative">
                    <input 
                        type="radio" 
                        name="catMode" 
                        checked={categoryMode === 'auto'} 
                        onChange={() => setCategoryMode('auto')}
                        className="text-primary focus:ring-primary h-4 w-4"
                    />
                    <span className="text-sm text-slate-600 dark:text-slate-400 group-hover:text-primary transition-colors">Determinar la categoría automáticamente</span>
                    <span className="absolute -top-4 -right-4 bg-blue-600 text-white text-[8px] font-black px-1 rounded">Nuevo</span>
                </label>
            </div>
          </div>
        </div>

        {/* 3. Tipo de Publicación */}
        <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-800/50">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary text-white text-[10px] font-bold">3</span>
              Tipo de publicación:
            </h3>
          </div>
          <div className="p-5">
            <select 
                value={publicationType}
                onChange={(e) => setPublicationType(e.target.value)}
                className="w-full rounded-lg border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm focus:ring-primary focus:border-primary"
            >
                <option value="classic">Publicación Clásica</option>
                <option value="premium">Publicación Premium</option>
            </select>
          </div>
        </div>

        {/* ASIN Input */}
        <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-800/50">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">ASINs de Amazon (Uno por línea)</h3>
          </div>
          <div className="p-5">
            <textarea 
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              className="w-full h-32 rounded-lg border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/50 p-3 text-sm font-mono focus:border-primary focus:ring-primary transition-all resize-none" 
              placeholder="B08N5KWB9H&#10;B07W55DDFB..."
            ></textarea>
          </div>
        </div>

        {/* Botones de Acción (ESTILO IMAGEN) */}
        <div className="flex flex-col sm:flex-row gap-0 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden shadow-sm">
            <button 
                onClick={() => handleAction('test')}
                disabled={isProcessing || lineCount === 0}
                className="flex-1 bg-[#004a77] hover:bg-[#003a5e] text-white font-bold py-4 text-sm transition-all disabled:opacity-50"
            >
                {isProcessing ? 'Procesando...' : 'Probar'}
            </button>
            <button 
                onClick={() => handleAction('publish')}
                disabled={isProcessing || lineCount === 0}
                className="flex-1 bg-[#00bee6] hover:bg-[#00a9cc] text-white font-bold py-4 text-sm transition-all disabled:opacity-50"
            >
                Publicar
            </button>
        </div>

        {/* SECCIÓN DE RESULTADOS CONSOLIDADO (ICONOS CORREGIDOS) */}
        {showResults && (
            <div className="space-y-6 animate-fade-in">
                <div className="bg-white dark:bg-slate-800 p-8 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
                    <h3 className="text-base font-black text-slate-900 dark:text-white mb-8 tracking-tight">Consolidado:</h3>
                    
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                        <div className="flex flex-col items-center text-center">
                            <div className="size-12 bg-green-100 dark:bg-green-900/20 text-green-600 rounded-xl mb-3 flex items-center justify-center">
                                <span className="material-symbols-outlined filled text-[24px]">check_box</span>
                            </div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Publicados</span>
                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">0</span>
                        </div>
                        <div className="flex flex-col items-center text-center">
                            <div className="size-12 bg-yellow-100 dark:bg-yellow-900/20 text-yellow-600 rounded-xl mb-3 flex items-center justify-center">
                                <span className="material-symbols-outlined text-[24px]">content_copy</span>
                            </div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Producto Duplicado</span>
                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">0</span>
                        </div>
                        <div className="flex flex-col items-center text-center">
                            <div className="size-12 bg-red-100 dark:bg-red-900/20 text-red-600 rounded-xl mb-3 flex items-center justify-center">
                                <span className="material-symbols-outlined text-[24px]">remove_circle</span>
                            </div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">En Lista Negra</span>
                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">0</span>
                        </div>
                        <div className="flex flex-col items-center text-center">
                            <div className="size-12 bg-blue-100 dark:bg-blue-900/20 text-blue-600 rounded-xl mb-3 flex items-center justify-center">
                                <span className="material-symbols-outlined text-[24px]">tag</span>
                            </div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Error por GTIN</span>
                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">0</span>
                        </div>
                        <div className="flex flex-col items-center text-center">
                            <div className="size-12 bg-pink-100 dark:bg-pink-900/20 text-pink-600 rounded-xl mb-3 flex items-center justify-center">
                                <span className="material-symbols-outlined text-[24px]">help</span>
                            </div>
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Otros Errores</span>
                            <span className="text-xl font-black text-slate-900 dark:text-white mt-1">1</span>
                        </div>
                    </div>
                </div>

                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                    <div className="p-4 border-b border-slate-100 dark:border-slate-700/50 bg-slate-50/30 dark:bg-slate-900/50">
                        <h3 className="text-base font-black text-slate-900 dark:text-white tracking-tight">Resumen Publicados:</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-[11px] font-medium">
                            <thead className="bg-slate-50/50 dark:bg-slate-900 text-slate-500 border-b border-slate-100 dark:border-slate-800">
                                <tr>
                                    <th className="px-4 py-3">Imagen</th>
                                    <th className="px-4 py-3">ID MercadoLibre</th>
                                    <th className="px-4 py-3">SKU</th>
                                    <th className="px-4 py-3">Título</th>
                                    <th className="px-4 py-3 text-right">Precio de Venta</th>
                                    <th className="px-4 py-3 text-center">Ver!</th>
                                    <th className="px-4 py-3">Resultado</th>
                                    <th className="px-4 py-3 text-right">Editar</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                                {results.map((res, idx) => (
                                    <tr key={idx} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/50 transition-colors">
                                        <td className="px-4 py-3">
                                            <div className="size-10 bg-slate-50 dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700 flex items-center justify-center">
                                                <span className="material-symbols-outlined text-yellow-500 text-xl">warning</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-slate-500 font-mono tracking-tighter">{res.meliId}</td>
                                        <td className="px-4 py-3 text-purple-600 dark:text-purple-400 font-bold font-mono tracking-tighter">{res.sku}</td>
                                        <td className="px-4 py-3 text-slate-400 italic">{res.title || 'null'}</td>
                                        <td className="px-4 py-3 text-right font-black text-slate-900 dark:text-white">{res.price}</td>
                                        <td className="px-4 py-3 text-center text-slate-400 font-bold">N/A</td>
                                        <td className="px-4 py-3 max-w-[350px]">
                                            <p className="text-slate-600 dark:text-slate-400 leading-tight">
                                                {res.result}
                                            </p>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <button className="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-700 text-slate-400 hover:text-primary transition-colors border border-slate-200 dark:border-slate-600">
                                                <span className="material-symbols-outlined text-sm">edit</span>
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="p-3 border-t border-slate-100 dark:border-slate-800 flex justify-between items-center text-[10px] text-slate-400 font-bold">
                        <div className="flex items-center gap-2">
                            <span>Filas por pagina</span>
                            <div className="flex items-center gap-1 text-slate-900 dark:text-white cursor-pointer hover:underline">
                                10 <span className="material-symbols-outlined text-[14px]">expand_more</span>
                            </div>
                            <span className="ml-4">1-1 de 1</span>
                        </div>
                        <div className="flex gap-4 items-center">
                            <button disabled className="opacity-20"><span className="material-symbols-outlined text-sm">first_page</span></button>
                            <button disabled className="opacity-20"><span className="material-symbols-outlined text-sm">chevron_left</span></button>
                            <button disabled className="opacity-20"><span className="material-symbols-outlined text-sm">chevron_right</span></button>
                            <button disabled className="opacity-20"><span className="material-symbols-outlined text-sm">last_page</span></button>
                        </div>
                    </div>
                </div>
            </div>
        )}
      </div>
    </div>
  );
};