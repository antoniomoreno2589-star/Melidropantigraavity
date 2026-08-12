import React, { useState, useMemo, useEffect } from 'react';
import { Product } from '../types';
import { api } from '../services/api';
import { meliService } from '../services/meliService';
import { supabase } from '../services/supabase';
import { sanitizePublishAttributes } from './AmazonImporter/useAmazonImporter';

interface TestProduct extends Product {
    isPublishedToReal: boolean;
    creationDate: string; // Format YYYY-MM-DD for easier filtering
    updatedDate: string;  // Same format, backed by test_products.updated_at
    subStatus: string[];  // ML's real sub_status array (e.g. ["deleted"] when ML itself removed the listing)
    prepTime: string;
    category: string;
}

type SandboxStatusFilter = 'all' | 'published' | 'not_published' | 'active' | 'paused' | 'under_review' | 'inactive' | 'deleted_by_ml';

// ML represents "removed by Mercado Libre" as status=closed plus a "deleted"
// sub_status entry — the same shape a seller-initiated close/delete can leave,
// so this is best-effort (Melidrop's own deleteItem rows vanish from this
// table immediately on delete, so they can't be mistaken for this bucket).
const isDeletedByMl = (p: TestProduct): boolean =>
    p.status === 'closed' && Array.isArray(p.subStatus) && p.subStatus.includes('deleted');

export const TestProductsPage = () => {
    const [activeTab, setActiveTab] = useState<'config' | 'products'>('products');
    const [searchField, setSearchField] = useState<'title' | 'asin' | 'sku'>('title');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [isSyncing, setIsSyncing] = useState(false);
    const [filterStatus, setFilterStatus] = useState<SandboxStatusFilter>('all');
    const [dateFilterType, setDateFilterType] = useState<'created' | 'updated'>('created');
    const [filterDate, setFilterDate] = useState<string>('');
    const [showFilters, setShowFilters] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const PAGE_SIZE = 20;
    const [previewImage, setPreviewImage] = useState<{ url: string; title: string } | null>(null);

    const [testProducts, setTestProducts] = useState<TestProduct[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [testUser, setTestUser] = useState<any>(null);
    const [isCreatingUser, setIsCreatingUser] = useState(false);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const data = await api.testProducts.list();
                setTestProducts(data);
                
                // Fetch test user from Supabase
                const { data: { user: authUser } } = await supabase.auth.getUser();
                if (authUser) {
                    const { data: userData } = await supabase.from('user_connections').select('meli_test_user').eq('user_id', authUser.id).maybeSingle();
                    if (userData?.meli_test_user) setTestUser(userData.meli_test_user);
                }
            } catch (err) {
                console.error("Error fetching data:", err);
            } finally {
                setIsLoading(false);
            }
        };
        fetchData();
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
            // 1. Search filter, scoped to whichever field the dropdown has selected
            const matchesSearch = !q ? true
                : searchField === 'asin' ? p.asin.toLowerCase().includes(q)
                : searchField === 'sku' ? p.sku.toLowerCase().includes(q)
                : p.title.toLowerCase().includes(q);

            // 2. Status filter
            let matchesStatus = true;
            if (filterStatus === 'published') matchesStatus = p.isPublishedToReal;
            else if (filterStatus === 'not_published') matchesStatus = !p.isPublishedToReal;
            else if (filterStatus === 'active') matchesStatus = p.status === 'active';
            else if (filterStatus === 'paused') matchesStatus = p.status === 'paused';
            else if (filterStatus === 'under_review') matchesStatus = ['under_review', 'not_yet_active', 'payment_required'].includes(p.status);
            else if (filterStatus === 'inactive') matchesStatus = ['inactive', 'closed'].includes(p.status) && !isDeletedByMl(p);
            else if (filterStatus === 'deleted_by_ml') matchesStatus = isDeletedByMl(p);

            // 3. Date filter — against creation or last-update date, per the dropdown
            const dateValue = dateFilterType === 'updated' ? p.updatedDate : p.creationDate;
            const matchesDate = filterDate ? dateValue === filterDate : true;

            return matchesSearch && matchesStatus && matchesDate;
        });
    }, [testProducts, searchField, searchQuery, filterStatus, dateFilterType, filterDate]);

    // Counts for the status pill row — always over the full catalog, not the
    // currently filtered/searched subset, same as ML's own seller panel.
    const statusCounts = useMemo(() => {
        const counts = { active: 0, paused: 0, review: 0, inactive: 0, deletedByMl: 0 };
        for (const p of testProducts) {
            if (isDeletedByMl(p)) { counts.deletedByMl++; continue; }
            if (p.status === 'active') counts.active++;
            else if (p.status === 'paused') counts.paused++;
            else if (['under_review', 'not_yet_active', 'payment_required'].includes(p.status)) counts.review++;
            else if (['inactive', 'closed'].includes(p.status)) counts.inactive++;
        }
        return counts;
    }, [testProducts]);

    // Jumping back to page 1 on a new search/filter avoids landing on a page
    // that no longer has any rows once the filtered set shrinks.
    useEffect(() => {
        setCurrentPage(1);
    }, [searchField, searchQuery, filterStatus, dateFilterType, filterDate]);

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
            const CONCURRENCY = 5;
            let nextIndex = 0;
            const worker = async () => {
                while (nextIndex < withMeliId.length) {
                    const p = withMeliId[nextIndex++];
                    try {
                        const token = await resolveItemToken(p);
                        const item = await meliService.getItem(p.meliId!, token);
                        if (item?.status) {
                            const subStatus = Array.isArray(item.sub_status) ? item.sub_status : [];
                            const changed = item.status !== p.status
                                || JSON.stringify(subStatus) !== JSON.stringify(p.subStatus || []);
                            if (changed) {
                                await api.testProducts.update(p.id, { status: item.status, sub_status: subStatus });
                            }
                        }
                    } catch (e) {
                        console.error(`[Melidrop] Failed to refresh status for ${p.asin}:`, e);
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, withMeliId.length) }, () => worker()));

            const data = await api.testProducts.list();
            setTestProducts(data);
            alert('Sincronización con el Sandbox de Mercado Libre completada.');
        } catch (err) {
            console.error("Sync error:", err);
        } finally {
            setIsSyncing(false);
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

    const handlePublishToReal = async (id: string) => {
        const product = testProducts.find(p => p.id === id);
        if (!product) return;

        if (!product.publishPayload) {
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
            await api.testProducts.update(id, { meli_id: dup.existingItem?.id, is_published_to_real: true });
            setTestProducts(prev => prev.map(p => p.id === id ? { ...p, meliId: dup.existingItem?.id, isPublishedToReal: true } : p));
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
            const payload = product.publishPayload;
            const descriptionText = payload?.description?.plain_text;
            const itemPayload = { ...payload, description: undefined, attributes: sanitizePublishAttributes(payload?.attributes) };

            const result = await meliService.publishItemWithFallbacks(itemPayload, false);

            if (result.error) {
                const causes: string[] = [];
                if (result.cause && Array.isArray(result.cause)) {
                    result.cause.forEach((c: any) => {
                        const field = c.field ? `[${c.field}] ` : '';
                        const msg = c.message || c.description || (c.code ? `código ${c.code}` : null) || JSON.stringify(c);
                        causes.push(`${field}${msg}`);
                    });
                }
                const errorMsg = causes.length > 0
                    ? `${result.error}\n• ${causes.join('\n• ')}`
                    : result.error;
                alert(`Error al publicar:\n${errorMsg}`);
                return;
            }

            // Post description separately (ML requires PUT /items/{id}/description)
            if (result.id && descriptionText) {
                await meliService.postDescription(result.id, descriptionText);
            }

            // Update test product with real meli_id and publication status
            await api.testProducts.update(id, {
                meli_id: result.id,
                is_published_to_real: true
            });

            // Update local state
            setTestProducts(prev => prev.map(p =>
                p.id === id ? { ...p, meliId: result.id, isPublishedToReal: true } : p
            ));

            await trackPublishedProduct(product, result, itemPayload, descriptionText);

            alert(`✅ Producto publicado exitosamente.\nID: ${result.id}\nVer: ${result.permalink || 'En tu panel de MercadoLibre'}`);
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
        if (!confirm(`¿Publicar ${selectedIds.length} producto(s) en tu cuenta REAL de MercadoLibre?`)) return;

        const realCreds = meliService.getCredentials();
        if (!realCreds?.token) {
            alert('No tienes credenciales reales de MercadoLibre conectadas. Ve a Configuración para conectar tu cuenta.');
            return;
        }

        const toPublish = testProducts.filter(p => selectedIds.includes(p.id) && !p.isPublishedToReal);
        let successCount = 0;
        const errors: string[] = [];

        for (const product of toPublish) {
            if (!product.publishPayload) {
                errors.push(`${product.title}: sin payload (re-importar)`);
                continue;
            }
            try {
                // Guard against publishing the same ASIN twice for real.
                const dup = await meliService.checkDuplicate(product.asin);
                if (dup.isDuplicate) {
                    await api.testProducts.update(product.id, { meli_id: dup.existingItem?.id, is_published_to_real: true });
                    setTestProducts(prev => prev.map(p =>
                        p.id === product.id ? { ...p, meliId: dup.existingItem?.id, isPublishedToReal: true } : p
                    ));
                    successCount++;
                    continue;
                }

                const descriptionText = product.publishPayload?.description?.plain_text;
                const itemPayload = { ...product.publishPayload, description: undefined, attributes: sanitizePublishAttributes(product.publishPayload?.attributes) };
                const result = await meliService.publishItemWithFallbacks(itemPayload, false);

                if (result.error) {
                    const causes = result.cause?.map((c: any) => c.message || c.code).join(', ') || result.error;
                    errors.push(`${product.title}: ${causes}`);
                    continue;
                }

                if (result.id && descriptionText) {
                    await meliService.postDescription(result.id, descriptionText);
                }

                await api.testProducts.update(product.id, {
                    meli_id: result.id,
                    is_published_to_real: true
                });
                setTestProducts(prev => prev.map(p =>
                    p.id === product.id ? { ...p, meliId: result.id, isPublishedToReal: true } : p
                ));
                await trackPublishedProduct(product, result, itemPayload, descriptionText);
                successCount++;
            } catch (err: any) {
                errors.push(`${product.title}: ${err.message}`);
            }
        }

        setSelectedIds([]);
        const summary = `✅ Publicados: ${successCount}\n${errors.length > 0 ? `\n❌ Errores (${errors.length}):\n${errors.join('\n')}` : ''}`;
        alert(summary);
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

    const getFilterLabel = () => {
        switch(filterStatus) {
            case 'published': return 'Publicados en MercadoLibre';
            case 'not_published': return 'No publicados en MercadoLibre';
            case 'active': return 'Productos activos';
            case 'paused': return 'Productos pausados';
            case 'under_review': return 'En revisión';
            case 'inactive': return 'Inactivos';
            case 'deleted_by_ml': return 'Eliminados por Mercado Libre';
            default: return 'Todos los productos';
        }
    };

    // Now that handleSync pulls ML's real status instead of a hardcoded 'active',
    // this needs to cover the actual states ML uses — a plain active/paused split
    // would show "Pausado" for an item that's really just pending review. Checked
    // before the plain status switch so a closed+deleted item reads as "Eliminado
    // por ML" instead of just "Cerrado".
    const statusBadge = (p: TestProduct): { label: string; cls: string } => {
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
                                    {/* Date filter: date-type selector + date, like ML's "Actualización ▾ | dd/mm/aaaa" */}
                                    <div className="flex items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                                        <select
                                            value={dateFilterType}
                                            onChange={(e) => setDateFilterType(e.target.value as any)}
                                            className="bg-transparent border-none border-r border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 pl-3 pr-6 py-2 focus:ring-0 cursor-pointer"
                                        >
                                            <option value="created">Creación</option>
                                            <option value="updated">Actualización</option>
                                        </select>
                                        <input
                                            type="date"
                                            value={filterDate}
                                            onChange={(e) => setFilterDate(e.target.value)}
                                            className="bg-transparent border-none text-xs font-bold text-slate-600 dark:text-slate-300 focus:ring-0 px-2 py-2"
                                        />
                                        {filterDate && (
                                            <button onClick={() => setFilterDate('')} className="text-slate-400 hover:text-red-500 pr-2">
                                                <span className="material-symbols-outlined text-[16px]">close</span>
                                            </button>
                                        )}
                                    </div>

                                    {/* Overflow filters (Publicados / No publicados) — native ML statuses live as pills below */}
                                    <div className="relative">
                                        <button
                                            onClick={() => setShowFilters(!showFilters)}
                                            title={getFilterLabel()}
                                            className={`flex items-center justify-center size-9 rounded-lg transition-all border ${showFilters || filterStatus === 'published' || filterStatus === 'not_published' ? 'bg-primary/10 border-primary text-primary' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                                        >
                                            <span className="material-symbols-outlined text-[20px]">filter_alt</span>
                                        </button>

                                        {showFilters && (
                                            <div className="absolute top-full right-0 mt-2 w-64 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 z-50 overflow-hidden">
                                                <button
                                                    onClick={() => { setFilterStatus('all'); setShowFilters(false); }}
                                                    className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterStatus === 'all' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                                >
                                                    Todos los productos
                                                </button>
                                                <button
                                                    onClick={() => { setFilterStatus('published'); setShowFilters(false); }}
                                                    className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterStatus === 'published' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
                                                >
                                                    Publicados en MercadoLibre
                                                </button>
                                                <button
                                                    onClick={() => { setFilterStatus('not_published'); setShowFilters(false); }}
                                                    className={`w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 dark:hover:bg-slate-700 ${filterStatus === 'not_published' ? 'font-black text-primary bg-primary/5' : 'text-slate-600 dark:text-slate-300'}`}
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
                                        {isSyncing ? 'Sincronizando...' : 'Sincronizar Test'}
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
                                ] as { key: SandboxStatusFilter; label: string; count: number }[]).map(s => (
                                    <button
                                        key={s.key}
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
                                        {filteredProducts.length === 0 ? (
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
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <div className="flex flex-col text-xs">
                                                            <a
                                                                href={`https://www.amazon.com/dp/${p.asin}`}
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