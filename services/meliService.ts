import { api } from './api';
import { supabase } from './supabase';
import { Product } from '../types';

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

    private saveCredentials(creds: MeliCredentials) {
        localStorage.setItem('melidrop_meli_credentials', JSON.stringify(creds));
    }

    async getValidToken(): Promise<string | null> {
        const creds = this.getCredentials();
        if (!creds) {
            console.warn("meliService: No credentials found in localStorage");
            return null;
        }

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

            const response = await fetch(`${this.baseUrl}/oauth/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body
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

    async fetchWithAuth(endpoint: string, options: RequestInit = {}) {
        const token = await this.getValidToken();
        if (!token) throw new Error("No valid MercadoLibre token found");

        const targetUrl = `${this.baseUrl}${endpoint}`;

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
            console.warn("MeliService: Token expired (401), refreshing...");
            const newToken = await this.refreshToken();
            if (newToken) {
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
        }
        if (response.status === 403) {
            const errBody = await response.clone().text();
            console.error(`MeliService: Forbidden 403 on ${endpoint}. Error: ${errBody}`);
        }

        return response;
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

            return await response.json();
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
        const itemIds = await this.getUserItemIds((current, total) => {
            if (onProgress) onProgress('searching', current, total);
        });
        const total = itemIds.length;

        let syncedCount = 0;
        const chunkSize = 100;

        for (let i = 0; i < itemIds.length; i += chunkSize) {
            const chunkIds = itemIds.slice(i, i + chunkSize);
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

            try {
                await api.products.bulkUpsert(productsToUpsert);
                syncedCount += productsToUpsert.length;
                if (onProgress) onProgress('syncing', syncedCount, total);
            } catch (e) {
                console.error("MeliService: Error in bulkUpsert:", e);
            }
        }
        return syncedCount;
    }

    async getOrders(limit = 20) {
        const creds = this.getCredentials();
        if (!creds) return [];
        try {
            const { data: { user } } = await supabase.auth.getUser();
            const supabaseUserId = user?.id;

            console.log(`meliService: Fetching orders for seller ${creds.id}`);
            const response = await this.fetchWithAuth(`/orders/search?seller=${creds.id}&limit=${limit}&sort=date_desc`);

            const data = await response.json();
            const results = data.results || [];
            
            // Sync orders to Supabase for persistence and analytics
            if (results.length > 0) {
                const ordersToSync = results.map((o: any) => ({
                    id: o.id.toString(),
                    user_id: supabaseUserId,
                    product_title: o.order_items?.[0]?.item?.title || 'Producto',
                    buyer_name: o.buyer?.nickname || 'Comprador',
                    total: o.payments?.[0]?.net_received_amount || o.total_amount || 0,
                    status: o.status,
                    date: o.date_created ? o.date_created.split('T')[0] : null,
                    amazon_status: 'pending',
                    amazon_asin: o.order_items?.[0]?.item?.seller_custom_field || '',
                    amazon_marketplace: 'MX'
                }));
                
                try {
                    await api.orders.bulkUpsert(ordersToSync);
                } catch (e) {
                    console.warn("MeliService: Could not sync orders to Supabase:", e);
                }
            }

            return results;
        } catch (e) {
            console.error('meliService: Error fetching orders:', e);
            return [];
        }
    }

    async getQuestionsCount() {
        const creds = this.getCredentials();
        if (!creds) return 0;
        try {
            const response = await this.fetchWithAuth(`/questions/search?seller_id=${creds.id}&status=UNANSWERED`);
            const data = await response.json();
            return data.total || 0;
        } catch (e) { return 0; }
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
            console.log("MeliService: Iniciando descarga secuencial para evitar bloqueos...");

            const user = await this.getUserData().catch((e) => { console.error("MeliService: Error fetching user data:", e); return null; });
            await new Promise(r => setTimeout(r, 1000));

            const balance = await this.getBalance().catch((e) => { console.error("MeliService: Error fetching balance:", e); return null; });
            await new Promise(r => setTimeout(r, 1000));

            const orders = await this.getOrders(20).catch((e) => { console.error("MeliService: Error fetching orders:", e); return []; });
            await new Promise(r => setTimeout(r, 1000));

            const unreadCount = await this.getQuestionsCount().catch((e) => { console.error("MeliService: Error fetching unread questions count:", e); return 0; });
            await new Promise(r => setTimeout(r, 1000));

            const unreadMessages = await this.getUnreadMessagesCount().catch((e) => { console.error("MeliService: Error fetching unread messages count:", e); return 0; });
            await new Promise(r => setTimeout(r, 200));

            const itemsBreakdown = await this.getItemsBreakdown().catch((e) => { console.error("MeliService: Error fetching items breakdown:", e); return null; });
            await new Promise(r => setTimeout(r, 200));

            const answeredQuestions = await this.getAnsweredQuestions().catch((e) => { console.error("MeliService: Error fetching answered questions:", e); return []; });

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
                }
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

    async publishItem(itemData: any, isDraft: boolean = false): Promise<any> {
        const creds = this.getCredentials();
        if (!creds) throw new Error("No credentials");
        const body = isDraft ? { ...itemData, status: 'paused' } : itemData;
        const response = await this.fetchWithAuth('/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || JSON.stringify(data));
        return data;
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
            // Search in user's items by custom field (ASIN stored as seller_custom_field)
            const response = await this.fetchWithAuth(`/users/${creds.id}/items/search?seller_custom_field=${asin}&limit=1`);
            if (!response.ok) return { isDuplicate: false };
            const data = await response.json();
            if (data.results && data.results.length > 0) {
                return { isDuplicate: true, existingItem: { id: data.results[0] } };
            }
            return { isDuplicate: false };
        } catch (e) {
            return { isDuplicate: false };
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

    async uploadImage(imageUrl: string): Promise<string | null> {
        try {
            const response = await this.fetchWithAuth('/pictures', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: imageUrl })
            });
            if (!response.ok) return null;
            const data = await response.json();
            return data.id || null;
        } catch (e) {
            return null;
        }
    }
}

export const meliService = new MeliService();
