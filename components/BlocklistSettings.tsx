import React, { useEffect, useState } from 'react';
import { publishBlocklist, BlocklistEntry } from '../services/publishBlocklist';

const SOURCE_LABEL: Record<string, string> = {
    single_seller_scan: 'Vendedor único en Amazon',
    ml_forbidden: 'Prohibida por Mercado Libre',
    manual: 'Agregada a mano',
};

// Settings section for publish_blocklist: brands and ASINs the importer drops
// and meliService refuses to publish. Matching is by exact brand, so it lives
// apart from the "Filtro Global" words searched in titles.
export const BlocklistSettings: React.FC = () => {
    const [counts, setCounts] = useState<{ brands: number; asins: number } | null>(null);
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<BlocklistEntry[]>([]);
    const [toAdd, setToAdd] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState('');

    const refresh = async () => {
        try {
            setCounts(await publishBlocklist.counts());
            setError('');
        } catch (e: any) {
            setError(e.message);
        }
    };
    useEffect(() => { refresh(); }, []);

    // Re-runs after every add/remove (counts changes) so the list stays current.
    useEffect(() => {
        if (query.trim().length < 2) { setResults([]); return; }
        const timer = setTimeout(async () => {
            try { setResults(await publishBlocklist.search(query)); }
            catch (e: any) { setError(e.message); }
        }, 250);
        return () => clearTimeout(timer);
    }, [query, counts]);

    const handleAdd = async () => {
        setBusy(true);
        setMsg('');
        try {
            const { added, skippedGeneric } = await publishBlocklist.addBrands(toAdd.split('\n'));
            setToAdd('');
            setMsg(`✅ ${added} marca(s) bloqueada(s).` +
                (skippedGeneric.length ? ` No se bloquearon por ser genéricas: ${skippedGeneric.join(', ')}.` : ''));
            await refresh();
        } catch (e: any) {
            setMsg(`❌ ${e.message}`);
        } finally {
            setBusy(false);
        }
    };

    const handleRemove = async (entry: BlocklistEntry) => {
        const what = entry.kind === 'brand' ? `la marca "${entry.display ?? entry.value}"` : `el ASIN ${entry.value}`;
        if (!confirm(`¿Quitar ${what} de la lista de bloqueo? Se podrá volver a importar y publicar.`)) return;
        try {
            await publishBlocklist.remove(entry);
            await refresh();
        } catch (e: any) {
            setMsg(`❌ ${e.message}`);
        }
    };

    return (
        <section className="flex flex-col lg:col-span-2 bg-surface-light dark:bg-surface-dark rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-red-100 text-red-600">
                    <span className="material-symbols-outlined">gpp_bad</span>
                </div>
                <div>
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white uppercase tracking-tighter">Marcas bloqueadas</h2>
                    <p className="text-xs text-slate-500">Riesgo de denuncia: el importador las descarta antes de usar IA y nunca se publican.</p>
                </div>
            </div>
            <div className="p-6 space-y-5">
                {error
                    ? <p className="text-sm font-bold text-red-500">{error}</p>
                    : <p className="text-sm text-slate-600 dark:text-slate-300">
                        {counts
                            ? <><span className="font-black">{counts.brands.toLocaleString()}</span> marcas y <span className="font-black">{counts.asins.toLocaleString()}</span> ASINs bloqueados.</>
                            : 'Cargando…'}
                      </p>}

                <div className="flex flex-col gap-2">
                    <label className="text-xs font-black text-slate-500 uppercase">Buscar marca o ASIN</label>
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Ej: Melissa & Doug o B07179YRBW"
                        className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-4 py-2 text-sm focus:ring-primary"
                    />
                    {results.length > 0 && (
                        <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl max-h-64 overflow-y-auto">
                            {results.map(e => (
                                <li key={`${e.kind}:${e.value}`} className="px-4 py-2 flex items-center gap-3 text-sm">
                                    <span className={`font-bold ${e.kind === 'asin' ? 'font-mono' : ''} text-slate-800 dark:text-slate-100`}>{e.display ?? e.value}</span>
                                    <span className="text-[10px] font-bold uppercase text-slate-400">{e.kind === 'brand' ? 'Marca' : 'ASIN'} · {SOURCE_LABEL[e.source] ?? e.source}</span>
                                    <button onClick={() => handleRemove(e)} className="ml-auto text-xs font-bold text-red-500 hover:text-red-700">Quitar</button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {query.trim().length >= 2 && results.length === 0 && !error && (
                        <p className="text-xs text-slate-400">No está en la lista.</p>
                    )}
                </div>

                <div className="flex flex-col gap-2">
                    <label className="text-xs font-black text-slate-500 uppercase">Bloquear marcas (una por línea)</label>
                    <textarea
                        value={toAdd}
                        onChange={e => setToAdd(e.target.value)}
                        className="w-full h-24 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl px-4 py-3 text-sm font-mono focus:ring-primary resize-none"
                        placeholder={'Marca que te denunció\nOtra marca'}
                    />
                    <button
                        onClick={handleAdd}
                        disabled={busy || !toAdd.trim()}
                        className="self-start bg-red-600 hover:bg-red-700 text-white font-black py-2 px-4 rounded-xl text-sm disabled:opacity-50"
                    >
                        {busy ? 'Guardando…' : 'Bloquear'}
                    </button>
                    {msg && <p className={`text-xs font-bold ${msg.startsWith('✅') ? 'text-green-600' : 'text-red-500'}`}>{msg}</p>}
                </div>
            </div>
        </section>
    );
};
