/**
 * OVHcloud AI Endpoints Proxy
 * 
 * بوابة مجانية للوصول إلى نماذج OVHcloud AI
 * بدون أي مفتاح API، بحد 2 طلب/دقيقة لكل IP.
 * متوافقة مع OpenAI SDK.
 */

// ══════════════════════════════════════════════════════════════════════════
// الإعدادات
// ══════════════════════════════════════════════════════════════════════════
const CONFIG = {
    BASE_URL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    REQUEST_TIMEOUT_MS: 120000, // 120 ثانية (OVHcloud قد يستغرق وقتًا للنماذج الكبيرة)
    DEFAULT_MODEL: 'Qwen3-32B',
};

// ══════════════════════════════════════════════════════════════════════════
// Main Worker Handler
// ══════════════════════════════════════════════════════════════════════════
export default {
    async fetch(request, env, ctx) {
        // ─── 1. CORS Preflight ───
        if (request.method === 'OPTIONS') {
            return new Response('', {
                status: 204,
                headers: corsHeaders(),
            });
        }

        // ─── 2. Health check (GET) ───
        if (request.method === 'GET') {
            return jsonResponse({
                status: 'ok',
                service: 'OVHcloud AI Endpoints Proxy',
                base_url: CONFIG.BASE_URL,
                default_model: CONFIG.DEFAULT_MODEL,
                note: 'Free anonymous tier: 2 requests/minute per IP',
            });
        }

        // ─── 3. Only POST is allowed ───
        if (request.method !== 'POST') {
            return jsonResponse({ error: 'Method not allowed. Use POST.' }, 405);
        }

        // ─── 4. Parse body ───
        let body;
        try {
            body = await request.json();
        } catch (e) {
            return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }

        const prompt = (body.prompt || '').trim();
        const model = (body.model || CONFIG.DEFAULT_MODEL).trim();
        const stream = Boolean(body.stream);

        if (!prompt) {
            return jsonResponse({ error: 'Prompt is required' }, 400);
        }

        // ─── 5. Optional auth token ───
        if (env.AUTH_TOKEN) {
            const auth = request.headers.get('Authorization') || '';
            const token = auth.replace(/^Bearer\s+/i, '').trim();
            if (token !== env.AUTH_TOKEN) {
                return jsonResponse({ error: 'Unauthorized' }, 401);
            }
        }

        // ─── 6. Send request to OVHcloud ───
        try {
            if (stream) {
                return await handleStreamingRequest(model, prompt);
            } else {
                const reply = await handleNonStreamingRequest(model, prompt);
                return jsonResponse({ reply, model });
            }
        } catch (error) {
            return jsonResponse({
                error: error.message || 'OVHcloud AI endpoint is currently unavailable.',
            }, 503);
        }
    },
};

// ══════════════════════════════════════════════════════════════════════════
// Non-Streaming Handler
// ══════════════════════════════════════════════════════════════════════════
async function handleNonStreamingRequest(model, prompt) {
    const response = await fetchWithTimeout(
        `${CONFIG.BASE_URL}/chat/completions`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                temperature: 0.7,
            }),
        },
        CONFIG.REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
            const errData = await response.json();
            errMsg = errData.error?.message || errData.message || errMsg;
        } catch (e) {}
        throw new Error(errMsg);
    }

    const data = await response.json();

    if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content;
    }

    throw new Error('Unexpected response format from OVHcloud');
}

// ══════════════════════════════════════════════════════════════════════════
// Streaming Handler
// ══════════════════════════════════════════════════════════════════════════
async function handleStreamingRequest(model, prompt) {
    const response = await fetchWithTimeout(
        `${CONFIG.BASE_URL}/chat/completions`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'user', content: prompt }],
                stream: true,
                temperature: 0.7,
            }),
        },
        CONFIG.REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
            const errData = await response.json();
            errMsg = errData.error?.message || errData.message || errMsg;
        } catch (e) {}
        throw new Error(errMsg);
    }

    // OVHcloud يُرجع SSE متوافق مع OpenAI مباشرة
    return new Response(response.body, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...corsHeaders(),
        },
    });
}

// ══════════════════════════════════════════════════════════════════════════
// Fetch with timeout
// ══════════════════════════════════════════════════════════════════════════
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
    };
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(),
        },
    });
        }
