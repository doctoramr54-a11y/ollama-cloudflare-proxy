/**
 * Ollama Cloudflare Proxy - JavaScript Edition
 * 
 * بوابة مجانية للوصول إلى نماذج Ollama المتعددة بدون API Key.
 * تستخدم قائمة خوادم Ollama العامة المعروفة، مع نظام Fallback ذكي.
 */

// ══════════════════════════════════════════════════════════════════════════
// قائمة خوادم Ollama المجانية المتاحة (يتم تجربة كل خادم حتى ينجح أحدها)
// ══════════════════════════════════════════════════════════════════════════
const OLLAMA_ENDPOINTS = [
    'https://ollama.premai.io',
    'https://ollama-nous.abliteration.ai',
    'https://ollama.timelesstech.net',
    'https://ai.ai-apps.chat/api/ollama',
    'https://ollama.abliteration.ai',
    'https://chat.ollama.ai',
];

// ══════════════════════════════════════════════════════════════════════════
// الإعدادات
// ══════════════════════════════════════════════════════════════════════════
const CONFIG = {
    REQUEST_TIMEOUT_MS: 55000, // 55 ثانية لكل خادم
    MAX_PARALLEL_TRIES: 2,     // عدد الخوادم التي تُجرّب بالتوازي في نفس الوقت
    DEFAULT_MODEL: 'llama3.2:3b',
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
                service: 'Ollama Cloudflare Proxy (JS Edition)',
                endpoints_count: OLLAMA_ENDPOINTS.length,
                endpoints: OLLAMA_ENDPOINTS,
            });
        }

        // ─── 3. Only POST is allowed for chat ───
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

        // ─── 6. Try endpoints with fallback ───
        try {
            if (stream) {
                return await handleStreamingRequest(model, prompt);
            } else {
                const reply = await handleNonStreamingRequest(model, prompt);
                return jsonResponse({ reply, model });
            }
        } catch (error) {
            return jsonResponse({
                error: error.message || 'All Ollama endpoints are currently unavailable.',
            }, 503);
        }
    },
};

// ══════════════════════════════════════════════════════════════════════════
// Non-Streaming Handler (يعيد الرد كاملًا مرة واحدة)
// ══════════════════════════════════════════════════════════════════════════
async function handleNonStreamingRequest(model, prompt) {
    const errors = [];

    // جرّب الخوادم بالتوازي (2 في نفس الوقت لتوفير الوقت)
    const batches = chunkArray(OLLAMA_ENDPOINTS, CONFIG.MAX_PARALLEL_TRIES);

    for (const batch of batches) {
        const promises = batch.map(baseUrl =>
            tryOllamaEndpoint(baseUrl, model, prompt, false)
                .then(reply => ({ ok: true, reply, baseUrl }))
                .catch(err => ({ ok: false, error: err.message, baseUrl }))
        );

        const results = await Promise.all(promises);

        for (const result of results) {
            if (result.ok && result.reply) {
                return result.reply;
            }
            errors.push(`${result.baseUrl}: ${result.error}`);
        }
    }

    throw new Error(
        'All Ollama endpoints failed. Last errors: ' + errors.slice(-3).join(' | ')
    );
}

// ══════════════════════════════════════════════════════════════════════════
// Streaming Handler (يعيد الرد بصيغة SSE)
// ══════════════════════════════════════════════════════════════════════════
async function handleStreamingRequest(model, prompt) {
    // جرّب أول خادم ناجح
    let lastError = null;

    for (const baseUrl of OLLAMA_ENDPOINTS) {
        try {
            const ollamaResponse = await fetchOllama(baseUrl, model, prompt, true);

            if (!ollamaResponse.ok) {
                lastError = `HTTP ${ollamaResponse.status}`;
                continue;
            }

            // حوّل بث Ollama إلى SSE متوافق مع OpenAI
            const { readable, writable } = new TransformStream();
            transformOllamaStreamToSSE(ollamaResponse.body, writable, model);

            return new Response(readable, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    ...corsHeaders(),
                },
            });
        } catch (e) {
            lastError = e.message;
            continue;
        }
    }

    throw new Error('All Ollama endpoints failed (streaming). Last: ' + lastError);
}

// ══════════════════════════════════════════════════════════════════════════
// Core: Try a single Ollama endpoint
// ══════════════════════════════════════════════════════════════════════════
async function tryOllamaEndpoint(baseUrl, model, prompt, stream) {
    const response = await fetchOllama(baseUrl, model, prompt, stream);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    if (stream) {
        return response; // ارجع Response كما هو للبث
    }

    // Non-streaming: parse JSON
    const data = await response.json();

    // Ollama يعيد المحتوى في data.message.content
    if (data.message && typeof data.message.content === 'string') {
        return data.message.content;
    }
    // بعض الخوادم تستخدم data.response (للـ /api/generate)
    if (typeof data.response === 'string') {
        return data.response;
    }
    // بعض الخوادم بصيغة OpenAI
    if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content;
    }

    throw new Error('Unexpected response format from Ollama');
}

// ══════════════════════════════════════════════════════════════════════════
// Low-level fetch with timeout
// ══════════════════════════════════════════════════════════════════════════
async function fetchOllama(baseUrl, model, prompt, stream) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'user', content: prompt }],
                stream: stream,
                options: {
                    temperature: 0.7,
                },
            }),
            signal: controller.signal,
        });

        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// Transform Ollama SSE stream to OpenAI-compatible SSE
// ══════════════════════════════════════════════════════════════════════════
function transformOllamaStreamToSSE(ollamaBody, writable, model) {
    const reader = ollamaBody.getReader();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffer = '';

    (async () => {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    try {
                        const json = JSON.parse(trimmed);
                        const content = (json.message && json.message.content) || json.response || '';
                        if (content) {
                            const chunk = {
                                choices: [{ delta: { content: content } }],
                            };
                            await writer.write(
                                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                            );
                        }
                        if (json.done) {
                            await writer.write(encoder.encode('data: [DONE]\n\n'));
                        }
                    } catch (e) {
                        // Ignore malformed lines
                    }
                }
            }
            await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch (err) {
            // Silence stream errors
        } finally {
            try { await writer.close(); } catch (e) {}
        }
    })();
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

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
                }
