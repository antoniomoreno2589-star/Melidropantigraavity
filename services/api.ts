import { supabase } from './supabase';
import { Product, Order, DashboardStats } from '../types';

export const api = {
    products: {
        async list(): Promise<Product[]> {
            let allProducts: any[] = [];
            let from = 0;
            const step = 1000;

            while (true) {
                const { data, error } = await supabase
                    .from('products')
                    .select('*')
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
                lastUpdated: new Date(p.last_updated)
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
                    last_updated: new Date().toISOString()
                }, { onConflict: 'meli_id' });

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
                last_updated: new Date().toISOString()
            }));

            const { error } = await supabase
                .from('products')
                .upsert(payloads, { onConflict: 'meli_id' });

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
                total: o.total,
                status: o.status,
                date: o.date,
                shippingDeadline: o.shipping_deadline,
                amazonStatus: o.amazon_status,
                amazonPurchasePrice: o.amazon_purchase_price,
                amazonAsin: o.amazon_asin,
                amazonMarketplace: o.amazon_marketplace
            }));
        },

        async update(order: Order): Promise<void> {
            const { error } = await supabase
                .from('orders')
                .update({
                    amazon_status: order.amazonStatus,
                    amazon_purchase_price: order.amazonPurchasePrice,
                    status: order.status
                })
                .eq('id', order.id);

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
    }
};
