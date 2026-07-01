import { supabase } from './supabase';
import { Product, Order, Expense, DashboardStats } from '../types';

export const api = {
    products: {
        async list(): Promise<Product[]> {
            let allProducts: any[] = [];
            let from = 0;
            const step = 100; // Smaller pages load faster

            while (true) {
                const { data, error } = await supabase
                    .from('products')
                    // Select only needed columns (not *)
                    .select('id, title, sku, asin, meli_id, price_mxn, cost_usd, stock_provider, stock_meli, status, image_url, last_updated, in_updater, amazon_seller_count, sold_by_amazon')
                    .order('last_updated', { ascending: false })
                    .range(from, from + step - 1);

                if (error) throw error;
                if (!data || data.length === 0) break;

                allProducts = [...allProducts, ...data];
                if (data.length < step) break;
                from += step;
            }

            // Transform snake_case to camelCase mapping matches interfaces
            return allProducts.map(p => ({
                id: p.id,
                title: p.title,
                sku: p.sku,
                asin: p.asin,
                meliId: p.meli_id,
                priceMXN: p.price_mxn,
                costUSD: p.cost_usd,
                stockProvider: p.stock_provider,
                stockMeli: p.stock_meli,
                status: p.status,
                imageUrl: p.image_url,
                lastUpdated: new Date(p.last_updated),
                inUpdater: p.in_updater ?? false,
                amazonSellerCount: p.amazon_seller_count ?? null,
                soldByAmazon: p.sold_by_amazon ?? null,
                amazonStock: null,
            }));
        },

        async update(product: Product): Promise<void> {
            const { error } = await supabase
                .from('products')
                .update({
                    title: product.title,
                    sku: product.sku,
                    price_mxn: product.priceMXN,
                    cost_usd: product.costUSD,
                    stock_provider: product.stockProvider,
                    stock_meli: product.stockMeli,
                    status: product.status,
                    image_url: product.imageUrl,
                    last_updated: new Date().toISOString()
                })
                .eq('id', product.id);

            if (error) throw error;
        },

        async create(product: Omit<Product, 'id' | 'lastUpdated'>): Promise<Product> {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error("User not authenticated");

            const { data, error } = await supabase
                .from('products')
                .insert({
                    user_id: user.id,
                    title: product.title,
                    sku: product.sku,
                    asin: product.asin,
                    meli_id: product.meliId,
                    price_mxn: product.priceMXN,
                    cost_usd: product.costUSD,
                    stock_provider: product.stockProvider,
                    stock_meli: product.stockMeli,
                    status: product.status,
                    image_url: product.imageUrl,
                    in_updater: true,
                })
                .select()
                .single();

            if (error) throw error;

            return {
                id: data.id,
                title: data.title,
                sku: data.sku,
                asin: data.asin,
                meliId: data.meli_id,
                priceMXN: data.price_mxn,
                costUSD: data.cost_usd,
                stockProvider: data.stock_provider,
                stockMeli: data.stock_meli,
                status: data.status,
                imageUrl: data.image_url,
                lastUpdated: new Date(data.last_updated)
            };
        },
        async upsertByMeliId(product: Partial<Product>): Promise<void> {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error("User not authenticated");

            const { error } = await supabase
                .from('products')
                .upsert({
                    user_id: user.id,
                    title: product.title,
                    sku: product.sku,
                    asin: product.asin,
                    meli_id: product.meliId,
                    price_mxn: product.priceMXN,
                    cost_usd: product.costUSD,
                    stock_provider: product.stockProvider || 0,
                    stock_meli: product.stockMeli || 0,
                    status: product.status,
                    image_url: product.imageUrl,
                    last_updated: new Date().toISOString(),
                    in_updater: true,
                }, { onConflict: 'meli_id' });

            if (error) throw error;
        },
        // Single lightweight query: ASIN (stored as sku) → currency for Amazon link routing.
        async getCurrencyMap(): Promise<Record<string, 'USD' | 'MXN'>> {
            const { data, error } = await supabase
                .from('products')
                .select('sku, currency');

            if (error) throw error;

            const map: Record<string, 'USD' | 'MXN'> = {};
            for (const row of data ?? []) {
                if (row.sku) map[row.sku] = row.currency === 'MXN' ? 'MXN' : 'USD';
            }
            return map;
        },

        // Maps a ML listing id (meli_id) to its ASIN/SKU. Used to resolve the ASIN of an
        // order when ML's order payload doesn't include seller_custom_field (e.g. items
        // with variations, or listings where the field wasn't returned).
        async getMeliIdToAsinMap(): Promise<Record<string, string>> {
            const { data, error } = await supabase
                .from('products')
                .select('meli_id, asin, sku');

            if (error) throw error;

            const map: Record<string, string> = {};
            for (const row of data ?? []) {
                const asin = row.asin || row.sku;
                if (row.meli_id && asin) map[String(row.meli_id)] = asin;
            }
            return map;
        },

        async toggleUpdater(id: string, inUpdater: boolean): Promise<void> {
            const { error } = await supabase
                .from('products')
                .update({ in_updater: inUpdater })
                .eq('id', id);
            if (error) throw error;
        },

        async bulkToggleUpdater(ids: string[], inUpdater: boolean): Promise<void> {
            const { error } = await supabase
                .from('products')
                .update({ in_updater: inUpdater })
                .in('id', ids);
            if (error) throw error;
        },

        async bulkUpsert(products: Partial<Product>[]): Promise<void> {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error("User not authenticated");

            const payloads = products.map(p => ({
                user_id: user.id,
                title: p.title,
                sku: p.sku,
                asin: p.asin,
                meli_id: (p as any).meli_id,
                price_mxn: (p as any).price_mxn,
                cost_usd: (p as any).cost_usd || 0,
                stock_provider: (p as any).stock_provider || 0,
                stock_meli: (p as any).stock_meli || 0,
                status: p.status,
                image_url: (p as any).image_url,
                last_updated: new Date().toISOString(),
                // in_updater is NOT set here — sync must not override user's manual selection.
                // New products default to false (DB default), existing products keep their value.
            }));

            const { error } = await supabase
                .from('products')
                .upsert(payloads, { onConflict: 'meli_id' });

            if (error) throw error;
        },

        async listPaginated(
            page: number,
            pageSize: number,
            filters: { status?: string; search?: string; searchCategory?: 'title' | 'sku' | 'meliId' }
        ): Promise<{ products: Product[]; total: number }> {
            let query = supabase
                .from('products')
                .select('id, title, sku, asin, meli_id, price_mxn, cost_usd, stock_provider, stock_meli, status, image_url, last_updated, in_updater, amazon_seller_count, sold_by_amazon', { count: 'exact' })
                .order('last_updated', { ascending: false });

            if (filters.status && filters.status !== 'all') {
                if (filters.status === 'under_review') {
                    query = query.in('status', ['under_review', 'not_yet_active', 'payment_required']);
                } else {
                    query = query.eq('status', filters.status);
                }
            }

            if (filters.search) {
                const s = `%${filters.search}%`;
                if (filters.searchCategory === 'sku') query = query.ilike('sku', s);
                else if (filters.searchCategory === 'meliId') query = query.ilike('meli_id', s);
                else query = query.ilike('title', s);
            }

            const { data, error, count } = await query.range((page - 1) * pageSize, page * pageSize - 1);
            if (error) throw error;

            return {
                products: (data ?? []).map(p => ({
                    id: p.id,
                    title: p.title,
                    sku: p.sku,
                    asin: p.asin,
                    meliId: p.meli_id,
                    priceMXN: p.price_mxn,
                    costUSD: p.cost_usd,
                    stockProvider: p.stock_provider,
                    stockMeli: p.stock_meli,
                    status: p.status,
                    imageUrl: p.image_url,
                    lastUpdated: new Date(p.last_updated),
                    inUpdater: p.in_updater ?? false,
                    amazonSellerCount: p.amazon_seller_count ?? null,
                    soldByAmazon: p.sold_by_amazon ?? null,
                    amazonStock: null,
                })),
                total: count ?? 0,
            };
        },

        async getStatusCounts(): Promise<{ active: number; paused: number; under_review: number; inactive: number; closed: number }> {
            const [activeR, pausedR, reviewR, inactiveR, closedR] = await Promise.all([
                supabase.from('products').select('*', { count: 'exact', head: true }).eq('status', 'active'),
                supabase.from('products').select('*', { count: 'exact', head: true }).eq('status', 'paused'),
                supabase.from('products').select('*', { count: 'exact', head: true }).in('status', ['under_review', 'not_yet_active', 'payment_required']),
                supabase.from('products').select('*', { count: 'exact', head: true }).eq('status', 'inactive'),
                supabase.from('products').select('*', { count: 'exact', head: true }).eq('status', 'closed'),
            ]);
            return {
                active: activeR.count ?? 0,
                paused: pausedR.count ?? 0,
                under_review: reviewR.count ?? 0,
                inactive: inactiveR.count ?? 0,
                closed: closedR.count ?? 0,
            };
        },

        async bulkDelete(ids: string[]): Promise<void> {
            const { error } = await supabase.from('products').delete().in('id', ids);
            if (error) throw error;
        },

        async bulkUpdateStatus(ids: string[], status: string): Promise<void> {
            const { error } = await supabase.from('products').update({ status }).in('id', ids);
            if (error) throw error;
        },

        async bulkUpdateStock(ids: string[], stockMeli: number): Promise<void> {
            const { error } = await supabase.from('products').update({ stock_meli: stockMeli }).in('id', ids);
            if (error) throw error;
        }
    },

    orders: {
        async list(): Promise<Order[]> {
            const { data, error } = await supabase
                .from('orders')
                .select('*')
                .order('date', { ascending: false });

            if (error) throw error;

            return data.map(o => ({
                id: o.id,
                productTitle: o.product_title,
                buyerName: o.buyer_name,
                total: o.total ?? 0,
                netIncome: o.net_income ?? o.total ?? 0,
                mlCommission: o.ml_commission ?? 0,
                shippingCost: o.shipping_cost ?? 0,
                meliItemId: o.meli_item_id ?? '',
                quantity: o.quantity ?? 1,
                status: o.status,
                date: o.date,
                shippingDeadline: o.shipping_deadline,
                amazonStatus: o.amazon_status ?? 'pending',
                amazonPurchasePrice: o.amazon_purchase_price,
                amazonAsin: o.amazon_asin ?? '',
                amazonMarketplace: o.amazon_marketplace ?? 'MX',
                hasReturn: o.has_return ?? false,
                returnShippingCost: o.return_shipping_cost ?? 0,
            }));
        },

        async listWithDateRange(dateFrom: string, dateTo: string): Promise<Order[]> {
            const { data, error } = await supabase
                .from('orders')
                .select('*')
                .gte('date', dateFrom)
                .lte('date', dateTo)
                .order('date', { ascending: false });

            if (error) throw error;

            return (data ?? []).map(o => ({
                id: o.id,
                productTitle: o.product_title ?? '',
                buyerName: o.buyer_name ?? '',
                total: o.total ?? 0,
                netIncome: o.net_income ?? o.total ?? 0,
                mlCommission: o.ml_commission ?? 0,
                shippingCost: o.shipping_cost ?? 0,
                meliItemId: o.meli_item_id ?? '',
                quantity: o.quantity ?? 1,
                status: o.status ?? 'pending',
                date: o.date ?? '',
                shippingDeadline: o.shipping_deadline ?? '',
                amazonStatus: o.amazon_status ?? 'pending',
                amazonPurchasePrice: o.amazon_purchase_price,
                amazonAsin: o.amazon_asin ?? '',
                amazonMarketplace: o.amazon_marketplace ?? 'MX',
                hasReturn: o.has_return ?? false,
                returnShippingCost: o.return_shipping_cost ?? 0,
            }));
        },

        async update(order: Order): Promise<void> {
            const { error } = await supabase
                .from('orders')
                .update({
                    amazon_status: order.amazonStatus,
                    amazon_purchase_price: order.amazonPurchasePrice,
                    return_shipping_cost: order.returnShippingCost,
                    status: order.status
                })
                .eq('id', order.id);

            if (error) throw error;
        },

        // Auto-detected return shipping (from ML claims). Applied outside bulkUpsert so it
        // never clobbers a manual entry on orders where ML hasn't finalized the charge.
        async setReturnInfo(updates: { id: string; cost: number }[]): Promise<void> {
            await Promise.all(updates.map(u =>
                supabase.from('orders')
                    .update({ return_shipping_cost: u.cost, has_return: true })
                    .eq('id', u.id)
            ));
        },

        async bulkUpsert(orders: any[]): Promise<void> {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error("User not authenticated");

            const payloads = orders.map(o => ({
                user_id: user.id,
                ...o
            }));

            // ignoreDuplicates: false so ML financial fields (net_income, ml_commission)
            // update on re-sync. amazon_status / amazon_purchase_price are excluded from
            // sync payloads so they are never touched by the ON CONFLICT SET clause.
            const { error } = await supabase
                .from('orders')
                .upsert(payloads, { onConflict: 'id', ignoreDuplicates: false });

            if (error) throw error;
        }
    },

    sync: {
        async getLastSync(): Promise<{ finished_at: string; items_synced: number } | null> {
            const { data, error } = await supabase
                .from('sync_logs')
                .select('finished_at, items_synced')
                .eq('status', 'success')
                .order('finished_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error) throw error;
            return data;
        },

        async startSync(): Promise<string> {
            const { data: { user } } = await supabase.auth.getUser();
            const { data, error } = await supabase
                .from('sync_logs')
                .insert({
                    status: 'running',
                    user_id: user?.id
                })
                .select('id')
                .single();

            if (error) throw error;
            return data.id;
        },

        async finishSync(id: string, itemsSynced: number, error?: string): Promise<void> {
            const { error: err } = await supabase
                .from('sync_logs')
                .update({
                    status: error ? 'failed' : 'success',
                    finished_at: new Date().toISOString(),
                    items_synced: itemsSynced,
                    error_message: error
                })
                .eq('id', id);

            if (err) throw err;
        }
    },

    testProducts: {
        async list(): Promise<any[]> {
            const { data, error } = await supabase
                .from('test_products')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            return data.map(p => ({
                id: p.id,
                title: p.title,
                asin: p.asin,
                sku: p.sku,
                priceMXN: p.price_mxn,
                costUSD: p.cost_usd,
                stockProvider: p.stock_provider,
                stockMeli: p.stock_meli,
                status: p.status,
                imageUrl: p.image_url,
                category: p.category,
                meliId: p.meli_id,
                publishPayload: p.publish_payload,
                isPublishedToReal: p.is_published_to_real,
                creationDate: new Date(p.created_at).toISOString().split('T')[0]
            }));
        },

        async create(product: any): Promise<void> {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error("User not authenticated");

            const { error } = await supabase
                .from('test_products')
                .insert({
                    user_id: user.id,
                    title: product.title,
                    asin: product.asin,
                    sku: product.sku,
                    price_mxn: product.price_mxn,
                    cost_usd: product.cost_usd,
                    stock_provider: product.stock_provider || 0,
                    stock_meli: product.stock_meli || 0,
                    status: product.status || 'active',
                    image_url: product.image_url,
                    category: product.category,
                    meli_id: product.meli_id,
                    publish_payload: product.publish_payload
                });

            if (error) throw error;
        },

        async update(id: string, updates: any): Promise<void> {
            const { error } = await supabase
                .from('test_products')
                .update(updates)
                .eq('id', id);
            if (error) throw error;
        },

        async delete(id: string): Promise<void> {
            const { error } = await supabase
                .from('test_products')
                .delete()
                .eq('id', id);
            if (error) throw error;
        },

        async clearAll(): Promise<void> {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;
            const { error } = await supabase
                .from('test_products')
                .delete()
                .eq('user_id', user.id);
            if (error) throw error;
        }
    },

    expenses: {
        async listRange(fromYM: string, toYM: string): Promise<Expense[]> {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error('Not authenticated');

            const { data, error } = await supabase
                .from('expenses')
                .select('*')
                .eq('user_id', user.id)
                .gte('year_month', fromYM)
                .lte('year_month', toYM)
                .order('year_month', { ascending: true })
                .order('created_at', { ascending: true });

            if (error) throw error;
            return (data ?? []).map(e => ({
                id: e.id,
                concept: e.concept,
                amount: e.amount,
                period: e.period,
                year_month: e.year_month,
            }));
        },

        async create(data: { concept: string; amount: number; period?: string; year_month: string }): Promise<Expense> {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error('Not authenticated');

            const { data: row, error } = await supabase
                .from('expenses')
                .insert({
                    user_id: user.id,
                    concept: data.concept,
                    amount: data.amount,
                    period: data.period ?? 'Mensual',
                    year_month: data.year_month,
                })
                .select()
                .single();

            if (error) throw error;
            return { id: row.id, concept: row.concept, amount: row.amount, period: row.period, year_month: row.year_month };
        },

        async delete(id: number): Promise<void> {
            const { error } = await supabase
                .from('expenses')
                .delete()
                .eq('id', id);
            if (error) throw error;
        }
    }
};
