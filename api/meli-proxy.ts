import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Solo permitimos POST para mayor seguridad
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { url, method, headers, body } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'Missing URL' });
    }

    try {
        const response = await fetch(url, {
            method: method || 'GET',
            headers: headers || {},
            body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        });

        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
}
