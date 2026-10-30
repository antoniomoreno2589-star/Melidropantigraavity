import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Product } from '../types';
import { api } from '../services/api';
import { meliService } from '../services/meliService';
import { supabase } from '../services/supabase';
import { REIMPORT_ASINS_KEY, sanitizePublishAttributes } from './AmazonImporter/useAmazonImporter';
import { amazonDomainForCurrency } from '../services/amazonService';

interface TestProduct extends Product {
    isPublishedToReal: boolean;
    creationDate: string; // Format YYYY-MM-DD for easier filtering
    updatedDate: string;  // Same format, backed by test_products.updated_at
    publishedToRealDate: string | null; // Same format, backed by published_to_real_at — null until isPublishedToReal
    subStatus: string[];  // ML's real sub_status array (e.g. ["deleted"] when ML itself removed the listing)
    prepTime: string;
    category: string;
    hasPayload: boolean;  // a saved publish_payload exists (the list leaves the payload itself out)
    missingAttributes: any[] | null; // required attributes the last publish couldn't fill, for the seller to complete
}

// Split into two independent filters (used to be one SandboxStatusFilter
// union covering both) — confirmed live that crammed published/not_published
// into the same single-select as the ML status pills, so picking "Activa"
// silently cleared "No publicados" and vice versa, with no way to combine
// them despite that being the exact combination sellers want most often.
type SandboxStatusFilter = 'all' | 'active' | 'paused' | 'under_review' | 'inactive' | 'deleted_by_ml' | 'unpublished';
type PublishedFilter = 'all' | 'published' | 'not_published';

// ML represents "removed by Mercado Libre" as status=closed plus a "deleted"
// sub_status entry — the same shape a seller-initiated close/delete can leave,
// so this is best-effort (Melidrop's own deleteItem rows vanish from this
// table immediately on delete, so they can't be mistaken for this bucket).
const isDeletedByMl = (p: TestProduct): boolean =>
    p.status === 'closed' && Array.isArray(p.subStatus) && p.subStatus.includes('deleted');

// A row with no meli_id never became a listing anywhere: the sandbox test
// publish failed, and the importer kept the row (with its production payload)
// so it can still be published for real. Its stored status is just the
// importer's 'active' fallback — confirmed live that 454 such rows were being
// counted and shown as active listings that don't exist on Mercado Libre.
const isUnpublished = (p: TestProduct): boolean => !p.meliId;

// What actually stopped a publish: ML's errors without its warnings ("User has
// not mode me1", "… ignored because it is not modifiable"), which never block
// one — confirmed live they made up most of each error line, burying the reason.
const blockingCauses = (cause: any): any[] => (Array.isArray(cause) ? cause : []).filter((c: any) => c?.type !== 'warning');

// Selected products with no saved listing data can't be tested or published.
// Confirmed live: 179 of the 471 "Sin publicar" — 176 whose original listing
// no longer existed on Mercado Libre when the catalog was handed over, 3 the
// importer left empty — were skipped without a word, so "Probar en Sandbox"
// asked about 292. Said the same way wherever a bulk action skips them.
const noDataNote = (n: number): string => n === 0 ? '' : n === 1
    ? '\n\n1 de los seleccionados no tiene datos para publicar y se omite: usa "Reimportar desde Amazon" para rehacerlo.'
    : `\n\n${n} de los seleccionados no tienen datos para publicar y se omiten: usa "Reimportar desde Amazon" para rehacerlos.`;

// A bulk run stops at the account's daily limit (result.quotaReached): every
// product after would get the same refusal. The untried ones stay selected.
const quotaStopReason = (result: any, untried: number): string =>
    `${result.error} Se detuvo aquí: ${untried === 1 ? 'el que falta quedó seleccionado' : `los ${untried.toLocaleString('es-MX')} que faltan quedaron seleccionados`} para que sigas mañana.`;

// What a publish learned about a product, saved with it: what it had to fix
// (services/attributeRepair: attributes completed or dropped, a title cut to
// the length ML allows), so later tries — the test or "Publicar Real" — start
// from it instead of repeating the repair; and the required attributes it
// couldn't fill, for the seller to complete by hand (cleared once a try needs
// nothing more). Returns what the list on screen should show now.
async function saveOutcome(product: TestProduct, payload: any, result: any): Promise<{ repaired: boolean; missingAttributes: any[] | null; title?: string }> {
    // Refused for the account's daily limit before ML looked at the product:
    // nothing was learned, so what's saved (e.g. its missing data) stays.
    if (result?.quotaReached) return { repaired: false, missingAttributes: product.missingAttributes ?? null };
    const repaired = !!(result?.repairedAttributes || result?.repairedTitle);
    const missingAttributes = result?.error && Array.isArray(result?.missingAttributes) && result.missingAttributes.length
        ? result.missingAttributes : null;
    const updates: any = {};
    if (repaired) {
        updates.publish_payload = {
            ...payload,
            ...(result.repairedAttributes ? { attributes: result.repairedAttributes } : {}),
            ...(result.repairedTitle ? { title: result.repairedTitle } : {}),
        };
        if (result.repairedTitle) updates.title = result.repairedTitle;
    }
    if (JSON.stringify(missingAttributes) !== JSON.stringify(product.missingAttributes ?? null)) updates.missing_attributes = missingAttributes;
    if (Object.keys(updates).length > 0) {
        try {
            await api.testProducts.update(product.id, updates);
        } catch (e) {
            console.warn('[Melidrop] Could not save the publish outcome:', e);
        }
    }
    return { repaired, missingAttributes, ...(result?.repairedTitle ? { title: result.repairedTitle } : {}) };
}

// The required attributes a publish couldn't fill (product.missingAttributes,
// from attributeRepair), asked the way Mercado Libre takes each: one of the
// category's own values, a number with one of its units, or text. Saved into
// the product's payload, so the next "Probar en Sandbox" or "Publicar" sends
// them; the ones left blank stay listed.
function MissingDataModal({ product, onClose, onSaved }: {
    product: TestProduct;
    onClose: () => void;
    onSaved: (remaining: any[] | null) => void;
}) {
    const defs: any[] = product.missingAttributes ?? [];
    const [values, setValues] = useState<Record<string, { text: string; unit: string }>>(() =>
        Object.fromEntries(defs.map(d => [d.id, { text: '', unit: d.default_unit ?? d.allowed_units?.[0]?.id ?? '' }])));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const setField = (id: string, patch: Partial<{ text: string; unit: string }>) =>
        setValues(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    const closedList = (d: any) => Array.isArray(d.values) && d.values.length > 0 && (d.value_type === 'list' || d.value_type === 'boolean');

    // The attribute as ML takes it — null while the field is blank or not a valid number.
    const toAttribute = (d: any): any | null => {
        const field = values[d.id];
        const text = (field?.text ?? '').trim();
        if (!text) return null;
        if (closedList(d)) {
            const option = d.values.find((o: any) => String(o.id) === text);
            return option ? { id: d.id, value_id: String(option.id), value_name: option.name } : null;
        }
        if (d.value_type === 'number_unit' || d.value_type === 'number') {
            const n = Number(text.replace(',', '.'));
            if (!(n > 0)) return null;
            // Package dimensions only take whole cm and g (ML error 5402).
            const value = /^SELLER_PACKAGE_/.test(d.id) ? Math.ceil(n) : n;
            if (d.value_type === 'number') return { id: d.id, value_name: String(value) };
            const unit = d.allowed_units?.find((u: any) => u.id === field.unit) ?? d.allowed_units?.[0];
            return { id: d.id, value_name: unit ? `${value} ${unit.name}` : String(value) };
        }
        return { id: d.id, value_name: text.slice(0, 255) };
    };

    const save = async () => {
        const filled = defs.map(toAttribute).filter(Boolean);
        if (filled.length === 0) { setError('Escribe al menos un dato.'); return; }
        setSaving(true);
        setError(null);
        try {
            const payload = await api.testProducts.getPayload(product.id);
            if (!payload) throw new Error('No se encontraron los datos de este producto.');
            const ids = new Set(filled.map((a: any) => a.id));
            const attributes = [...(payload.attributes ?? []).filter((a: any) => !ids.has(a.id)), ...filled];
            const remaining = defs.filter(d => !ids.has(d.id));
            await api.testProducts.update(product.id, {
                publish_payload: { ...payload, attributes },
                missing_attributes: remaining.length ? remaining : null,
            });
            onSaved(remaining.length ? remaining : null);
        } catch (e: any) {
            setError(e?.message || String(e));
        } finally {
            setSaving(false);
        }
    };

    const inputCls = 'w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary';

    return (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[85vh]" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-start gap-3">
                    <div>
                        <h3 className="font-bold text-slate-900 dark:text-white">Completar datos</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{product.title}</p>
                    </div>
                    <button onClick={onClose}>
                        <span className="material-symbols-outlined text-slate-400">close</span>
                    </button>
                </div>
                <div className="p-6 space-y-4 overflow-y-auto">
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        Mercado Libre pide estos datos y no están ni en Amazon ni en el título. Escríbelos como vienen en el
                        producto (puedes revisarlo en Amazon con el ASIN {product.asin}). Los que dejes en blanco seguirán pendientes.
                    </p>
                    {defs.map(d => (
                        <label key={d.id} className="block">
                            <span className="text-xs font-bold text-slate-700 dark:text-slate-300">{d.name}</span>
                            <div className="mt-1 flex gap-2">
                                {closedList(d) ? (
                                    <select className={inputCls} value={values[d.id]?.text ?? ''} onChange={e => setField(d.id, { text: e.target.value })}>
                                        <option value="">Elige…</option>
                                        {d.values.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
                                    </select>
                                ) : d.value_type === 'number_unit' || d.value_type === 'number' ? (
                                    <>
                                        <input
                                            type="number" min="0" step="any" inputMode="decimal" className={inputCls}
                                            value={values[d.id]?.text ?? ''} onChange={e => setField(d.id, { text: e.target.value })}
                                        />
                                        {d.value_type === 'number_unit' && d.allowed_units?.length > 0 && (
                                            <select className={`${inputCls} w-28`} value={values[d.id]?.unit ?? ''} onChange={e => setField(d.id, { unit: e.target.value })}>
                                                {d.allowed_units.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
                                            </select>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <input
                                            type="text" maxLength={255} className={inputCls} list={`suggest-${d.id}`}
                                            value={values[d.id]?.text ?? ''} onChange={e => setField(d.id, { text: e.target.value })}
                                        />
                                        {Array.isArray(d.values) && d.values.length > 0 && (
                                            <datalist id={`suggest-${d.id}`}>
                                                {d.values.map((o: any) => <option key={o.id} value={o.name} />)}
                                            </datalist>
                                        )}
                                    </>
                                )}
                            </div>
                        </label>
                    ))}
                    {error && <p className="text-xs font-bold text-red-500">{error}</p>}
                </div>
                <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-200 dark:border-slate-700 flex justify-end gap-2">
                    <button onClick={onClose} className="px-4 py-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-sm font-bold transition-all">
                        Cancelar
                    </button>
                    <button
                        onClick={save}
                        disabled={saving}
                        className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-bold shadow-sm hover:shadow active:scale-95 transition-all disabled:opacity-50"
                    >
                        {saving ? 'Guardando…' : 'Guardar'}
                    </button>
                </div>
            </div>
        </div>
    );
}

export const TestProductsPage = () => {
    const [activeTab, setActiveTab] = useState<'config' | 'products'>('products');
    const [searchField, setSearchField] = useState<'title' | 'asin' | 'sku' | 'brand'>('title');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    // Live progress for handleBulkPublish — a batch can be thousands of items
    // (2000+ per the account this was built for), so this tracks a running
    // counter/error list instead of the previous silent for-loop + one final
    // alert() at the end with no feedback while it ran.
    const [bulkPublishRun, setBulkPublishRun] = useState<{
        total: number;
        done: number;
        successCount: number;
        errors: { title: string; message: string; id?: string }[];
        finished: boolean;
        cancelled: boolean;
        sandbox?: boolean; // a "Probar en Sandbox" run (test account), not a real publish
        repaired?: number; // products whose attributes the publish completed (attributeRepair)
        stopReason?: string; // why the run stopped before the end (the account's daily limit)
    } | null>(null);
    const bulkPublishCancelRef = useRef(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);
    const [filterStatus, setFilterStatus] = useState<SandboxStatusFilter>('all');
    const [filterPublished, setFilterPublished] = useState<PublishedFilter>('all');
    // Only products with required data to complete by hand, and the one whose
    // form is open (see MissingDataModal).
    const [filterMissing, setFilterMissing] = useState(false);
    const [completing, setCompleting] = useState<TestProduct | null>(null);
    const [dateFilterType, setDateFilterType] = useState<'created' | 'updated' | 'published'>('created');
    // Range instead of a single exact-match date — "products published between
    // the 5th and the 12th" needed two bounds, not one day at a time.
    const [filterDateFrom, setFilterDateFrom] = useState<string>('');
    const [filterDateTo, setFilterDateTo] = useState<string>('');
    const [showFilters, setShowFilters] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const PAGE_SIZE = 20;
    const [previewImage, setPreviewImage] = useState<{ url: string; title: string } | null>(null);

    const [testProducts, setTestProducts] = useState<TestProduct[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    // A catalog can be tens of thousands of rows: show how far the load got,
    // and say when it failed — the table used to show "No se encontraron
    // productos" both while loading and after a failed load.
    const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number | null } | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [testUser, setTestUser] = useState<any>(null);
    const [isCreatingUser, setIsCreatingUser] = useState(false);

    const loadProducts = async () => {
        setIsLoading(true);
        setLoadError(null);
        try {
            setTestProducts(await api.testProducts.list((loaded, total) => setLoadProgress({ loaded, total })));
        } catch (err: any) {
            console.error("Error fetching test products:", err);
            setLoadError(err?.message || String(err));
        } finally {
            setIsLoading(false);
            setLoadProgress(null);
        }
    };

    useEffect(() => {
        loadProducts();

        // Loaded separately: this used to wait for the product list, so a list
        // that failed to load also left the test user missing.
        const fetchTestUser = async () => {
            try {
                const { data: { user: authUser } } = await supabase.auth.getUser();
                if (authUser) {
                    const { data: userData } = await supabase.from('user_connections').select('meli_test_user').eq('user_id', authUser.id).maybeSingle();
                    if (userData?.meli_test_user) setTestUser(userData.meli_test_user);
                }
            } catch (err) {
                console.error("Error fetching test user:", err);
            }
        };
        fetchTestUser();
    }, []);

    const handleCreateTestUser = async () => {
        setIsCreatingUser(true);
        try {
            const user = await meliService.createTestUser('MLM');

            // Save to Supabase with proper conflict resolution
            const { data: { user: authUser } } = await supabase.auth.getUser();
            if (authUser) {
                // ML tokens last 6 hours; record expiry so auto-refresh knows when to renew
                const userWithExpiry = {
                    ...user,
                    token_expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString()
                };
                const { error } = await supabase
                    .from('user_connections')
                    .upsert({ user_id: authUser.id, meli_test_user: userWithExpiry }, { onConflict: 'user_id' });
                if (error) {
                    console.error("Upsert error:", error);
                    throw error;
                }

                // Verify the save by fetching it back
                await new Promise(r => setTimeout(r, 100));
                const { data: verified } = await supabase
                    .from('user_connections')
                    .select('meli_test_user')
                    .eq('user_id', authUser.id)
                    .maybeSingle();

                if (verified?.meli_test_user) {
                    setTestUser(verified.meli_test_user);
                } else {
                    setTestUser(user);
                }
            } else {
                setTestUser(user);
            }
            alert('✅ Usuario test creado. Ya puedes probar productos en el importador.');
        } catch (err: any) {
            console.error("Error creating test user:", err);
            alert("Error: " + err.message);
        } finally {
            setIsCreatingUser(false);
        }
    };

    // Derived State: Filtered Products logic
    const filteredProducts = useMemo(() => {
        const q = searchQuery.toLowerCase();
        return testProducts.filter(p => {
            if (filterMissing && !p.missingAttributes?.length) return false;

            // 1. Search filter, scoped to whichever field the dropdown has selected
            const matchesSearch = !q ? true
                : searchField === 'asin' ? p.asin.toLowerCase().includes(q)
                : searchField === 'sku' ? p.sku.toLowerCase().includes(q)
                : searchField === 'brand' ? (p.brand ?? '').toLowerCase().includes(q)
                : p.title.toLowerCase().includes(q);

            // 2. ML status filter (the pill row)
            let matchesStatus = true;
            if (filterStatus === 'unpublished') matchesStatus = isUnpublished(p);
            else if (filterStatus !== 'all' && isUnpublished(p)) matchesStatus = false;
            else if (filterStatus === 'active') matchesStatus = p.status === 'active';
            else if (filterStatus === 'paused') matchesStatus = p.status === 'paused';
            else if (filterStatus === 'under_review') matchesStatus = ['under_review', 'not_yet_active', 'payment_required'].includes(p.status);
            else if (filterStatus === 'inactive') matchesStatus = ['inactive', 'closed'].includes(p.status) && !isDeletedByMl(p);
            else if (filterStatus === 'deleted_by_ml') matchesStatus = isDeletedByMl(p);

            // 3. Published-to-real filter (the funnel dropdown) — independent of
            // the ML status filter above, so e.g. "Activa" + "No publicados" can
            // be combined instead of one silently overriding the other.
            let matchesPublished = true;
            if (filterPublished === 'published') matchesPublished = p.isPublishedToReal;
            else if (filterPublished === 'not_published') matchesPublished = !p.isPublishedToReal;

            // 4. Date filter — against creation, last-update, or real-publish date
            // (per the dropdown), as a range instead of one exact day. A product
            // that's never been published for real has no publishedToRealDate —
            // that correctly excludes it whenever this filter type has a bound set,
            // same as it would from a real "published between X and Y" search.
            const dateValue = dateFilterType === 'updated' ? p.updatedDate
                : dateFilterType === 'published' ? p.publishedToRealDate
                : p.creationDate;
            const matchesDate = (!filterDateFrom && !filterDateTo) ? true
                : !dateValue ? false
                : (!filterDateFrom || dateValue >= filterDateFrom) && (!filterDateTo || dateValue <= filterDateTo);

            return matchesSearch && matchesStatus && matchesPublished && matchesDate;
        });
    }, [testProducts, searchField, searchQuery, filterStatus, filterPublished, filterMissing, dateFilterType, filterDateFrom, filterDateTo]);

    // Counts for the status pill row — always over the full catalog, not the
    // currently filtered/searched subset, same as ML's own seller panel.
    const statusCounts = useMemo(() => {
        const counts = { active: 0, paused: 0, review: 0, inactive: 0, deletedByMl: 0, unpublished: 0 };
        for (const p of testProducts) {
            if (isUnpublished(p)) { counts.unpublished++; continue; }
            if (isDeletedByMl(p)) { counts.deletedByMl++; continue; }
            if (p.status === 'active') counts.active++;
            else if (p.status === 'paused') counts.paused++;
            else if (['under_review', 'not_yet_active', 'payment_required'].includes(p.status)) counts.review++;
            else if (['inactive', 'closed'].includes(p.status)) counts.inactive++;
        }
        return counts;
    }, [testProducts]);
    const missingCount = useMemo(() => testProducts.filter(p => p.missingAttributes?.length).length, [testProducts]);
    const productById = useMemo(() => new Map(testProducts.map(p => [p.id, p])), [testProducts]);
    // The selected products with no saved listing data (see noDataNote).
    const selectedWithoutData = useMemo(() => {
        const selected = new Set(selectedIds);
        return testProducts.filter(p => selected.has(p.id) && !p.hasPayload);
    }, [testProducts, selectedIds]);

    // Their ASINs go to the Amazon Importer's step 2, which rebuilds the
    // listing data from Amazon and saves it onto these same rows.
    const navigate = useNavigate();
    const reimportFromAmazon = () => {
        const asins = [...new Set(selectedWithoutData.map(p => String(p.asin ?? '').trim().toUpperCase()).filter(a => /^[A-Z0-9]{10}$/.test(a)))];
        if (asins.length === 0) {
            alert('Ninguno de los seleccionados tiene un ASIN para volver a importar.');
            return;
        }
        try { sessionStorage.setItem(REIMPORT_ASINS_KEY, asins.join('\n')); } catch { /* the importer just starts empty */ }
        navigate('/importar');
    };

    // Jumping back to page 1 on a new search/filter avoids landing on a page
    // that no longer has any rows once the filtered set shrinks.
    useEffect(() => {
        setCurrentPage(1);
    }, [searchField, searchQuery, filterStatus, filterPublished, filterMissing, dateFilterType, filterDateFrom, filterDateTo]);

    const totalPages = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));

    // Deleting the last item(s) on a page can leave currentPage past the new
    // last page — pull it back instead of showing an empty table with a
    // non-empty filtered count.
    useEffect(() => {
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [totalPages, currentPage]);

    const paginatedProducts = useMemo(() => {
        const start = (currentPage - 1) * PAGE_SIZE;
        return filteredProducts.slice(start, start + PAGE_SIZE);
    }, [filteredProducts, currentPage]);

    // Handlers
    const handleSync = async () => {
        setIsSyncing(true);
        try {
            // This used to only re-read whatever was already in Supabase — a
            // product published as 'under_review' would still say that forever,
            // even after ML actually reviewed it and flipped it to active/paused.
            // Actually ask ML for each item's current status and persist any change.
            const current = await api.testProducts.list();
            const withMeliId = current.filter(p => p.meliId);
            setSyncProgress({ done: 0, total: withMeliId.length });

            // Confirmed slow live (3,581 test products ≈ 20-30 min, no progress
            // shown): this used to make one ML request per product, and re-read
            // the test-user token (an auth call plus a DB read) for every one of
            // them. Now: the token once, and ML's 20-ids-per-request multi-get.
            const testToken = (await meliService.autoRefreshTestUserToken()) ?? undefined;
            // Whose listings these really are — a listing owned by another account
            // can't show up in the test user's own Mercado Libre panel.
            const testUserId = testToken ? (await meliService.getUserInfoByToken(testToken))?.id : undefined;
            const BATCH = 20;
            const batches: { items: TestProduct[]; token?: string; sandbox: boolean }[] = [];
            const sandboxItems = withMeliId.filter(p => !p.isPublishedToReal);
            const realItems = withMeliId.filter(p => p.isPublishedToReal);
            for (let i = 0; i < sandboxItems.length; i += BATCH) batches.push({ items: sandboxItems.slice(i, i + BATCH), token: testToken, sandbox: true });
            for (let i = 0; i < realItems.length; i += BATCH) batches.push({ items: realItems.slice(i, i + BATCH), sandbox: false });

            // What ML actually answered for the test account's listings — this
            // used to end with a bare "completada" even when every request failed.
            const mlStatusCounts: Record<string, number> = {};
            let notFound = 0;
            let otherAccount = 0;
            let failed = 0;

            const CONCURRENCY = 4;
            let nextBatch = 0;
            let done = 0;
            const worker = async () => {
                while (nextBatch < batches.length) {
                    const { items, token, sandbox } = batches[nextBatch++];
                    try {
                        const results = await meliService.getItemsStatus(items.map(p => p.meliId!), token);
                        await Promise.all(items.map(async (p, idx) => {
                            const item = results[idx];
                            if (!item?.status) { failed++; return; }
                            if (sandbox) {
                                if (item.error || typeof item.status === 'number') notFound++;
                                else {
                                    mlStatusCounts[item.status] = (mlStatusCounts[item.status] ?? 0) + 1;
                                    if (testUserId && item.seller_id && String(item.seller_id) !== String(testUserId)) otherAccount++;
                                }
                            }
                            const subStatus = Array.isArray(item.sub_status) ? item.sub_status : [];
                            const changed = item.status !== p.status
                                || JSON.stringify(subStatus) !== JSON.stringify(p.subStatus || []);
                            if (changed) {
                                await api.testProducts.update(p.id, { status: item.status, sub_status: subStatus });
                            }
                        }));
                    } catch (e) {
                        failed += items.length;
                        console.error(`[Melidrop] Failed to refresh status for ${items.length} test products:`, e);
                    }
                    done += items.length;
                    setSyncProgress({ done, total: withMeliId.length });
                }
            };
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));

            const data = await api.testProducts.list();
            setTestProducts(data);

            const statusLabels: Record<string, string> = {
                active: 'Activas', paused: 'Pausadas', under_review: 'En revisión',
                not_yet_active: 'En revisión (aún no activas)', payment_required: 'Pago pendiente',
                closed: 'Cerradas', inactive: 'Inactivas',
            };
            const reported = Object.values(mlStatusCounts).reduce((a, b) => a + b, 0);
            const lines = [
                'Sincronización completada.',
                '',
                `Mercado Libre reporta ${reported.toLocaleString()} publicaciones de prueba:`,
                ...Object.entries(mlStatusCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([status, n]) => `• ${statusLabels[status] ?? status}: ${n.toLocaleString()}`),
            ];
            if (otherAccount > 0) lines.push('', `⚠️ ${otherAccount.toLocaleString()} de ellas pertenecen a OTRA cuenta, no a tu usuario de prueba (por eso no aparecen en su panel de Mercado Libre).`);
            if (!testUserId) lines.push('', 'No se pudo verificar a qué cuenta pertenece cada publicación (no hay acceso del usuario de prueba).');
            if (notFound > 0) lines.push('', `${notFound.toLocaleString()} ya no existen en Mercado Libre.`);
            if (failed > 0) lines.push('', `⚠️ ${failed.toLocaleString()} no se pudieron consultar. Vuelve a sincronizar.`);
            alert(lines.join('\n'));
        } catch (err) {
            console.error("Sync error:", err);
        } finally {
            setIsSyncing(false);
            setSyncProgress(null);
        }
    };

    // Scoped to the current page, not every filtered row — with pagination in
    // place, checking the header box while only 20 rows are on screen should
    // only ever select those 20, not silently pull in off-screen pages too.
    const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.checked) {
            setSelectedIds(prev => Array.from(new Set([...prev, ...paginatedProducts.map(p => p.id)])));
        } else {
            const pageIds = new Set(paginatedProducts.map(p => p.id));
            setSelectedIds(prev => prev.filter(id => !pageIds.has(id)));
        }
    };

    const handleToggleSelect = (id: string) => {
        setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    };

    // useAmazonImporter's own real-publish path upserts into `products` with
    // in_updater=true and fires amazon-ml-updater right after a successful
    // publish — this page's real-publish (handlePublishToReal/handleBulkPublish)
    // never did either. Confirmed live: a product published for real from here
    // (B0BTK34CK9, meli_id MLM3299954079) had no `products` row at all, so it
    // was invisible to the background job that fixes shipping.handling_time
    // (and would stay invisible to every future price/stock/shipping sync,
    // forever, not just the one-time handling_time fix). Best-effort: the
    // publish itself already succeeded by the time this runs, so a failure
    // here is only logged, never surfaced as a publish error.
    const trackPublishedProduct = async (product: TestProduct, result: any, itemPayload: any, descriptionText?: string) => {
        if (!result.id) return;
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;
            const { error: sbErr } = await supabase.from('products').upsert({
                user_id:          user.id,
                meli_id:          result.id,
                asin:             product.asin,
                title:            result.title || itemPayload.title || product.title,
                sku:              product.asin,
                price_mxn:        itemPayload.price,
                stock_meli:       itemPayload.available_quantity,
                status:           'active',
                image_url:        product.imageUrl ?? null,
                currency:         itemPayload.currency_id === 'USD' ? 'USD' : 'MXN',
                description_text: descriptionText ?? null,
                last_updated:     new Date().toISOString(),
                in_updater:       true,
                published_by_app: true,
            }, { onConflict: 'meli_id' });
            if (sbErr) {
                console.error('[Melidrop] products upsert error (publish-to-real):', sbErr.message);
                return;
            }
            supabase.functions.invoke('amazon-ml-updater', {
                body: { force: true, userId: user.id, asin: product.asin }
            }).catch(err => console.warn('[Melidrop] Post-publish updater trigger failed:', err));
        } catch (e: any) {
            console.error('[Melidrop] trackPublishedProduct failed:', e.message);
        }
    };

    // The list on screen, kept in step with what saveOutcome saved — touched
    // only when something changed, since a bulk run calls this per product.
    const applyOutcome = (product: TestProduct, outcome: { missingAttributes: any[] | null; title?: string }) => {
        const sameMissing = JSON.stringify(outcome.missingAttributes) === JSON.stringify(product.missingAttributes ?? null);
        if (sameMissing && !outcome.title) return;
        setTestProducts(prev => prev.map(p => p.id === product.id
            ? { ...p, missingAttributes: outcome.missingAttributes, ...(outcome.title ? { title: outcome.title } : {}) }
            : p));
    };

    const handlePublishToReal = async (id: string) => {
        const product = testProducts.find(p => p.id === id);
        if (!product) return;

        if (!product.hasPayload) {
            alert('Este producto debe publicarse primero en el sandbox antes de pasar a producción. Vuelve a importarlo desde el Amazon Importer.');
            return;
        }

        // Verify real ML credentials are connected
        const realCreds = meliService.getCredentials();
        if (!realCreds?.token) {
            alert('No tienes credenciales reales de MercadoLibre conectadas. Ve a Configuración para conectar tu cuenta.');
            return;
        }

        // checkDuplicate() with no override checks the real account — guards
        // against accidentally publishing the same ASIN twice for real (e.g. a
        // double-click, or retrying after a network hiccup).
        const dup = await meliService.checkDuplicate(product.asin);
        if (dup.isDuplicate) {
            alert(`Ya existe en tu cuenta real de MercadoLibre (ID: ${dup.existingItem?.id}). No se volvió a publicar.`);
            const publishedNow = new Date().toISOString();
            await api.testProducts.update(id, { meli_id: dup.existingItem?.id, is_published_to_real: true, published_to_real_at: publishedNow });
            setTestProducts(prev => prev.map(p => p.id === id ? { ...p, meliId: dup.existingItem?.id, isPublishedToReal: true, publishedToRealDate: publishedNow.split('T')[0] } : p));
            return;
        }

        console.log('[Melidrop] handlePublishToReal: Using real credentials', {
            userId: realCreds.id,
            nickname: realCreds.nickname,
            appId: realCreds.appId,
            hasRefreshToken: !!realCreds.refreshToken,
            expiresAt: new Date(realCreds.expiresAt).toISOString(),
            tokenExpired: Date.now() > realCreds.expiresAt,
            expiringIn5Min: Date.now() + 300000 > realCreds.expiresAt,
            allKeys: Object.keys(localStorage).filter(k => k.includes('meli') || k.includes('test')).map(k => ({ key: k, length: localStorage.getItem(k)?.length }))
        });

        try {
            // Extract description for separate posting (ML rejects description in POST /items)
            // Fetched now rather than with the list (see api.testProducts.list).
            const payload = await api.testProducts.getPayload(id);
            if (!payload) {
                alert('No se encontraron los datos de esta publicación. Vuelve a importarla desde el Amazon Importer.');
                return;
            }
            const descriptionText = payload?.description?.plain_text;
            const itemPayload = { ...payload, description: undefined, attributes: sanitizePublishAttributes(payload?.attributes) };

            const result = await meliService.publishItemWithFallbacks(itemPayload, false);
            applyOutcome(product, await saveOutcome(product, payload, result));

            if (result.error) {
                const causes: string[] = [];
                blockingCauses(result.cause).forEach((c: any) => {
                    const field = c.field ? `[${c.field}] ` : '';
                    const msg = c.message || c.description || (c.code ? `código ${c.code}` : null) || JSON.stringify(c);
                    causes.push(`${field}${msg}`);
                });
                const errorMsg = causes.length > 0
                    ? `${result.error}\n• ${causes.join('\n• ')}`
                    : result.error;
                // Full raw ML response (result.raw carries the untruncated JSON body) —
                // the alert only shows a flattened summary, so this is what to check
                // in DevTools when a cause needs more detail than a one-line message.
                console.error('[Melidrop] handlePublishToReal error:', { asin: product.asin, error: result.error, cause: result.cause, raw: result.raw, payload: itemPayload });
                alert(`Error al publicar:\n${errorMsg}`);
                return;
            }

            // Post description separately (ML requires PUT /items/{id}/description)
            if (result.id && descriptionText) {
                await meliService.postDescription(result.id, descriptionText);
            }

            // Update test product with real meli_id and publication status
            const publishedNow = new Date().toISOString();
            await api.testProducts.update(id, {
                meli_id: result.id,
                is_published_to_real: true,
                published_to_real_at: publishedNow
            });

            // Update local state
            setTestProducts(prev => prev.map(p =>
                p.id === id ? { ...p, meliId: result.id, isPublishedToReal: true, publishedToRealDate: publishedNow.split('T')[0] } : p
            ));

            await trackPublishedProduct(product, result, itemPayload, descriptionText);

            const repaired = result.attributeRepairs?.length
                ? `\n\nAtributos completados automáticamente:\n• ${result.attributeRepairs.join('\n• ')}`
                : '';
            alert(`✅ Producto publicado exitosamente.\nID: ${result.id}\nVer: ${result.permalink || 'En tu panel de MercadoLibre'}${repaired}`);
        } catch (err: any) {
            console.error("Error publishing to real account:", err);
            alert(`Error: ${err.message}`);
        }
    };

    // A test product's meli_id lives under the REAL account only once
    // isPublishedToReal is true — until then it belongs to the sandbox test
    // user's own catalog, so any call on it (delete, status check) needs
    // THAT account's token instead.
    const resolveItemToken = async (product: TestProduct): Promise<string | undefined> => {
        if (product.isPublishedToReal) return undefined;
        try {
            return (await meliService.autoRefreshTestUserToken()) ?? undefined;
        } catch {
            return undefined;
        }
    };

    const handleDelete = async (id: string, meliId?: string) => {
        if (!confirm('¿Estás seguro de que deseas eliminar este producto?')) return;
        try {
            const product = testProducts.find(p => p.id === id);
            if (meliId && product) {
                const token = await resolveItemToken(product);
                // Swallowing a failed remote delete here used to still drop the local
                // row unconditionally — that row's meli_id is the only thing that lets
                // a future re-import of this ASIN detect "already in sandbox" without
                // relying on ML's own catalog search (which can 403 silently on a
                // stale test-user token after "Regenerar Usuario", or lag behind a
                // fresh publish). Losing it while the ML listing is still live is a
                // second, independent way to end up with a genuine duplicate.
                await meliService.deleteItem(meliId, token);
            }
            await api.testProducts.delete(id);
            setTestProducts(prev => prev.filter(p => p.id !== id));
        } catch (err: any) {
            console.error("Error deleting product:", err);
            alert("No se pudo eliminar en MercadoLibre — el producto se mantiene en la lista para evitar una publicación duplicada más adelante. " + err.message);
        }
    };

    const handleBulkDelete = async () => {
        if (selectedIds.length === 0) return;
        if (!confirm(`¿Eliminar ${selectedIds.length} producto(s) seleccionado(s)?`)) return;
        const toDelete = testProducts.filter(p => selectedIds.includes(p.id));
        const deletedIds: string[] = [];
        const failedTitles: string[] = [];
        await Promise.all(toDelete.map(async p => {
            try {
                if (p.meliId) {
                    const token = await resolveItemToken(p);
                    await meliService.deleteItem(p.meliId, token);
                }
                await api.testProducts.delete(p.id);
                deletedIds.push(p.id);
            } catch (err: any) {
                // Same reasoning as handleDelete: keep the local row (and its meli_id)
                // when the ML-side delete fails, instead of silently discarding it.
                failedTitles.push(p.title);
            }
        }));
        setTestProducts(prev => prev.filter(p => !deletedIds.includes(p.id)));
        setSelectedIds(prev => prev.filter(id => !deletedIds.includes(id)));
        if (failedTitles.length > 0) {
            alert(`No se pudieron eliminar ${failedTitles.length} producto(s) en MercadoLibre — se mantienen en la lista para evitar publicaciones duplicadas:\n${failedTitles.join('\n')}`);
        }
    };

    const handleBulkPublish = async () => {
        if (selectedIds.length === 0) return;
        const pending = testProducts.filter(p => selectedIds.includes(p.id) && !p.isPublishedToReal);
        const toPublish = pending.filter(p => p.hasPayload);
        const note = noDataNote(pending.length - toPublish.length);
        if (toPublish.length === 0) {
            alert(pending.length > 0 ? `Ninguno de los seleccionados se puede publicar.${note}` : 'Los seleccionados ya están publicados en tu cuenta real.');
            return;
        }
        if (!confirm(`¿Publicar ${toPublish.length} producto(s) en tu cuenta REAL de MercadoLibre?${note}`)) return;

        const realCreds = meliService.getCredentials();
        if (!realCreds?.token) {
            alert('No tienes credenciales reales de MercadoLibre conectadas. Ve a Configuración para conectar tu cuenta.');
            return;
        }

        bulkPublishCancelRef.current = false;
        setBulkPublishRun({ total: toPublish.length, done: 0, successCount: 0, errors: [], finished: false, cancelled: false });

        // Tracked locally (not read back from bulkPublishRun state) so the final
        // setSelectedIds below always sees every failure from this run, not a
        // stale snapshot — state updates queued during the loop aren't
        // guaranteed to be flushed back into this closure by the time it ends.
        const failedIds: string[] = [];
        // One shape for both outcomes: this project compiles without
        // strictNullChecks, where a { success: true } | { success: false; … }
        // union never narrows.
        const markDone = (result: { success: boolean; id?: string; title?: string; message?: string }) => {
            if (!result.success && result.id) failedIds.push(result.id);
            setBulkPublishRun(prev => prev && {
                ...prev,
                done: prev.done + 1,
                successCount: prev.successCount + (result.success ? 1 : 0),
                errors: result.success ? prev.errors : [...prev.errors, { title: result.title ?? '', message: result.message ?? '', id: result.id }],
            });
        };

        let untried: string[] = [];
        for (const [index, product] of toPublish.entries()) {
            if (bulkPublishCancelRef.current) break;
            try {
                // Guard against publishing the same ASIN twice for real.
                const dup = await meliService.checkDuplicate(product.asin);
                if (dup.isDuplicate) {
                    const publishedNow = new Date().toISOString();
                    await api.testProducts.update(product.id, { meli_id: dup.existingItem?.id, is_published_to_real: true, published_to_real_at: publishedNow });
                    setTestProducts(prev => prev.map(p =>
                        p.id === product.id ? { ...p, meliId: dup.existingItem?.id, isPublishedToReal: true, publishedToRealDate: publishedNow.split('T')[0] } : p
                    ));
                    markDone({ success: true });
                    continue;
                }

                const payload = await api.testProducts.getPayload(product.id);
                if (!payload) {
                    markDone({ success: false, id: product.id, title: product.title, message: 'sin payload (re-importar)' });
                    continue;
                }
                const descriptionText = payload.description?.plain_text;
                const itemPayload = { ...payload, description: undefined, attributes: sanitizePublishAttributes(payload.attributes) };
                const result = await meliService.publishItemWithFallbacks(itemPayload, false);
                if (result.quotaReached) {
                    untried = toPublish.slice(index).map(p => p.id);
                    setBulkPublishRun(prev => prev && { ...prev, stopReason: quotaStopReason(result, untried.length) });
                    break;
                }
                const outcome = await saveOutcome(product, payload, result);
                applyOutcome(product, outcome);
                if (outcome.repaired) {
                    setBulkPublishRun(prev => prev && { ...prev, repaired: (prev.repaired ?? 0) + 1 });
                }

                if (result.error) {
                    const causes = blockingCauses(result.cause).map((c: any) => c.message || c.code).join(', ') || result.error;
                    // See handlePublishToReal's matching log for why: the modal only
                    // shows this flattened line, full detail (cause[].code/references,
                    // raw ML body) is what a fix like an auto-category-correction would
                    // need to key off of.
                    console.error('[Melidrop] handleBulkPublish error:', { asin: product.asin, error: result.error, cause: result.cause, raw: result.raw, payload: itemPayload });
                    markDone({ success: false, id: product.id, title: product.title, message: causes });
                    continue;
                }

                if (result.id && descriptionText) {
                    await meliService.postDescription(result.id, descriptionText);
                }

                const publishedNow = new Date().toISOString();
                await api.testProducts.update(product.id, {
                    meli_id: result.id,
                    is_published_to_real: true,
                    published_to_real_at: publishedNow
                });
                setTestProducts(prev => prev.map(p =>
                    p.id === product.id ? { ...p, meliId: result.id, isPublishedToReal: true, publishedToRealDate: publishedNow.split('T')[0] } : p
                ));
                await trackPublishedProduct(product, result, itemPayload, descriptionText);
                markDone({ success: true });
            } catch (err: any) {
                console.error('[Melidrop] handleBulkPublish exception:', { asin: product.asin, error: err });
                markDone({ success: false, id: product.id, title: product.title, message: err.message });
            }
        }

        // Failed items stay selected so retrying is "click Publicar seleccionados
        // again" instead of having to re-find them — successes are already
        // filtered out of any future toPublish (isPublishedToReal is now true).
        // So do the ones a stop at the daily limit left untried.
        setSelectedIds([...failedIds, ...untried]);
        setBulkPublishRun(prev => prev && { ...prev, finished: true, cancelled: bulkPublishCancelRef.current });
    };

    // The importer's "Probar" step for rows that already have their data — such
    // as listings handed over from another account, which never went through
    // the importer here. Publishes the saved payload to the sandbox test user
    // with buildItemPayload(isSandbox)'s differences (price ×10 so nobody can
    // buy it by accident, always Clásica, the test account's shipping block)
    // and records the test listing's id, so the row then reads like any other
    // tested product and "Publicar Real" works as usual.
    const handleBulkSandboxTest = async () => {
        const pending = testProducts.filter(p => selectedIds.includes(p.id) && !p.isPublishedToReal);
        const toTest = pending.filter(p => p.hasPayload);
        const note = noDataNote(pending.length - toTest.length);
        if (toTest.length === 0) {
            alert(pending.length > 0 ? `Ninguno de los seleccionados se puede probar.${note}` : 'Los seleccionados ya están publicados en tu cuenta real.');
            return;
        }
        if (!confirm(`¿Probar ${toTest.length} producto(s) en tu cuenta de PRUEBA de MercadoLibre? No se publica nada en tu cuenta real.${note}`)) return;

        let testToken: string | undefined;
        try { testToken = (await meliService.autoRefreshTestUserToken()) ?? undefined; } catch { testToken = undefined; }
        if (!testToken) {
            alert('No hay un usuario de prueba conectado. Créalo arriba con "Crear Usuario Test" y vuelve a intentar.');
            return;
        }

        bulkPublishCancelRef.current = false;
        setBulkPublishRun({ total: toTest.length, done: 0, successCount: 0, errors: [], finished: false, cancelled: false, sandbox: true });
        const failedIds: string[] = [];
        const markDone = (ok: boolean, product: TestProduct, message = '') => {
            if (!ok) failedIds.push(product.id);
            setBulkPublishRun(prev => prev && {
                ...prev,
                done: prev.done + 1,
                successCount: prev.successCount + (ok ? 1 : 0),
                errors: ok ? prev.errors : [...prev.errors, { title: product.title, message, id: product.id }],
            });
        };

        let untried: string[] = [];
        for (const [index, product] of toTest.entries()) {
            if (bulkPublishCancelRef.current) break;
            try {
                const payload = await api.testProducts.getPayload(product.id);
                if (!payload) { markDone(false, product, 'sin payload (re-importar)'); continue; }
                const descriptionText = payload.description?.plain_text;
                const testPayload = {
                    ...payload,
                    description: undefined,
                    attributes: sanitizePublishAttributes(payload.attributes),
                    price: Math.round(Number(payload.price) * 10),
                    // Never Premium on the test account; the saved payload keeps its
                    // own type for "Publicar Real".
                    listing_type_id: 'gold_special',
                    shipping: { mode: 'me2', free_shipping: true, local_pick_up: false, handling_time: 30 },
                };
                const result = await meliService.publishItemWithFallbacks(testPayload, false, testToken);
                if (result.quotaReached) {
                    untried = toTest.slice(index).map(p => p.id);
                    setBulkPublishRun(prev => prev && { ...prev, stopReason: quotaStopReason(result, untried.length) });
                    break;
                }
                const outcome = await saveOutcome(product, payload, result);
                applyOutcome(product, outcome);
                if (outcome.repaired) {
                    setBulkPublishRun(prev => prev && { ...prev, repaired: (prev.repaired ?? 0) + 1 });
                }
                if (result.error) {
                    const causes = blockingCauses(result.cause).map((c: any) => c.message || c.code).join(', ') || result.error;
                    console.error('[Melidrop] handleBulkSandboxTest error:', { asin: product.asin, error: result.error, cause: result.cause, raw: result.raw });
                    markDone(false, product, causes);
                    continue;
                }
                if (result.id && descriptionText) {
                    try { await meliService.postDescription(result.id, descriptionText, testToken); } catch { /* the listing itself is up */ }
                }
                const status = result.status ?? 'active';
                await api.testProducts.update(product.id, { meli_id: result.id, status });
                setTestProducts(prev => prev.map(p => p.id === product.id ? { ...p, meliId: result.id, status } : p));
                markDone(true, product);
            } catch (err: any) {
                markDone(false, product, err.message);
            }
        }

        setSelectedIds([...failedIds, ...untried]);
        setBulkPublishRun(prev => prev && { ...prev, finished: true, cancelled: bulkPublishCancelRef.current });
    };

    const clearSandbox = async () => {
        const confirmClear = window.confirm('¿Estás seguro de limpiar todo el entorno de pruebas? Esta acción eliminará permanentemente todos los productos del catálogo de test, incluyendo sus publicaciones en la cuenta de prueba de MercadoLibre.');
        if (!confirmClear) return;
        try {
            // Delete each sandbox listing from ML first (using the test user's own
            // token — these ids don't exist under the real account) so "clear"
            // actually clears MercadoLibre's test catalog too, not just this table.
            const toDelete = testProducts.filter(p => p.meliId && !p.isPublishedToReal);
            const failedIds = new Set<string>();
            await Promise.all(toDelete.map(async p => {
                const token = await resolveItemToken(p);
                try {
                    await meliService.deleteItem(p.meliId!, token);
                } catch {
                    failedIds.add(p.id);
                }
            }));

            if (failedIds.size === 0) {
                await api.testProducts.clearAll();
                setTestProducts([]);
                setSelectedIds([]);
                alert('Entorno Sandbox limpiado exitosamente.');
                return;
            }

            // Some ML-side deletes failed — only drop the local rows that are
            // actually gone from ML's sandbox. Keeping the failed ones (with their
            // meli_id intact) is what stops a future re-import of that ASIN from
            // slipping past every duplicate check and creating a genuine second
            // listing under the orphaned id.
            const toKeep = testProducts.filter(p => failedIds.has(p.id));
            await Promise.all(testProducts.filter(p => !failedIds.has(p.id)).map(p => api.testProducts.delete(p.id)));
            setTestProducts(toKeep);
            setSelectedIds([]);
            alert(`Se limpió el entorno Sandbox, excepto ${failedIds.size} producto(s) que no se pudieron eliminar en MercadoLibre (se mantienen para evitar duplicados).`);
        } catch (err) {
            console.error("Clear error:", err);
        }
    };

    const getPublishedFilterLabel = () => {
        switch (filterPublished) {
            case 'published': return 'Publicados en MercadoLibre';
            case 'not_published': return 'No publicados en MercadoLibre';
            default: return 'Todos los productos';
        }
    };

    // Now that handleSync pulls ML's real status instead of a hardcoded 'active',
    // this needs to cover the actual states ML uses — a plain active/paused split
    // would show "Pausado" for an item that's really just pending review. Checked
    // before the plain status switch so a closed+deleted item reads as "Eliminado
    // por ML" instead of just "Cerrado".
    const statusBadge = (p: TestProduct): { label: string; cls: string } => {
        if (isUnpublished(p)) {
            return { label: 'Sin publicar', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
        }
        if (isDeletedByMl(p)) {
            return { label: 'Eliminado por ML', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' };
        }
        switch (p.status) {
            case 'active':
                return { label: 'Activo', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
            case 'paused':
                return { label: 'Pausado', cls: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' };
            case 'under_review':
            case 'not_yet_active':
            case 'payment_required':
                return { label: 'En revisión', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' };
            case 'closed':
                return { label: 'Cerrado', cls: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300' };
            case 'inactive':
                return { label: 'Inactivo', cls: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300' };
            default:
                return { label: p.status || 'Desconocido', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' };
        }
    };

    return (
        <div className="flex-1 flex flex-col h-full bg-background-light dark:bg-background-dark overflow-hidden">
            {/* Header */}
            <div className="p-6 pb-0">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                    <div>
                        <h1 className="text-2xl font-bold text-text-main-light dark:text-white tracking-tight">Entorno de Pruebas (Sandbox)</h1>
                        <p className="text-sm text-text-secondary-light dark:text-text-secondary-dark">Valida tus importaciones antes de la salida al mercado real.</p>
                    </div>
                    <div className="flex bg-white dark:bg-slate-800 p-1 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 w-fit">
                        <button 
                            onClick={() => setActiveTab('products')}
                            className={`px-4 py-2 text-sm font-bold rounded-lg transition-all flex items-center gap-2 ${activeTab === 'products' ? 'bg-primary text-white shadow-md' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                        >
                            <span className="material-symbols-outlined text-[20px]">inventory_2</span>
                            Catálogo de Test
                        </button>
                        <button 
                            onClick={() => setActiveTab('config')}
                            className={`px-4 py-2 text-sm font-bold rounded-lg transition-all flex items-center gap-2 ${activeTab === 'config' ? 'bg-primary text-white shadow-md' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
                        >
                            <span className="material-symbols-outlined text-[20px]">settings</span>
                            Configuración
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 pt-2">
                {activeTab === 'config' ? (
                    <div className="max-w-4xl mx-auto space-y-6 pb-20">
                        <div className="bg-primary/5 dark:bg-primary/10 border border-primary/20 rounded-2xl p-6 flex flex-col md:flex-row items-center gap-6">
                            <div className="size-16 rounded-2xl bg-primary flex items-center justify-center text-white shadow-lg shadow-primary/30">
                                <span className="material-symbols-outlined text-[32px]">science</span>
                            </div>
                            <div className="flex-1 text-center md:text-left">
                                <h2 className="text-lg font-bold text-slate-900 dark:text-white">Estado del Entorno</h2>
                                <p className="text-sm text-slate-500 dark:text-slate-400">Tu cuenta Sandbox está sincronizada. Las publicaciones realizadas aquí no afectarán tu reputación real.</p>
                            </div>
                            <div className="flex items-center gap-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-4 py-2 rounded-full font-bold text-sm">
                                <span className="material-symbols-outlined text-[18px]">verified</span>
                                Activo
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-6">
                            <div className="bg-surface-light dark:bg-surface-dark border border-slate-200 dark:border-slate-700 rounded-2xl p-6 shadow-sm">
                                <div className="flex items-start gap-4">
                                    <div className="size-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-500">1</div>
                                    <div className="flex-1">
                                        <div className="flex justify-between items-center mb-4">
                                            <h3 className="font-bold text-slate-900 dark:text-white">Cuenta Mercado Libre (Test)</h3>
                                            <span className={`text-xs font-bold px-2 py-1 rounded ${testUser ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20' : 'text-slate-400 bg-slate-100'}`}>
                                                {testUser ? 'VINCULADO' : 'PENDIENTE'}
                                            </span>
                                        </div>
                                        <div className="flex flex-col sm:flex-row items-center gap-4 bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl border border-slate-100 dark:border-slate-800">
                                            <div className="flex-1 text-sm text-slate-600 dark:text-slate-400 italic">
                                                {testUser ? (
                                                    <>Usuario: <span className="font-bold text-slate-800 dark:text-slate-200">{testUser.nickname}</span></>
                                                ) : (
                                                    'No hay un usuario de prueba activo.'
                                                )}
                                            </div>
                                            <button 
                                                onClick={handleCreateTestUser}
                                                disabled={isCreatingUser}
                                                className="bg-primary text-white px-4 py-2 rounded-lg text-xs font-bold shadow-sm hover:opacity-90 disabled:opacity-50"
                                            >
                                                {isCreatingUser ? 'Generando...' : testUser ? 'Regenerar Usuario' : 'Crear Usuario Test'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-surface-light dark:bg-surface-dark border border-slate-200 dark:border-slate-700 rounded-2xl p-6 shadow-sm">
                                <div className="flex items-start gap-4">
                                    <div className="size-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-500">2</div>
                                    <div className="flex-1">
                                        <h3 className="font-bold text-slate-900 dark:text-white mb-2">Credenciales Sandbox</h3>
                                        <p className="text-sm text-slate-500 mb-4">Utiliza estos datos para iniciar sesión en MercadoLibre y ver tus pruebas.</p>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                                            <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                                <p className="text-[10px] font-bold text-slate-400 uppercase">Email</p>
                                                <p className="text-xs font-mono text-slate-700 dark:text-slate-300 truncate">{testUser?.email || 'N/A'}</p>
                                            </div>
                                            <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3 relative">
                                                <p className="text-[10px] font-bold text-slate-400 uppercase">Contraseña</p>
                                                <p className="text-xs font-mono text-slate-700 dark:text-slate-300">{testUser?.password || '••••••••'}</p>
                                                {testUser?.password && (
                                                     <button 
                                                        onClick={() => {navigator.clipboard.writeText(testUser.password); alert('Copiado');}}
                                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-primary"
                                                     >
                                                         <span className="material-symbols-outlined text-[16px]">content_copy</span>
                                                     </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-surface-light dark:bg-surface-dark border border-slate-200 dark:border-slate-700 rounded-2xl p-6 shadow-sm">
                                <div className="flex items-start gap-4">
                                    <div className="size-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center font-bold text-slate-500">3</div>
                                    <div className="flex-1">
                                        <h3 className="font-bold text-slate-900 dark:text-white mb-2">Acceso Rápido</h3>
                                        <p className="text-sm text-slate-500 mb-4">Abre el panel de vendedor con tu cuenta de prueba.</p>
                                        <div className="flex gap-2">
                                            <button 
                                                onClick={() => window.open('https://www.mercadolibre.com.mx/menu', '_blank')}
                                                className="bg-slate-900 text-white px-6 py-2 rounded-lg text-xs font-bold hover:opacity-90 transition-opacity flex items-center gap-2"
                                            >
                                                <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                                                IR A PANEL VENDEDOR TEST
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="max-w-7xl mx-auto flex flex-col gap-4 animate-fade-in pb-20">
                        {/* Search & Filters BAR — laid out like ML's own seller panel: field-scoped
                            search, then a date-type filter with an overflow funnel, then a status
                            count row underneath acting as one-click filters. */}
                        <div className="bg-surface-light dark:bg-surface-dark p-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col gap-3">
                            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
                                {/* Search: field selector + text, like ML's "Título ▾ | Escribir..." bar */}
                                <div className="flex items-center flex-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-primary focus-within:border-primary">
                                    <select
                                        value={searchField}
                                        onChange={(e) => setSearchField(e.target.value as any)}
                                        className="bg-transparent border-none border-r border-slate-200 dark:border-slate-700 text-sm font-bold text-slate-600 dark:text-slate-300 pl-3 pr-8 py-2 focus:ring-0 cursor-pointer"
                                    >
                                        <option value="title">Título</option>
                                        <option value="asin">ASIN</option>
                                        <option value="sku">SKU</option>
                                        <option value="brand">Marca</option>
                                    </select>
                                    <input
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="flex-1 min-w-0 border-none bg-transparent px-3 py-2 text-sm focus:ring-0"
                                        placeholder="Escribir..."
                                    />
                                    <span className="material-symbols-outlined text-slate-400 px-3">search</span>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    {/* Date filter: date-type selector + from/to range, like ML's
                                        "Actualización ▾ | dd/mm/aaaa" but with two bounds instead of
                                        one exact day, and a third type (Publicación Real) alongside
                                        creation/last-update. */}
                                    <div className="flex items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                                        <select
                                            value={dateFilterType}
                                            onChange={(e) => setDateFilterType(e.target.value as any)}
                                            className="bg-transparent border-none border-r border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 pl-3 pr-6 py-2 focus:ring-0 cursor-pointer"
                                        >
                                            <option value="created">Creación</option>
                                            <option value="updated">Actualización</option>
                                            <option value="published">Publicación Real</option>
                                        </select>
                                        <input
                                            type="date"
                                            value={filterDateFrom}
                                            onChange={(e) => setFilterDateFrom(e.target.value)}
                                            title="Desde"
                                            className="bg-transparent border-none text-xs font-bold text-slate-600 dark:text-slate-300 focus:ring-0 px-2 py-2"
                                        />
                                        <span className="text-slate-300 dark:text-slate-600 text-xs">—</span>
                                        <input
                                            type="date"
                                            value={filterDateTo}
                                            onChange={(e) => setFilterDateTo(e.target.value)}
                                            title="Hasta"
                                            className="bg-transparent border-none text-xs font-bold text-slate-600 dark:text-slate-300 focus:ring-0 px-2 py-2"
                                        />
                                        {(filterDateFrom || filterDateTo) && (
                                            <button
                                                onClick={() => { setFilterDateFrom(''); setFilterDateTo(''); }}
                                                className="text-slate-400 hover:text-red-500 pr-2"
                                            >
                                                <span className="material-symbols-outlined text-[16px]">close</span>
                                            </button>
                                        )}
                                    </div>

                                    {/* Overflow filters (Publicados / No publicados) — native ML statuses live as pills below */}
                                    <div className="relative">
                                        <button
                                            onClick={() => setShowFilters(!showFilters)}
                                            title={getPublishedFilterLabel()}
                                            className={`flex items-center justify-center size-9 rounded-lg transition-all border ${showFilters || filterPublished !== 'all' ? 'bg-primary/10 border-primary text-primary' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                                        >
                                            <span className="material-symbols-outlined text-[20px]">filter_alt</span>
                                        </button>

                                        {showFilters && (
                                            <div className="absolute top-full right-0 mt-2 w-64 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 z-50 overflow-hidden">
                                                <button
                                                    onClick={() => { setFilterPublished('all'); setShowFilters(false); }}
                                                    className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterPublished === 'all' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                                >
                                                    Todos los productos
                                                </button>
                                                <button
                                                    onClick={() => { setFilterPublished('published'); setShowFilters(false); }}
                                                    className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterPublished === 'published' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                                >
                                                    Publicados en MercadoLibre
                                                </button>
                                                <button
                                                    onClick={() => { setFilterPublished('not_published'); setShowFilters(false); }}
                                                    className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterPublished === 'not_published' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                                >
                                                    No publicados en MercadoLibre
                                                </button>
                                            </div>
                                        )}
                                    </div>

                                    <button
                                        onClick={handleSync}
                                        disabled={isSyncing}
                                        className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-primary hover:bg-primary/10 rounded-lg transition-all border border-primary/20 disabled:opacity-50 whitespace-nowrap"
                                    >
                                        <span className={`material-symbols-outlined text-[20px] ${isSyncing ? 'animate-spin' : ''}`}>sync</span>
                                        {isSyncing
                                            ? (syncProgress ? `Sincronizando ${syncProgress.done.toLocaleString()} / ${syncProgress.total.toLocaleString()}` : 'Sincronizando...')
                                            : 'Sincronizar Test'}
                                    </button>
                                </div>
                            </div>

                            {/* Status counts — same buckets ML's own panel shows, click to filter */}
                            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
                                {([
                                    { key: 'active', label: 'Activa', count: statusCounts.active },
                                    { key: 'paused', label: 'Pausada', count: statusCounts.paused },
                                    { key: 'under_review', label: 'Revisando', count: statusCounts.review },
                                    { key: 'inactive', label: 'Inactiva', count: statusCounts.inactive },
                                    { key: 'unpublished', label: 'Sin publicar', count: statusCounts.unpublished, title: 'Su prueba en la cuenta de prueba falló, así que no existen en Mercado Libre. Se guardaron para que puedas publicarlos en tu cuenta real.' },
                                ] as { key: SandboxStatusFilter; label: string; count: number; title?: string }[]).map(s => (
                                    <button
                                        key={s.key}
                                        title={s.title}
                                        onClick={() => setFilterStatus(prev => prev === s.key ? 'all' : s.key)}
                                        className={`font-bold flex items-baseline gap-1.5 transition-colors ${filterStatus === s.key ? 'text-primary' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                                    >
                                        {s.label} <span className={filterStatus === s.key ? 'text-primary' : 'text-slate-400 dark:text-slate-500'}>{s.count}</span>
                                    </button>
                                ))}
                                <button
                                    onClick={() => setFilterStatus(prev => prev === 'deleted_by_ml' ? 'all' : 'deleted_by_ml')}
                                    className={`font-bold flex items-baseline gap-1.5 transition-colors ${filterStatus === 'deleted_by_ml' ? 'text-primary' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                                >
                                    Eliminada por Mercado Libre
                                    <span
                                        title="Publicaciones cerradas y marcadas como eliminadas por Mercado Libre según el sub-estado que devuelve su API (no las que tú borraste desde aquí). Usa 'Sincronizar Test' para actualizar este dato."
                                        className="material-symbols-outlined text-[14px] text-slate-400 cursor-help"
                                    >
                                        info
                                    </span>
                                    <span className={filterStatus === 'deleted_by_ml' ? 'text-primary' : 'text-slate-400 dark:text-slate-500'}>{statusCounts.deletedByMl}</span>
                                </button>
                                <button
                                    onClick={() => setFilterMissing(v => !v)}
                                    title="Productos a los que Mercado Libre les pide datos que no están ni en Amazon ni en el título. Ábrelos con 'Completar' y escríbelos."
                                    className={`font-bold flex items-baseline gap-1.5 transition-colors ${filterMissing ? 'text-amber-600' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                                >
                                    Faltan datos
                                    <span className={filterMissing ? 'text-amber-600' : 'text-slate-400 dark:text-slate-500'}>{missingCount}</span>
                                </button>
                            </div>
                        </div>

                        {/* Table */}
                        <div className="bg-surface-light dark:bg-surface-dark border border-slate-200 dark:border-slate-700 rounded-2xl shadow-sm overflow-hidden min-h-[400px]">
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                                        <tr>
                                            <th className="px-6 py-4 w-12">
                                                <input
                                                    type="checkbox"
                                                    className="rounded h-4 w-4 text-primary focus:ring-primary"
                                                    checked={paginatedProducts.length > 0 && paginatedProducts.every(p => selectedIds.includes(p.id))}
                                                    onChange={handleSelectAll}
                                                />
                                            </th>
                                            <th className="px-6 py-4">Producto</th>
                                            <th className="px-6 py-4">ID Referencia</th>
                                            <th className="px-6 py-4 text-right">Precio Test</th>
                                            <th className="px-6 py-4 text-center">Estado Test</th>
                                            <th className="px-6 py-4">Fecha Sync</th>
                                            <th className="px-6 py-4 text-right">Acción</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                        {isLoading ? (
                                            <tr>
                                                <td colSpan={7} className="px-6 py-20 text-center text-slate-400">
                                                    Cargando publicaciones…
                                                    {loadProgress && loadProgress.loaded > 0 && (
                                                        <> {loadProgress.loaded.toLocaleString()}{loadProgress.total ? ` de ${loadProgress.total.toLocaleString()}` : ''}</>
                                                    )}
                                                </td>
                                            </tr>
                                        ) : loadError ? (
                                            <tr>
                                                <td colSpan={7} className="px-6 py-20 text-center text-red-500">
                                                    No se pudieron cargar las publicaciones: {loadError}
                                                    <div className="mt-3">
                                                        <button onClick={loadProducts} className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-bold">
                                                            Reintentar
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ) : filteredProducts.length === 0 ? (
                                            <tr>
                                                <td colSpan={7} className="px-6 py-20 text-center text-slate-400">
                                                    No se encontraron productos en el catálogo de test.
                                                </td>
                                            </tr>
                                        ) : (
                                            paginatedProducts.map(p => {
                                                const badge = statusBadge(p);
                                                return (
                                                <tr key={p.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors group ${selectedIds.includes(p.id) ? 'bg-primary/5' : ''}`}>
                                                    <td className="px-6 py-4">
                                                        <input 
                                                            type="checkbox" 
                                                            className="rounded h-4 w-4 text-primary focus:ring-primary" 
                                                            checked={selectedIds.includes(p.id)}
                                                            onChange={() => handleToggleSelect(p.id)}
                                                        />
                                                    </td>
                                                    <td className="px-6 py-4 max-w-[300px]">
                                                        <div className="flex items-center gap-3">
                                                            <button
                                                                type="button"
                                                                onClick={() => setPreviewImage({ url: p.imageUrl, title: p.title })}
                                                                title="Ver imagen en grande"
                                                                className="group relative size-12 flex-shrink-0 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm"
                                                            >
                                                                <img src={p.imageUrl} className="w-full h-full object-cover" alt={p.title} />
                                                                <span className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                                                                    <span className="material-symbols-outlined text-[16px] text-white opacity-0 group-hover:opacity-100 transition-opacity">zoom_in</span>
                                                                </span>
                                                            </button>
                                                            <div>
                                                                <p className="font-bold text-slate-900 dark:text-white line-clamp-1">{p.title}</p>
                                                                <span className="text-[10px] font-bold text-slate-400 uppercase">{p.category}</span>
                                                                {!!p.missingAttributes?.length && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setCompleting(p)}
                                                                        title={p.missingAttributes.map((a: any) => a.name).join(', ')}
                                                                        className="mt-1 flex items-center gap-1 text-[10px] font-bold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200 dark:hover:bg-amber-900/50 px-2 py-0.5 rounded-full w-fit transition-colors"
                                                                    >
                                                                        <span className="material-symbols-outlined text-[12px]">edit_note</span>
                                                                        Faltan {p.missingAttributes.length} dato{p.missingAttributes.length > 1 ? 's' : ''} · Completar
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <div className="flex flex-col text-xs">
                                                            <a
                                                                href={`https://www.${amazonDomainForCurrency(p.currency)}/dp/${p.asin}`}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                title="Ver en Amazon"
                                                                className="text-primary font-bold hover:underline inline-flex items-center gap-1 w-fit"
                                                            >
                                                                {p.asin}
                                                                <span className="material-symbols-outlined text-[12px]">open_in_new</span>
                                                            </a>
                                                            <span className="text-slate-500 font-mono tracking-tighter">{p.sku}</span>
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-4 text-right font-black text-slate-900 dark:text-white">
                                                        ${p.priceMXN.toLocaleString()}
                                                    </td>
                                                    <td className="px-6 py-4 text-center">
                                                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${badge.cls}`}>{badge.label}</span>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <span className="text-[11px] font-bold text-slate-500">{p.creationDate}</span>
                                                    </td>
                                                    <td className="px-6 py-4 text-right">
                                                        {p.isPublishedToReal ? (
                                                            <div className="flex items-center justify-end gap-1 text-green-600 dark:text-green-400 font-bold text-[9px] bg-green-50 dark:bg-green-900/20 px-2 py-1 rounded w-fit ml-auto border border-green-200 dark:border-green-800/50">
                                                                <span className="material-symbols-outlined text-[14px]">verified</span>
                                                                EN MERCADOLIBRE
                                                            </div>
                                                        ) : (
                                                            <div className="flex items-center justify-end gap-2">
                                                                <button 
                                                                    onClick={() => handlePublishToReal(p.id)}
                                                                    className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-lg text-[10px] font-black shadow-sm transition-all"
                                                                >
                                                                    Publicar Real
                                                                </button>
                                                                <button 
                                                                    onClick={() => handleDelete(p.id, p.meliId)}
                                                                    className="p-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg transition-all"
                                                                    title="Eliminar producto"
                                                                >
                                                                    <span className="material-symbols-outlined text-[18px]">delete</span>
                                                                </button>
                                                            </div>
                                                        )}
                                                    </td>
                                                </tr>
                                                );
                                            })
                                        )}
                                    </tbody>
                                </table>
                            </div>
                            
                            {/* Pagination */}
                            {filteredProducts.length > 0 && (
                                <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700 flex justify-between items-center text-xs text-slate-500 font-bold">
                                    <div>
                                        Mostrando {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, filteredProducts.length)} de {filteredProducts.length} productos filtrados
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                            disabled={currentPage === 1}
                                            className="p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
                                        >
                                            <span className="material-symbols-outlined text-[20px]">chevron_left</span>
                                        </button>
                                        <span className="px-2">Página {currentPage} de {totalPages}</span>
                                        <button
                                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                            disabled={currentPage === totalPages}
                                            className="p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
                                        >
                                            <span className="material-symbols-outlined text-[20px]">chevron_right</span>
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Bulk Actions */}
                        <div className="flex flex-wrap items-center gap-3 mt-4 p-5 bg-white dark:bg-slate-800 rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 shadow-sm">
                            <p className="text-sm font-bold text-slate-500 flex items-center gap-2 mr-2">
                                <span className="material-symbols-outlined text-primary">auto_fix_high</span>
                                Acciones masivas ({selectedIds.length} seleccionados):
                            </p>
                            {filteredProducts.length > selectedIds.length && (
                                <button
                                    onClick={() => setSelectedIds(filteredProducts.map(p => p.id))}
                                    className="text-xs font-bold text-primary hover:underline"
                                >
                                    Seleccionar los {filteredProducts.length} filtrados
                                </button>
                            )}
                            {selectedIds.length > 0 && (
                                <button
                                    onClick={() => setSelectedIds([])}
                                    className="text-xs font-bold text-slate-400 hover:underline"
                                >
                                    Limpiar selección
                                </button>
                            )}
                            <button
                                onClick={handleBulkSandboxTest}
                                disabled={selectedIds.length === 0}
                                title="Sube los seleccionados a tu cuenta de prueba, sin tocar tu cuenta real"
                                className={`text-xs font-bold px-4 py-2 rounded-lg transition-all border ${selectedIds.length > 0 ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800' : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'}`}
                            >
                                Probar en Sandbox
                            </button>
                            {selectedWithoutData.length > 0 && (
                                <button
                                    onClick={reimportFromAmazon}
                                    title="No tienen datos para publicar: el Importador los vuelve a armar desde Amazon con su ASIN"
                                    className="text-xs font-bold px-4 py-2 rounded-lg transition-all border bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100 dark:bg-sky-900/20 dark:text-sky-300 dark:border-sky-800"
                                >
                                    Reimportar desde Amazon ({selectedWithoutData.length})
                                </button>
                            )}
                            <button
                                onClick={handleBulkPublish}
                                disabled={selectedIds.length === 0}
                                className={`text-xs font-bold px-4 py-2 rounded-lg transition-all ${selectedIds.length > 0 ? 'bg-primary text-white shadow-md hover:bg-primary-dark' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
                            >
                                Publicar seleccionados en MercadoLibre
                            </button>
                            <button
                                onClick={handleBulkDelete}
                                disabled={selectedIds.length === 0}
                                className={`text-xs font-bold px-4 py-2 rounded-lg transition-all border ${selectedIds.length > 0 ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800' : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'}`}
                            >
                                Eliminar seleccionados
                            </button>
                            <span className="text-slate-300 dark:text-slate-700 hidden sm:block">|</span>
                            <button
                                onClick={clearSandbox}
                                className="text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-2 rounded-lg transition-colors border border-transparent hover:border-red-200"
                            >
                                Limpiar todo el Sandbox
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {bulkPublishRun && (
                <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-scale-up flex flex-col max-h-[85vh]">
                        <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
                            <h3 className="font-bold text-slate-900 dark:text-white">
                                {bulkPublishRun.sandbox
                                    ? (!bulkPublishRun.finished
                                        ? 'Probando en tu cuenta de prueba...'
                                        : bulkPublishRun.cancelled ? 'Prueba cancelada' : bulkPublishRun.stopReason ? 'Prueba detenida' : 'Prueba terminada')
                                    : (!bulkPublishRun.finished
                                        ? 'Publicando en Mercado Libre...'
                                        : bulkPublishRun.cancelled ? 'Publicación cancelada' : bulkPublishRun.stopReason ? 'Publicación detenida' : 'Publicación terminada')}
                            </h3>
                            {bulkPublishRun.finished && (
                                <button onClick={() => setBulkPublishRun(null)}>
                                    <span className="material-symbols-outlined text-slate-400">close</span>
                                </button>
                            )}
                        </div>
                        <div className="p-6 space-y-4 overflow-y-auto">
                            <div>
                                <div className="flex justify-between text-xs font-bold text-slate-500 mb-1">
                                    <span>{bulkPublishRun.done} de {bulkPublishRun.total}</span>
                                    <span>{Math.round((bulkPublishRun.done / Math.max(bulkPublishRun.total, 1)) * 100)}%</span>
                                </div>
                                <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full transition-all duration-300 ${bulkPublishRun.finished ? (bulkPublishRun.errors.length > 0 || bulkPublishRun.stopReason ? 'bg-amber-500' : 'bg-green-500') : 'bg-primary'}`}
                                        style={{ width: `${(bulkPublishRun.done / Math.max(bulkPublishRun.total, 1)) * 100}%` }}
                                    />
                                </div>
                            </div>
                            <div className="flex gap-4 text-sm">
                                <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-bold">
                                    <span className="material-symbols-outlined text-[16px]">check_circle</span>
                                    {bulkPublishRun.successCount} exitosos
                                </span>
                                {!!bulkPublishRun.repaired && (
                                    <span className="flex items-center gap-1.5 text-primary font-bold" title="Atributos que Mercado Libre pedía, completados con los datos de Amazon o del título">
                                        <span className="material-symbols-outlined text-[16px]">auto_fix_high</span>
                                        {bulkPublishRun.repaired} con atributos completados
                                    </span>
                                )}
                                {bulkPublishRun.errors.length > 0 && (
                                    <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 font-bold">
                                        <span className="material-symbols-outlined text-[16px]">error</span>
                                        {bulkPublishRun.errors.length} con error
                                    </span>
                                )}
                            </div>
                            {bulkPublishRun.stopReason && (
                                <div className="flex gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
                                    <span className="material-symbols-outlined text-[18px] shrink-0">schedule</span>
                                    <span>{bulkPublishRun.stopReason}</span>
                                </div>
                            )}
                            {bulkPublishRun.errors.length > 0 && (
                                <div className="space-y-1.5 max-h-60 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                                    {bulkPublishRun.errors.map((e, i) => {
                                        const product = e.id ? productById.get(e.id) : undefined;
                                        return (
                                            <div key={i} className="text-xs">
                                                <span className="font-bold text-slate-700 dark:text-slate-300">{e.title}:</span>{' '}
                                                <span className="text-red-500">{e.message}</span>
                                                {!!product?.missingAttributes?.length && (
                                                    <button
                                                        onClick={() => setCompleting(product)}
                                                        className="ml-2 font-bold text-amber-700 dark:text-amber-300 hover:underline"
                                                    >
                                                        Completar datos
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {bulkPublishRun.finished && bulkPublishRun.errors.length > 0 && (
                                <p className="text-xs text-slate-400 italic">
                                    Los productos con error quedaron seleccionados — corrige lo que haga falta y dale "{bulkPublishRun.sandbox ? 'Probar en Sandbox' : 'Publicar seleccionados'}" de nuevo para reintentar solo esos.
                                </p>
                            )}
                        </div>
                        <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-200 dark:border-slate-700 flex justify-end">
                            {!bulkPublishRun.finished ? (
                                <button
                                    onClick={() => { bulkPublishCancelRef.current = true; }}
                                    className="px-4 py-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg text-sm font-bold transition-all"
                                >
                                    Cancelar
                                </button>
                            ) : (
                                <button
                                    onClick={() => setBulkPublishRun(null)}
                                    className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-bold shadow-sm hover:shadow active:scale-95 transition-all"
                                >
                                    Cerrar
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {completing && (
                <MissingDataModal
                    product={completing}
                    onClose={() => setCompleting(null)}
                    onSaved={remaining => {
                        const id = completing.id;
                        setTestProducts(prev => prev.map(p => p.id === id ? { ...p, missingAttributes: remaining } : p));
                        setCompleting(null);
                    }}
                />
            )}

            {previewImage && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm"
                    onClick={() => setPreviewImage(null)}
                >
                    <div className="relative max-w-3xl max-h-full" onClick={e => e.stopPropagation()}>
                        <button
                            onClick={() => setPreviewImage(null)}
                            className="absolute -top-4 -right-4 size-9 rounded-full bg-white text-slate-700 shadow-lg flex items-center justify-center hover:bg-slate-100"
                            title="Cerrar"
                        >
                            <span className="material-symbols-outlined text-[20px]">close</span>
                        </button>
                        <img
                            src={previewImage.url}
                            alt={previewImage.title}
                            className="max-w-full max-h-[80vh] rounded-xl shadow-2xl object-contain bg-white"
                        />
                        <p className="mt-3 text-center text-sm font-bold text-white line-clamp-2">{previewImage.title}</p>
                    </div>
                </div>
            )}
        </div>
    );
};