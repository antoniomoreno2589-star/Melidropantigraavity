import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const MELI_API_URL = "https://api.mercadolibre.com"

serve(async (req) => {
    const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // 1. Initialize Sync Log
    const { data: log, error: logError } = await supabase
        .from("sync_logs")
        .insert({ status: "running" })
        .select("id")
        .single()

    const logId = log?.id

    try {
        // 2. Get MELI Credentials from DB/Vault
        // For simplicity here, we assume there's a meli_credentials table
        const { data: creds, error: credsError } = await supabase
            .from("meli_credentials")
            .select("*")
            .single()

        if (credsError || !creds) throw new Error("Credentials not found")

        // 3. Phase 1: High-capacity Scan for IDs
        let allIds: string[] = []
        let scrollId = undefined
        const limit = 100

        while (true) {
            const url = `${MELI_API_URL}/users/${creds.meli_user_id}/items/search?search_type=scan&limit=${limit}${scrollId ? `&scroll_id=${scrollId}` : ''}`
            const resp = await fetch(url, {
                headers: { "Authorization": `Bearer ${creds.access_token}` }
            })
            const data = await resp.json()

            if (data.results && data.results.length > 0) {
                allIds = [...allIds, ...data.results]
                scrollId = data.scroll_id
                if (!data.scroll_id || allIds.length >= (data.paging?.total || 999999)) break
            } else break
        }

        // 4. Phase 2: Under Review items
        const revResp = await fetch(`${MELI_API_URL}/users/${creds.meli_user_id}/items/search?status=under_review&limit=50`, {
            headers: { "Authorization": `Bearer ${creds.access_token}` }
        })
        const revData = await revResp.json()
        if (revData.results) {
            allIds = [...new Set([...allIds, ...revData.results])]
        }

        // 5. Fetch Details and Batch Upsert (Simplified Chunking)
        let syncedCount = 0
        const chunkSize = 50
        for (let i = 0; i < allIds.length; i += chunkSize) {
            const chunkIds = allIds.slice(i, i + chunkSize)
            const detailsUrl = `${MELI_API_URL}/items?ids=${chunkIds.join(",")}`
            const detailsResp = await fetch(detailsUrl, {
                headers: { "Authorization": `Bearer ${creds.access_token}` }
            })
            const items = await detailsResp.json()

            const payloads = items.map((itemObj: any) => {
                const item = itemObj.body
                return {
                    meli_id: item.id,
                    title: item.title,
                    sku: item.attributes?.find((a: any) => a.id === "SELLER_SKU")?.value_name || item.seller_custom_field || item.id,
                    price_mxn: item.price,
                    stock_meli: item.available_quantity,
                    status: item.status,
                    image_url: item.thumbnail,
                    last_updated: new Date().toISOString()
                }
            })

            await supabase.from("products").upsert(payloads, { onConflict: "meli_id" })
            syncedCount += payloads.length
        }

        // 6. Success
        await supabase.from("sync_logs").update({
            status: "success",
            finished_at: new Date().toISOString(),
            items_synced: syncedCount
        }).eq("id", logId)

        return new Response(JSON.stringify({ success: true, count: syncedCount }), { headers: { "Content-Type": "application/json" } })

    } catch (err: any) {
        if (logId) {
            await supabase.from("sync_logs").update({
                status: "failed",
                finished_at: new Date().toISOString(),
                error_message: err.message
            }).eq("id", logId)
        }
        return new Response(JSON.stringify({ error: err.message }), { status: 500 })
    }
})
