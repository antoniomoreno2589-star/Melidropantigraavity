import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const MELI_API_URL = "https://api.mercadolibre.com"

serve(async (req) => {
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    console.log("Starting master sync...");

    try {
        // 1. Get all users with Meli credentials
        const { data: connections, error: connError } = await supabase
            .from("user_connections")
            .select("user_id, meli_credentials")
            .not("meli_credentials", "is", null);

        if (connError) throw connError;
        if (!connections || connections.length === 0) {
            return new Response(JSON.stringify({ success: true, message: "No users to sync" }));
        }

        let totalSynced = 0;
        let errors = [];

        for (const conn of connections) {
            const userId = conn.user_id;
            const creds = conn.meli_credentials as any;

            if (!creds || !creds.id || !creds.token) continue;

            console.log(`Syncing user: ${userId} (${creds.nickname || 'Unknown'})`);

            try {
                // TODO: Handle token refresh if expired (simplified for now)
                const accessToken = creds.token;

                // Scan for IDs
                let allIds: string[] = [];
                let scrollId = undefined;
                const limit = 100;

                while (true) {
                    const searchUrl = `${MELI_API_URL}/users/${creds.id}/items/search?search_type=scan&limit=${limit}${scrollId ? `&scroll_id=${scrollId}` : ''}`;
                    const resp = await fetch(searchUrl, {
                        headers: { "Authorization": `Bearer ${accessToken}` }
                    });
                    const data = await resp.json();

                    if (data.results && data.results.length > 0) {
                        allIds = [...allIds, ...data.results];
                        scrollId = data.scroll_id;
                        if (!data.scroll_id || allIds.length >= (data.paging?.total || 999999)) break;
                    } else break;
                }

                // Fetch details and upsert
                const chunkSize = 50;
                for (let i = 0; i < allIds.length; i += chunkSize) {
                    const chunkIds = allIds.slice(i, i + chunkSize);
                    const detailsUrl = `${MELI_API_URL}/items?ids=${chunkIds.join(",")}`;
                    const detailsResp = await fetch(detailsUrl, {
                        headers: { "Authorization": `Bearer ${accessToken}` }
                    });
                    const items = await detailsResp.json();

                    const payloads = items.map((itemObj: any) => {
                        const item = itemObj.body;
                        return {
                            user_id: userId,
                            meli_id: item.id,
                            title: item.title,
                            sku: item.attributes?.find((a: any) => a.id === "SELLER_SKU")?.value_name || item.seller_custom_field || item.id,
                            price_mxn: item.price,
                            stock_meli: item.available_quantity,
                            status: item.status,
                            image_url: item.thumbnail,
                            currency: item.currency_id || 'MXN',
                            last_updated: new Date().toISOString()
                        };
                    });

                    await supabase.from("products").upsert(payloads, { onConflict: "meli_id" });
                    totalSynced += payloads.length;
                }
            } catch (userErr: any) {
                console.error(`Error syncing user ${userId}:`, userErr);
                errors.push({ userId, error: userErr.message });
            }
        }

        // 2. Log finished
        await supabase.from("sync_logs").insert({
            status: errors.length > 0 ? "partial_success" : "success",
            finished_at: new Date().toISOString(),
            items_synced: totalSynced,
            error_message: errors.length > 0 ? JSON.stringify(errors) : null
        });

        return new Response(JSON.stringify({ success: true, synced: totalSynced, errors }), {
            headers: { "Content-Type": "application/json" }
        });

    } catch (err: any) {
        console.error("Master sync error:", err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
});
