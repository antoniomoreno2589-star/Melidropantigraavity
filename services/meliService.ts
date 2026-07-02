import { api } from './api';
import { supabase } from './supabase';
import { Product } from '../types';

// Map raw ML order statuses to the narrower set allowed by the DB CHECK
// constraint on orders.status: pending | paid | shipped | delivered | cancelled.
function mapMlStatus(o: any): 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled' {
    if (o.status === 'cancelled') return 'cancelled';
    const ss = o.shipping?.status ?? '';
    if (ss === 'delivered') return 'delivered';
    if (['shipped', 'me2', 'in_transit', 'almost_there'].includes(ss)) return 'shipped';
    if (o.status === 'paid') return 'paid';
    return 'pending';
}

export interface MeliCredentials {
    appId: string;
    secret: string;
    token: string;
    refreshToken: string;
    nickname: string;
    id: number;
    expiresAt: number;
}

class MeliService {
    private baseUrl = 'https://api.mercadolibre.com';
    private statsCache: any = null;
    private lastStatsFetch: number = 0;

    public getCredentials(): MeliCredentials | null {
        const stored = localStorage.getItem('melidrop_meli_credentials');
        return stored ? JSON.parse(stored) : null;
    }

    private async saveCredentials(creds: MeliCredentials) {
        localStorage.setItem('melidrop_meli_credentials', JSON.stringify(creds));

        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            await supabase.from('user_connections').upsert(
                { user_id: user.id, meli_credentials: creds, updated_at: new Date().toISOString() },
                { onConflict: 'user_id' }
            );
        }
    }

    public async syncFromSupabase(): Promise<boolean> {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return false;

        const { data, error } = await supabase
            .from('user_connections')
            .select('meli_credentials')
            .eq('user_id', user.id)
            .maybeSingle();

        if (data?.meli_credentials) {
            localStorage.setItem('melidrop_meli_credentials', JSON.stringify(data.meli_credentials));
            return true;
        }
        return false;
    }

    async getValidToken(): Promise<string | null> {
        const creds = this.getCredentials();
        if (!creds) {
            console.warn("meliService: No credentials found in localStorage");
            const stored = localStorage.getItem('melidrop_meli_credentials');
            console.warn('[Melidrop] Checking localStorage for melidrop_meli_credentials:', {
                exists: !!stored,
                raw: stored ? stored.substring(0, 100) : null
            });
            return null;
        }

        // Debug: show token expiration status
        const expiresIn = creds.expiresAt - Date.now();
        console.log('[Melidrop] getValidToken: Current token status', {
            userId: creds.id,
            expiresIn: Math.round(expiresIn / 1000) + ' seconds',
            isExpired: expiresIn < 0,
            willExpireSoon: expiresIn < 300000 // 5 minutes
        });

        // Refresh if expiring soon (in less than 5 minutes)
        if (Date.now() + 300000 > creds.expiresAt) {
            console.log("meliService: Token expiring soon. Refreshing...");
            return this.refreshToken();
        }

        return creds.token;
    }

    async refreshToken(): Promise<string | null> {
        const creds = this.getCredentials();
        if (!creds) return null;

        try {
            const body = new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: creds.appId,
                client_secret: creds.secret,
                refresh_token: creds.refreshToken
            });

            const response = await fetch('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: `${this.baseUrl}/oauth/token`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                    body: body.toString()
                })
            });

            if (!response.ok) throw new Error('Failed to refresh token');

            const data = await response.json();
            const updatedCreds: MeliCredentials = {
                ...creds,
                token: data.access_token,
                refreshToken: data.refresh_token,
                expiresAt: Date.now() + (data.expires_in * 1000)
            };

            this.saveCredentials(updatedCreds);
            console.log("Meli Token refreshed successfully");
            return data.access_token;
        } catch (error) {
            console.error("Meli Token refresh error:", error);
            return null;
        }
    }

    async fetchWithAuth(endpoint: string, options: RequestInit = {}, customToken?: string) {
        const token = customToken || await this.getValidToken();
        if (!token) throw new Error("No valid MercadoLibre token found");

        const targetUrl = `${this.baseUrl}${endpoint}`;

        // Debug logging
        console.log('[Melidrop] fetchWithAuth:', {
            endpoint,
            hasCustomToken: !!customToken,
            method: options.method || 'GET',
            tokenPrefix: token.substring(0, 10) + '...'
        });

        const response = await fetch('/api/proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: targetUrl,
                method: options.method || 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    ...(options.headers || {})
                },
                body: options.body
            })
        });

        // Breve espera para no saturar el proxy
        await new Promise(r => setTimeout(r, 100));

        if (response.status === 401) {
            // If a customToken was provided it belongs to a different account (e.g. test user).
            // Refreshing the real user's token and retrying would publish to the wrong account.
            console.error('[Melidrop] Got 401 response:', { endpoint, hasCustomToken: !!customToken });
            if (customToken) {
                throw new Error('Token de usuario de prueba expirado. Reconecta el usuario en Configuración.');
            }

            console.warn("MeliService: Real account token expired (401), attempting to refresh...");
            const newToken = await this.refreshToken();
            if (!newToken) {
                throw new Error('Token expirado y no se pudo renovar automáticamente. Por favor, reconecta tu cuenta de MercadoLibre en Perfil.');
            }

            console.log('[Melidrop] Token refreshed successfully, retrying request...');
            return fetch('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: targetUrl,
                    method: options.method || 'GET',
                    headers: {
                        'Authorization': `Bearer ${newToken}`,
                        ...(options.headers || {})
                    },
                    body: options.body
                })
            });
        }
        if (response.status === 403) {
            const errBody = await response.clone().text();
            console.error(`MeliService: Forbidden 403 on ${endpoint}. Error: ${errBody}`);
        }

        return response;
    }

    // Mercado Pago's payment resource (api.mercadopago.com, not api.mercadolibre.com)
    // has the itemized charges_details ML's own Orders API omits — including
    // tax_withholding-isr / tax_withholding-iva, the exact ISR/IVA the seller's app shows.
    private async fetchMpPaymentTax(paymentId: number | string): Promise<number> {
        try {
            const token = await this.getValidToken();
            if (!token) return 0;
            const res = await fetch('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: `https://api.mercadopago.com/v1/payments/${paymentId}`,
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${token}` },
                })
            });
            if (!res.ok) return 0;
            const data = await res.json();
            const charges: any[] = data?.charges_details ?? [];
            return charges
                .filter(c => c?.type === 'tax')
                .reduce((s, c) => s + ((Number(c?.amounts?.original) || 0) - (Number(c?.amounts?.refunded) || 0)), 0);
        } catch {
            return 0;
        }
    }

    async getUserData() {
        const creds = this.getCredentials();
        if (!creds) return null;

        const response = await this.fetchWithAuth(`/users/${creds.id}`);
        const data = await response.json();
        return data;
    }

    async getBalance() {
        const creds = this.getCredentials();
        if (!creds) return null;

        try {
            console.log("MeliService: Fetching balance for user", creds.id);
            const response = await this.fetchWithAuth(`/users/${creds.id}/mercadopago_account/balance`);

            if (!response.ok) {
                console.warn(`MeliService: Balance Primary API failed (${response.status}). Trying variant 2...`);
                // Variante 2: Sin el prefijo /users/ID
                const response2 = await this.fetchWithAuth(`/mercadopago_account/balance`);
                if (response2.ok) {
                    return await response2.json();
                }

                if (response.status === 403 || response2.status === 403) {
                    console.error("MeliService: Forbidden 403 on balance endpoints.");
                    return { total_amount: null, error: 'forbidden' };
                }

                // Fallback redundante: intentar sacar del perfil de usuario
                const userData = await this.getUserData();
                const mpInfo = userData?.mercadopago_account || userData?.mercadopago_info || userData?.credit || userData;
                if (mpInfo && (mpInfo.balance !== undefined || mpInfo.consumed !== undefined)) {
                    console.log("MeliService: Fallback balance found in user profile");
                    return {
                        total_amount: mpInfo.balance || mpInfo.consumed || 0,
                        balance: mpInfo.balance || mpInfo.consumed || 0,
                        available_balance: mpInfo.available_balance || mpInfo.balance || 0,
                        unavailable_balance: 0
                    };
                }
                return { total_amount: null, error: 'unavailable' };
            }

            const raw = await response.json();
            console.log("MeliService: Balance raw response:", JSON.stringify(raw));
            // Normalize field names — API may return 'total' or 'total_amount'
            return {
                total_amount: raw.total_amount ?? raw.total ?? raw.balance ?? null,
                available_balance: raw.available_balance ?? raw.available ?? raw.available_amount ?? null,
                unavailable_balance: raw.unavailable_balance ?? raw.unavailable ?? raw.blocked ?? null,
            };
        } catch (e: any) {
            console.error("MeliService: Exception in getBalance:", e.message || e);
            return { total_amount: null, error: 'exception' };
        }
    }

    async getUserItemIds(onProgress?: (current: number, total: number) => void): Promise<string[]> {
        const creds = this.getCredentials();
        if (!creds) return [];

        let allIds: string[] = [];
        const scanStatus = async (status?: string) => {
            let statusIds: string[] = [];
            let scrollId: string | undefined = undefined;
            const limit = 100;

            while (true) {
                try {
                    const url = `/users/${creds.id}/items/search?search_type=scan&limit=${limit}${status ? `&status=${status}` : ''}${scrollId ? `&scroll_id=${scrollId}` : ''}`;
                    const response = await this.fetchWithAuth(url);
                    const data = await response.json();

                    if (data.results && data.results.length > 0) {
                        statusIds = [...statusIds, ...data.results];
                        scrollId = data.scroll_id;
                        if (onProgress) onProgress(allIds.length + statusIds.length, 20000);
                        if (!data.scroll_id || data.results.length === 0) break;
                    } else {
                        break;
                    }
                } catch (err) {
                    break;
                }
            }
            return statusIds;
        };

        const genericIds = await scanStatus();
        allIds = [...new Set([...allIds, ...genericIds])];
        const reviewIds = await scanStatus('under_review');
        allIds = [...new Set([...allIds, ...reviewIds])];

        return allIds;
    }

    async getItemsDetails(itemIds: string[]): Promise<any[]> {
        if (itemIds.length === 0) return [];
        let allDetails: any[] = [];
        const chunkSize = 20;

        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunk = itemIds.slice(i, i + chunkSize);
            try {
                const response = await this.fetchWithAuth(`/items?ids=${chunk.join(',')}`);
                const data = await response.json();
                const details = data.filter((res: any) => res.code === 200).map((res: any) => res.body);
                allDetails = [...allDetails, ...details];
            } catch (e) {
                console.error("meliService: Error fetching items details chunk", e);
            }
        }
        return allDetails;
    }

    async syncItemsToSupabase(onProgress?: (phase: string, current: number, total: number) => void): Promise<number> {
        try {
            const creds = this.getCredentials();
            if (!creds) {
                throw new Error('No estás autenticado con Mercado Libre. Por favor configura tus credenciales en Configuración.');
            }

            const itemIds = await this.getUserItemIds((current, total) => {
                if (onProgress) onProgress('searching', current, total);
            });
            console.log(`[Melidrop] Found ${itemIds.length} published items to sync`);
            const total = itemIds.length;

            if (itemIds.length === 0) {
                console.log(`[Melidrop] No items to sync, skipping`);
                return 0;
            }

            let syncedCount = 0;
            const chunkSize = 100;

            for (let i = 0; i < itemIds.length; i += chunkSize) {
                const chunkIds = itemIds.slice(i, i + chunkSize);
                console.log(`[Melidrop] Fetching details for chunk ${Math.floor(i / chunkSize) + 1}, ids: ${chunkIds.length}`);
                const items = await this.getItemsDetails(chunkIds);

                const productsToUpsert: any[] = items.map(item => {
                    const statusMap: Record<string, string> = {
                        'active': 'active',
                        'paused': 'paused',
                    };

                    let skuAttr = item.attributes?.find((attr: any) => attr.id === 'SELLER_SKU');
                    if (!skuAttr && item.variations) {
                        for (const v of item.variations) {
                            skuAttr = v.attributes?.find((attr: any) => attr.id === 'SELLER_SKU');
                            if (skuAttr) break;
                        }
                    }
                    const sku = skuAttr?.value_name || item.seller_custom_field || item.id;

                    return {
                        title: item.title,
                        sku: sku,
                        meli_id: item.id,
                        price_mxn: item.price,
                        cost_usd: 0,
                        stock_meli: item.available_quantity,
                        stock_provider: 0,
                        status: statusMap[item.status] || 'draft',
                        image_url: item.thumbnail ? item.thumbnail.replace("-I.jpg", "-V.jpg") : undefined
                    };
                });

                if (productsToUpsert.length > 0) {
                    console.log(`[Melidrop] Upserting ${productsToUpsert.length} products to Supabase`);
                    try {
                        await api.products.bulkUpsert(productsToUpsert);
                        syncedCount += productsToUpsert.length;
                        console.log(`[Melidrop] Upserted successfully, total synced: ${syncedCount}`);
                        if (onProgress) onProgress('syncing', syncedCount, total);
                    } catch (e) {
                        console.error("[Melidrop] Error in bulkUpsert:", e);
                        throw e;
                    }
                }
            }
            console.log(`[Melidrop] Sync completed: ${syncedCount} products synced`);
            return syncedCount;
        } catch (err: any) {
            console.error("[Melidrop] syncItemsToSupabase failed:", err);
            let errorMessage = 'Sync failed';
            if (err instanceof Error) {
                errorMessage = err.message;
            } else if (typeof err === 'string') {
                errorMessage = err;
            } else if (err?.message) {
                errorMessage = err.message;
            } else if (err?.error_message) {
                errorMessage = err.error_message;
            } else if (err?.description) {
                errorMessage = err.description;
            }
            throw new Error(errorMessage);
        }
    }

    async getOrders(limit = 20) {
        const creds = this.getCredentials();
        if (!creds) return [];
        try {
            const { data: { user } } = await supabase.auth.getUser();
            const supabaseUserId = user?.id;

            console.log(`meliService: Fetching orders for seller ${creds.id}`);
            const response = await this.fetchWithAuth(`/orders/search?seller=${creds.id}&limit=${limit}&sort=date_desc`);

            if (!response.ok) {
                if (response.status === 403) throw new Error('forbidden');
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            const results = data.results || [];

            // Sync orders to Supabase for persistence and analytics
            if (results.length > 0) {
                // Fallback ASIN source when ML order payload omits seller_custom_field.
                const meliIdToAsin = await api.products.getMeliIdToAsinMap().catch(() => ({} as Record<string, string>));
                const ordersToSync = results.map((o: any) => {
                    const pmt = o.payments?.[0];
                    const totalAmt    = o.total_amount ?? 0;
                    // Refund from a return, mediation, or cancellation, whatever the cause.
                    const refundAmount = (o.payments ?? [])
                        .reduce((s: number, p: any) => s + (Number(p?.transaction_amount_refunded) || 0), 0);
                    // If refunded WITHOUT ever being delivered, the sale never really
                    // completed — no real commission/shipping was charged, no real cost.
                    const wasDelivered = Array.isArray(o.tags) && o.tags.includes('delivered');
                    const voidedBeforeDelivery = refundAmount > 0 && !wasDelivered;

                    let fee = 0, shipping = 0, netIncome = 0;
                    if (!voidedBeforeDelivery) {
                        // ML selling commission: order_items[].sale_fee is the reliable source.
                        const saleFeeSum = (o.order_items ?? [])
                            .reduce((s: number, it: any) => s + (Number(it?.sale_fee) || 0), 0);
                        const feeFromPmt = pmt?.marketplace_fee
                            ?? (Array.isArray(pmt?.fee_details)
                                ? pmt.fee_details.reduce((s: number, f: any) => s + (Number(f?.amount) || 0), 0)
                                : null);
                        fee = saleFeeSum > 0 ? saleFeeSum : (feeFromPmt ?? 0);
                        shipping = (pmt?.shipping_cost > 0 ? pmt.shipping_cost : null)
                            ?? (o.shipping?.base_cost > 0 ? o.shipping.base_cost : null)
                            ?? 0;
                        netIncome = totalAmt - fee - shipping - refundAmount;
                    }
                    const effectiveRefund = voidedBeforeDelivery ? 0 : refundAmount;
                    return {
                        id: o.id.toString(),
                        user_id: supabaseUserId,
                        product_title: o.order_items?.[0]?.item?.title || 'Producto',
                        buyer_name: o.buyer?.nickname || 'Comprador',
                        total:         totalAmt,
                        net_income:    netIncome,
                        ml_commission: fee,
                        shipping_cost: shipping,
                        refund_amount: effectiveRefund,
                        meli_item_id:  o.order_items?.[0]?.item?.id ?? null,
                        quantity: (o.order_items ?? [])
                            .filter((it: any) => !o.order_items?.[0]?.item?.id || it?.item?.id === o.order_items[0].item.id)
                            .reduce((sum: number, it: any) => sum + (it?.quantity ?? 0), 0) || 1,
                        status: mapMlStatus(o),
                        date: o.date_created ? o.date_created.split('T')[0] : null,
                        amazon_asin: o.order_items?.[0]?.item?.seller_custom_field
                            || o.order_items?.[0]?.item?.seller_sku
                            || (o.order_items?.[0]?.item?.id ? meliIdToAsin[String(o.order_items[0].item.id)] : '')
                            || '',
                        amazon_marketplace: 'MX'
                    };
                });

                try {
                    await api.orders.bulkUpsert(ordersToSync);
                } catch (e: any) {
                    console.warn("MeliService: Could not sync orders to Supabase:", e?.message, e);
                }
            }

            return results;
        } catch (e: any) {
            console.error('meliService: Error fetching orders:', e);
            if (e.message === 'forbidden') throw e;
            return [];
        }
    }

    // Paginated order fetch with optional date range (ISO strings with timezone).
    // ML Orders API filter params: order.date_created.from / order.date_created.to
    async getOrdersFiltered(dateFrom?: string, dateTo?: string): Promise<any[]> {
        const creds = this.getCredentials();
        if (!creds) return [];
        try {
            let allOrders: any[] = [];
            let offset = 0;
            const limit = 50;

            while (allOrders.length < 300) {
                let url = `/orders/search?seller=${creds.id}&limit=${limit}&offset=${offset}&sort=date_desc`;
                if (dateFrom) url += `&order.date_created.from=${encodeURIComponent(dateFrom)}`;
                if (dateTo)   url += `&order.date_created.to=${encodeURIComponent(dateTo)}`;

                const res = await this.fetchWithAuth(url);
                if (!res.ok) break;

                const data = await res.json();
                const results: any[] = data.results || [];
                allOrders = [...allOrders, ...results];
                if (results.length < limit) break;
                offset += limit;
            }

            // orders/search omits marketplace_fee and shipping_cost from payments.
            // Fetch individual order detail (8 concurrent) to get complete fee data.
            const BATCH = 8;
            const enriched: any[] = [];
            for (let i = 0; i < allOrders.length; i += BATCH) {
                const slice = allOrders.slice(i, i + BATCH);
                const details = await Promise.all(
                    slice.map(async o => {
                        try {
                            const r = await this.fetchWithAuth(`/orders/${o.id}`);
                            return r.ok ? await r.json() : o;
                        } catch { return o; }
                    })
                );
                enriched.push(...details);
            }

            // For orders where shipping is still 0, ML bills it via the shipment record.
            const needsShipment = enriched.filter(o =>
                !(o.payments?.[0]?.shipping_cost > 0) &&
                !(o.shipping?.base_cost > 0) &&
                o.shipping?.id &&
                o.status !== 'cancelled'
            );
            if (needsShipment.length > 0) {
                const costMap: Record<string, number> = {};
                for (let i = 0; i < needsShipment.length; i += BATCH) {
                    const batch = needsShipment.slice(i, i + BATCH);
                    const results = await Promise.allSettled(
                        batch.map(async o => {
                            // /shipments/{id}/costs is the canonical seller-cost endpoint:
                            // senders[].cost is what ML actually charges the seller (net of
                            // discounts). Prefer it; fall back to the shipment record.
                            try {
                                const rc = await this.fetchWithAuth(`/shipments/${o.shipping.id}/costs`);
                                if (rc.ok) {
                                    const c = await rc.json();
                                    const sellerCost = Array.isArray(c?.senders)
                                        ? c.senders.reduce((s: number, x: any) => s + (Number(x?.cost) || 0), 0)
                                        : 0;
                                    if (sellerCost > 0) return { id: o.id, cost: sellerCost };
                                }
                            } catch { /* fall through to shipment record */ }
                            const r = await this.fetchWithAuth(`/shipments/${o.shipping.id}`);
                            if (!r.ok) return null;
                            const d = await r.json();
                            // shipping_option.list_cost is the actual seller charge;
                            // base_cost is gross before ML's internal adjustments
                            const cc = d.cost_components ?? {};
                            const netCost = Math.max(0,
                                (d.shipping_option?.list_cost ?? d.base_cost ?? 0)
                                - (cc.loyal_discount ?? 0)
                                - (cc.special_discount ?? 0)
                                - (cc.gap_discount ?? 0)
                                + (cc.compensation ?? 0)
                            );
                            return { id: o.id, cost: netCost };
                        })
                    );
                    for (const r of results) {
                        if (r.status === 'fulfilled' && r.value) costMap[r.value.id] = r.value.cost;
                    }
                }
                for (const o of enriched) {
                    if (costMap[o.id] != null) {
                        if (!o.shipping) o.shipping = {};
                        o.shipping.base_cost = costMap[o.id];
                    }
                }
            }

            // Return shipping ML charges the seller on a devolución. For a return
            // shipment the seller is the RECEIVER, so receiver.cost (when receiver == seller)
            // is what ML charged. Sum across every return leg of each return claim where
            // this seller is the respondent (the buyer returned the product to us).
            try {
                const sellerId = Number(creds.id);
                const returnClaims: any[] = [];
                for (const st of ['opened', 'closed']) {
                    let offset = 0;
                    while (offset < 500) {
                        const cr = await this.fetchWithAuth(`/post-purchase/v1/claims/search?type=returns&status=${st}&limit=50&offset=${offset}`);
                        if (!cr.ok) break;
                        const cd = await cr.json();
                        const data: any[] = cd?.data ?? [];
                        returnClaims.push(...data);
                        if (data.length < 50) break;
                        offset += 50;
                    }
                }
                const myClaims = returnClaims.filter((c: any) =>
                    (c?.players ?? []).some((p: any) => p.role === 'respondent' && Number(p.user_id) === sellerId));

                const returnCostByOrder: Record<string, number> = {};
                await Promise.all(myClaims.map(async (c: any) => {
                    try {
                        const rr = await this.fetchWithAuth(`/post-purchase/v2/claims/${c.id}/returns`);
                        if (!rr.ok) return;
                        const rd = await rr.json();
                        let cost = 0;
                        await Promise.all((rd?.shipments ?? []).map(async (s: any) => {
                            if (!s?.shipment_id) return;
                            const sc = await this.fetchWithAuth(`/shipments/${s.shipment_id}/costs`);
                            if (!sc.ok) return;
                            const scd = await sc.json();
                            if (Number(scd?.receiver?.user_id) === sellerId && Number(scd?.receiver?.cost) > 0) {
                                cost += Number(scd.receiver.cost);
                            }
                        }));
                        if (cost <= 0) return;
                        const ids = new Set<string>([String(c.resource_id)]);
                        for (const oo of (rd?.orders ?? [])) if (oo?.order_id) ids.add(String(oo.order_id));
                        for (const oid of ids) returnCostByOrder[oid] = Math.max(returnCostByOrder[oid] ?? 0, cost);
                    } catch { /* skip this claim */ }
                }));

                for (const o of enriched) {
                    const cost = returnCostByOrder[String(o.id)]
                        ?? (o.pack_id ? returnCostByOrder[String(o.pack_id)] : undefined);
                    if (cost != null && cost > 0) { o._returnShippingCost = cost; o._hasReturn = true; }
                }
            } catch { /* claims not accessible — returns handled manually */ }

            // ISR/IVA withholding: the ML Orders API never exposes this (payments[].taxes_amount
            // is always 0), but Mercado Pago's own payment resource has the itemized
            // charges_details the seller's app shows. Fetch per payment, batched.
            const paymentIds = enriched
                .map(o => o.payments?.[0]?.id)
                .filter((id: any) => id != null);
            if (paymentIds.length > 0) {
                const taxByPayment: Record<string, number> = {};
                for (let i = 0; i < paymentIds.length; i += BATCH) {
                    const batch = paymentIds.slice(i, i + BATCH);
                    const results = await Promise.allSettled(
                        batch.map(async (pid: any) => ({ pid, tax: await this.fetchMpPaymentTax(pid) }))
                    );
                    for (const r of results) {
                        if (r.status === 'fulfilled') taxByPayment[String(r.value.pid)] = r.value.tax;
                    }
                }
                for (const o of enriched) {
                    const pid = o.payments?.[0]?.id;
                    if (pid != null && taxByPayment[String(pid)] != null) {
                        o._taxAmount = taxByPayment[String(pid)];
                    }
                }
            }

            return enriched;
        } catch (e) {
            console.error('meliService.getOrdersFiltered error:', e);
            return [];
        }
    }

    async getQuestionsCount() {
        const creds = this.getCredentials();
        if (!creds) return 0;
        try {
            const response = await this.fetchWithAuth(`/questions/search?seller_id=${creds.id}&status=UNANSWERED`);
            if (!response.ok) {
                if (response.status === 403) throw new Error('forbidden');
                return 0;
            }
            const data = await response.json();
            return data.total || 0;
        } catch (e: any) {
            if (e.message === 'forbidden') throw e;
            return 0;
        }
    }

    async getUnreadMessagesCount() {
        const creds = this.getCredentials();
        if (!creds) return 0;
        const variants = [`/messages/unread?role=seller`, `/messages/packs/unread?role=seller`];
        for (const url of variants) {
            try {
                console.log(`MeliService: Trying unread count from ${url}`);
                const response = await this.fetchWithAuth(url);
                if (response.ok) {
                    const data = await response.json();
                    if (data.unread_count !== undefined) {
                        console.log(`MeliService: Unread count found (${data.unread_count}) using ${url}`);
                        return data.unread_count;
                    }
                }
            } catch (e) { }
        }
        return 0;
    }

    async getItemsBreakdown() {
        const creds = this.getCredentials();
        if (!creds) return { total: 0, active: 0, paused: 0, premium: 0, classic: 0 };
        try {
            const userData = await this.getUserData();
            const siteId = userData?.site_id || 'MLM';
            let premiumId = 'gold_pro', classicId = 'gold_special';
            try {
                const ltRes = await this.fetchWithAuth(`/sites/${siteId}/listing_types`);
                const ltData = await ltRes.json();
                const premium = ltData.find((l: any) => l.id.includes('pro') || l.id.includes('premium'));
                const classic = ltData.find((l: any) => l.id.includes('special') || l.id.includes('classic'));
                if (premium) premiumId = premium.id;
                if (classic) classicId = classic.id;
            } catch (e) { if (siteId === 'MLA') premiumId = 'gold_special'; }

            const [activeRes, pausedRes, premiumRes, classicRes] = await Promise.all([
                this.fetchWithAuth(`/users/${creds.id}/items/search?status=active&limit=0`).catch(() => null),
                this.fetchWithAuth(`/users/${creds.id}/items/search?status=paused&limit=0`).catch(() => null),
                this.fetchWithAuth(`/users/${creds.id}/items/search?status=active&listing_type_id=${premiumId}&limit=0`).catch(() => null),
                this.fetchWithAuth(`/users/${creds.id}/items/search?status=active&listing_type_id=${classicId}&limit=0`).catch(() => null)
            ]);

            const active = activeRes ? await activeRes.json() : { paging: { total: 0 } };
            const paused = pausedRes ? await pausedRes.json() : { paging: { total: 0 } };
            const premium = premiumRes ? await premiumRes.json() : { paging: { total: 0 } };
            const classic = classicRes ? await classicRes.json() : { paging: { total: 0 } };

            return {
                total: (active.paging?.total || 0) + (paused.paging?.total || 0),
                active: active.paging?.total || 0,
                paused: paused.paging?.total || 0,
                premium: premium.paging?.total || 0,
                classic: classic.paging?.total || 0
            };
        } catch (e) { return { total: 0, active: 0, paused: 0, premium: 0, classic: 0 }; }
    }

    async getQuestions(status = 'UNANSWERED') {
        const creds = this.getCredentials();
        if (!creds) return [];
        try {
            const response = await this.fetchWithAuth(`/questions/search?seller_id=${creds.id}&status=${status}&limit=20&sort=date_created_desc`);
            const data = await response.json();
            const questions = data.questions || data.results || [];

            const questionsWithItems = await Promise.all(
                questions.map(async (q: any) => {
                    if (q.item_id) {
                        try {
                            const item = await this.getItem(q.item_id);
                            return { ...q, item };
                        } catch (e) {
                            console.warn(`Failed to fetch item ${q.item_id}:`, e);
                        }
                    }
                    return q;
                })
            );

            if (questions.length === 0 && status === 'UNANSWERED') {
                console.log("MeliService: No unanswered questions, tried fetching any recent questions as fallback...");
                const fallbackResponse = await this.fetchWithAuth(`/questions/search?seller_id=${creds.id}&limit=5`);
                const fallbackData = await fallbackResponse.json();
                return fallbackData.questions || fallbackData.results || [];
            }

            return questionsWithItems;
        } catch (e) {
            console.error('Error fetching questions:', e);
            return [];
        }
    }

    async getAnsweredQuestions(limit = 20) {
        return this.getQuestions('ANSWERED');
    }

    async getMessages(limit = 20) {
        const creds = this.getCredentials();
        if (!creds) return [];

        const endpoints = [
            `/messages/search?seller_id=${creds.id}&role=seller`,
            `/conversations/search?seller_id=${creds.id}&limit=${limit}`,
            `/messages/packs/search?seller_id=${creds.id}&role=seller`,
        ];

        let allMessages: any[] = [];
        for (const url of endpoints) {
            try {
                console.log(`MeliService: Fetching messages from ${url}`);
                const response = await this.fetchWithAuth(url);

                if (!response.ok) {
                    console.warn(`MeliService: Failed to fetch messages from ${url} (${response.status})`);
                    continue;
                }

                const data = await response.json();
                const results = data.results || data.messages || data.conversations || [];

                const processed = results.map((m: any) => ({
                    ...m,
                    unread: m.unread === true || m.status === 'unread' || m.read === false || (m.unread_count && m.unread_count > 0)
                }));

                if (processed.length > 0) {
                    console.log(`MeliService: Metodo ${url} devolvió ${processed.length} mensajes.`);
                    allMessages = [...allMessages, ...processed];
                }
            } catch (e) {
                console.error("MeliService: Error in message loop:", e);
                continue;
            }
            await new Promise(r => setTimeout(r, 500));
        }

        const unique = new Map();
        allMessages.forEach(m => {
            const id = m.pack_id || m.id;
            if (id && !unique.has(id.toString())) {
                unique.set(id.toString(), m);
            }
        });

        return Array.from(unique.values());
    }

    async getItem(itemId: string) {
        if (!itemId) return null;
        try {
            const response = await this.fetchWithAuth(`/items/${itemId}`);
            return await response.json();
        } catch (e) { return null; }
    }

    async getItems(itemIds: string[]) {
        if (!itemIds || !itemIds.length) return [];
        try {
            const cleanIds = [...new Set(itemIds.filter(id => !!id))];
            if (!cleanIds.length) return [];
            const response = await this.fetchWithAuth(`/items?ids=${cleanIds.join(',')}`);
            return await response.json();
        } catch (e) { return []; }
    }

    async getClaims(limit = 10) {
        const creds = this.getCredentials();
        if (!creds) return [];
        try {
            const response = await this.fetchWithAuth(`/claims/search?seller_id=${creds.id}&limit=${limit}`);
            const data = await response.json();
            return data.results || [];
        } catch (e) { return []; }
    }

    private calculateAverageResponseTime(questions: any[]) {
        if (!questions || questions.length === 0) return 0;
        let totalDiff = 0, count = 0;
        questions.forEach(q => {
            if (q.answer && q.date_created && q.answer.date_created) {
                totalDiff += (new Date(q.answer.date_created).getTime() - new Date(q.date_created).getTime());
                count++;
            }
        });
        return count === 0 ? 0 : Math.round((totalDiff / count) / 60000);
    }

    async getDashboardMetrics() {
        if (this.statsCache && (Date.now() - this.lastStatsFetch < 60000)) {
            console.log("MeliService: Devolviendo métricas desde caché.");
            return this.statsCache;
        }
        try {
            console.log("MeliService: Iniciando descarga paralela de métricas...");

            const permissionErrors: string[] = [];

            const [user, balance, orders, unreadCount, unreadMessages, itemsBreakdown, answeredQuestions] = await Promise.all([
                this.getUserData().catch((e) => { console.error("MeliService: Error fetching user data:", e); return null; }),
                this.getBalance().catch((e) => { console.error("MeliService: Error fetching balance:", e); return null; }),
                this.getOrders(20).catch((e) => {
                    console.error("MeliService: Error fetching orders:", e);
                    if (e.message === 'forbidden') permissionErrors.push('orders');
                    return [];
                }),
                this.getQuestionsCount().catch((e) => {
                    console.error("MeliService: Error fetching unread questions count:", e);
                    if (e.message === 'forbidden') permissionErrors.push('questions');
                    return 0;
                }),
                this.getUnreadMessagesCount().catch((e) => { console.error("MeliService: Error fetching unread messages count:", e); return 0; }),
                this.getItemsBreakdown().catch((e) => { console.error("MeliService: Error fetching items breakdown:", e); return null; }),
                this.getAnsweredQuestions().catch((e) => { console.error("MeliService: Error fetching answered questions:", e); return []; }),
            ]);

            const now = new Date();
            const todayISO = now.toISOString().split('T')[0];
            const todayLocal = now.toLocaleDateString('en-CA');

            const ordersToday = (orders || []).filter((o: any) => {
                const date = o.date_created || o.date_closed;
                if (!date) return false;
                const dateParts = date.split('T')[0];
                return dateParts === todayISO || dateParts === todayLocal;
            });

            const salesToday = ordersToday.length;
            const incomeToday = ordersToday.reduce((acc: number, o: any) => acc + (o.total_amount || 0), 0);
            const responseTime = this.calculateAverageResponseTime(answeredQuestions);

            this.statsCache = {
                user: {
                    ...user,
                    nickname: user?.nickname || 'Vendedor',
                    reputation: user?.seller_reputation?.level_id || 'unknown',
                    power_seller_status: user?.seller_reputation?.power_seller_status,
                    transactions: user?.seller_reputation?.transactions?.total || 1,
                    completed: user?.seller_reputation?.transactions?.completed || 0
                },
                balance: {
                    total: balance?.total_amount ?? balance?.balance ?? user?.mercadopago_account?.balance ?? 0,
                    available: balance?.available_balance ?? balance?.available ?? user?.mercadopago_account?.available_balance ?? 0,
                    unavailable: balance?.unavailable_balance ?? balance?.unavailable ?? 0,
                    error: (balance as any)?.error || null
                },
                itemsCount: itemsBreakdown?.total || 0,
                itemsBreakdown: itemsBreakdown || { total: 0, active: 0, paused: 0, premium: 0, classic: 0 },
                stats: {
                    salesToday, incomeToday, avgTicket: salesToday > 0 ? incomeToday / salesToday : 0,
                    questionsUnanswered: unreadCount || 0,
                    messagesUnread: unreadMessages || 0,
                    questionsToday: unreadCount || 0,
                    responseTime: responseTime > 0 ? `${responseTime} min` : 'N/A'
                },
                permissionErrors
            };
            this.lastStatsFetch = Date.now();
            return this.statsCache;
        } catch (error) {
            console.error("MeliService: Error en DashboardMetrics:", error);
            throw error;
        }
    }

    async answerQuestion(questionId: string | number, text: string) {
        const creds = this.getCredentials();
        if (!creds) throw new Error("No credentials");

        const response = await this.fetchWithAuth(`/answers`, {
            method: 'POST',
            body: JSON.stringify({
                question_id: questionId,
                text: text
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Failed to answer question: ${err}`);
        }

        return await response.json();
    }

    async sendMessage(packId: string | number, text: string, receiverId: string | number) {
        const creds = this.getCredentials();
        if (!creds) throw new Error("No credentials");

        const response = await this.fetchWithAuth(`/messages/packs/${packId}/sellers/${creds.id}?tag=post_sale`, {
            method: 'POST',
            body: JSON.stringify({
                from: { user_id: creds.id },
                to: { user_id: receiverId },
                text: text
            })
        });

        if (!response.ok) {
            const err = await response.text();
            console.error("SendMessage Error", err);
            throw new Error("No se pudo enviar el mensaje.");
        }

        return await response.json();
    }

    decrementUnansweredCount() {
        if (this.statsCache && this.statsCache.stats && this.statsCache.stats.questionsUnanswered > 0) {
            this.statsCache.stats.questionsUnanswered--;
            if (this.statsCache.stats.questionsToday > 0) {
                this.statsCache.stats.questionsToday--;
            }
        }
    }

    // ─── IMPORTER METHODS ────────────────────────────────────────────

    async publishItem(itemData: any, isDraft: boolean = false, customToken?: string): Promise<any> {
        const creds = customToken ? null : this.getCredentials();
        if (!creds && !customToken) throw new Error("No credentials");

        // Debug logging
        console.log('[Melidrop] publishItem called:', {
            hasCustomToken: !!customToken,
            hasRealCreds: !!creds,
            credsUserId: creds?.id,
            isDraft
        });

        const body = isDraft ? { ...itemData, status: 'paused' } : itemData;
        const response = await this.fetchWithAuth('/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }, customToken);
        const data = await response.json();
        if (!response.ok) {
            console.error('[Melidrop] ML publish error:', JSON.stringify(data, null, 2));
            console.error('[Melidrop] ML publish payload:', JSON.stringify(body, null, 2));
            return { error: data.message || "Error al publicar", cause: data.cause, raw: data };
        }
        return data;
    }

    async postDescription(meliId: string, descriptionText: string, customToken?: string): Promise<void> {
        try {
            // First attempt: plain_text format
            const response = await this.fetchWithAuth(`/items/${meliId}/description`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plain_text: descriptionText })
            }, customToken);

            if (!response.ok) {
                const errData = await response.text();
                let errJson: any = {};
                try { errJson = JSON.parse(errData); } catch { /* ignore */ }

                // Some categories don't accept plain_text — retry with HTML format
                if (errJson.error === 'DESCRIPTION_PLAIN_TEXT_NOT_ALLOWED' || response.status === 400) {
                    console.warn(`[Melidrop] plain_text rejected, retrying with HTML for item ${meliId}`);
                    const htmlBody = descriptionText
                        .split('\n')
                        .map(line => line.trim() ? `<p>${line.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` : '')
                        .join('');

                    const retryResponse = await this.fetchWithAuth(`/items/${meliId}/description`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: htmlBody, type: 'text/html' })
                    }, customToken);

                    if (!retryResponse.ok) {
                        const retryErr = await retryResponse.text();
                        console.error(`[Melidrop] Failed to post description (HTML fallback ${retryResponse.status}):`, retryErr);
                    } else {
                        console.log(`[Melidrop] Description posted successfully (HTML) for item ${meliId}`);
                    }
                    return;
                }

                console.error(`[Melidrop] Failed to post description (${response.status}):`, errData);
                return;
            }

            console.log(`[Melidrop] Description posted successfully for item ${meliId}`);
        } catch (e) {
            console.error('[Melidrop] Error posting description:', e);
        }
    }

    async validateItem(itemData: any): Promise<{ valid: boolean; errors: any[] }> {
        // MercadoLibre has a validation endpoint
        try {
            const response = await this.fetchWithAuth('/items/validate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(itemData)
            });
            if (response.status === 200 || response.status === 204) {
                return { valid: true, errors: [] };
            }
            const data = await response.json();
            return { valid: false, errors: data.cause || data.error ? [data] : [] };
        } catch (e) {
            return { valid: false, errors: [{ message: 'Error de validación' }] };
        }
    }

    async checkDuplicate(asin: string): Promise<{ isDuplicate: boolean; existingItem?: any }> {
        const creds = this.getCredentials();
        if (!creds) return { isDuplicate: false };
        try {
            // Search all items (no status filter) — a freshly published item may be
            // 'under_review' or 'inactive' and wouldn't appear in active/paused only.
            const response = await this.fetchWithAuth(`/users/${creds.id}/items/search?seller_custom_field=${asin}&limit=5`);
            if (!response.ok) return { isDuplicate: false };
            const data = await response.json();
            if (data.results && data.results.length > 0) {
                for (const itemId of data.results) {
                    const itemRes = await this.fetchWithAuth(`/items/${itemId}?attributes=seller_custom_field,status`);
                    if (!itemRes.ok) continue;
                    const itemData = await itemRes.json();
                    // Consider any non-closed item as a duplicate
                    if (itemData.seller_custom_field === asin && itemData.status !== 'closed') {
                        console.log(`[Melidrop] Duplicate found: ${asin} → ${itemId} (status: ${itemData.status})`);
                        return { isDuplicate: true, existingItem: { id: itemId, status: itemData.status } };
                    }
                }
            }
            return { isDuplicate: false };
        } catch (e) {
            return { isDuplicate: false };
        }
    }

    async updateItem(meliId: string, payload: { price?: number; available_quantity?: number; description?: { plain_text: string }; title?: string }): Promise<{ ok: boolean; error?: string }> {
        try {
            const response = await this.fetchWithAuth(`/items/${meliId}`, {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                return { ok: false, error: data?.message ?? `HTTP ${response.status}` };
            }
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: e.message };
        }
    }

    async getCategoryAttributes(categoryId: string): Promise<any[]> {
        try {
            const response = await this.fetchWithAuth(`/categories/${categoryId}/attributes`);
            if (!response.ok) return [];
            return await response.json();
        } catch (e) {
            return [];
        }
    }

    async searchCatalog(query: string, categoryId?: string, siteId: string = 'MLM'): Promise<string | null> {
        try {
            const encoded = encodeURIComponent(query.substring(0, 60));
            const catParam = categoryId ? `&category_id=${categoryId}` : '';
            const response = await this.fetchWithAuth(
                `/products/search?site_id=${siteId}&q=${encoded}${catParam}&limit=1&status=active`
            );
            if (!response.ok) return null;
            const data = await response.json();
            const firstResult = data.results?.[0];
            return firstResult?.id || null;
        } catch (e) {
            console.error('[Melidrop] Catalog search failed:', e);
            return null;
        }
    }

    async predictCategory(searchTerm: string, siteId: string = 'MLM'): Promise<any[]> {
        try {
            const encoded = encodeURIComponent(searchTerm);
            const response = await this.fetchWithAuth(`/sites/${siteId}/domain_discovery/search?q=${encoded}&limit=5`);
            if (!response.ok) return [];
            return await response.json();
        } catch (e) {
            return [];
        }
    }

    async uploadImage(imageUrl: string, customToken?: string): Promise<string | null> {
        try {
            const response = await this.fetchWithAuth('/pictures', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: imageUrl })
            }, customToken);
            if (!response.ok) return null;
            const data = await response.json();
            return data.id || null;
        } catch (e) {
            return null;
        }
    }

    async uploadImageBinary(dataUrl: string, customToken?: string): Promise<string | null> {
        try {
            const [header, base64] = dataUrl.split(',');
            const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
            const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            const formData = new FormData();
            formData.append('file', new Blob([binary], { type: mimeType }), 'image.png');
            const response = await this.fetchWithAuth('/pictures/items/upload', {
                method: 'POST',
                body: formData
            }, customToken);
            if (!response.ok) return null;
            const data = await response.json();
            return data.id || null;
        } catch {
            return null;
        }
    }

    async createTestUser(siteId: string = 'MLM'): Promise<any> {
        try {
            const response = await this.fetchWithAuth('/users/test_user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ site_id: siteId })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Error al crear usuario de prueba");
            return data;
        } catch (e) {
            console.error("Meli createTestUser error:", e);
            throw e;
        }
    }

    /**
     * Authenticate a test user (resource owner password flow) and return their access_token.
     * ML test users use this flow: https://developers.mercadolibre.com/es_ar/autenticacion-y-autorizacion
     */
    async loginTestUser(testUserEmail: string, testUserPassword: string): Promise<string | null> {
        const creds = this.getCredentials();
        if (!creds) throw new Error("No hay credenciales de MercadoLibre configuradas");

        try {
            const body = new URLSearchParams({
                grant_type: 'password',
                client_id: creds.appId,
                client_secret: creds.secret,
                username: testUserEmail,
                password: testUserPassword
            });
            const response = await fetch('/api/proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: `${this.baseUrl}/oauth/token`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                    body: body.toString()
                })
            });
            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Error de autenticación: ${err}`);
            }
            const data = await response.json();
            return data.access_token || null;
        } catch (e: any) {
            console.error("meliService.loginTestUser error:", e.message);
            throw e;
        }
    }

    async autoRefreshTestUserToken(): Promise<string | null> {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return null;

            const { data } = await supabase
                .from('user_connections')
                .select('meli_test_user')
                .eq('user_id', user.id)
                .maybeSingle();

            const testUser = data?.meli_test_user;
            if (!testUser?.email || !testUser?.password) return null;

            // Check if token is still fresh (has more than 1 hour left)
            if (testUser.token_expires_at) {
                const expiresAt = new Date(testUser.token_expires_at).getTime();
                if (Date.now() + 3600000 < expiresAt) {
                    return testUser.access_token || null;
                }
            }

            // Re-login with saved credentials
            const newToken = await this.loginTestUser(testUser.email, testUser.password);
            if (!newToken) return null;

            const updatedTestUser = {
                ...testUser,
                access_token: newToken,
                token_expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString()
            };

            await supabase
                .from('user_connections')
                .upsert({ user_id: user.id, meli_test_user: updatedTestUser }, { onConflict: 'user_id' });

            console.log('[Melidrop] Test user token auto-refreshed successfully');
            return newToken;
        } catch (e: any) {
            console.warn('[Melidrop] Auto-refresh test user token failed:', e.message);
            return null;
        }
    }

    async deleteItem(itemId: string): Promise<boolean> {
        try {
            // Step 1: Set status to closed
            const res1 = await this.fetchWithAuth(`/items/${itemId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'closed' })
            });

            if (!res1.ok) {
                const err = await res1.json();
                console.error("Meli deleteItem step 1 failed:", err);
            }

            // Step 2: Delete (hidden from user)
            const res2 = await this.fetchWithAuth(`/items/${itemId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deleted: 'true' })
            });

            return res2.ok;
        } catch (e) {
            console.error("Meli deleteItem exception:", e);
            return false;
        }
    }
}

export const meliService = new MeliService();
