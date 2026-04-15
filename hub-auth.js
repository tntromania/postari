// ══════════════════════════════════════════════════════════════
// hub-auth.js — Modul partajat de TOATE sub-aplicațiile Viralio
// Pune acest fișier în root-ul fiecărei aplicații (lângă server.js)
// .env necesar:
//   HUB_URL=https://hub.viralio.ro
//   INTERNAL_API_KEY=aceeași_cheie_ca_pe_hub
// ══════════════════════════════════════════════════════════════

const HUB_URL          = process.env.HUB_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

if (!HUB_URL)          { console.error('❌ HUB_URL lipsește din .env!');          process.exit(1); }
if (!INTERNAL_API_KEY) { console.error('❌ INTERNAL_API_KEY lipsește din .env!'); process.exit(1); }

// Cache scurt (30s) pentru a nu bombarda HUB-ul la fiecare request
const tokenCache = new Map();
const CACHE_TTL  = 30 * 1000;

const callHub = async (endpoint, body) => {
    const response = await fetch(`${HUB_URL}${endpoint}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(8000)
    });
    const data = await response.json();
    if (!response.ok) {
        const err  = new Error(data.error || `Hub error ${response.status}`);
        err.status = response.status;
        err.data   = data;
        throw err;
    }
    return data;
};

const authenticate = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Trebuie să fii logat!' });

    try {
        const cached = tokenCache.get(token);
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            req.userId = cached.userId;
            req.user   = cached.user;
            return next();
        }

        const result = await callHub('/api/internal/verify-token', { token });
        req.userId   = result.userId;
        req.user     = result.user;
        tokenCache.set(token, { userId: result.userId, user: result.user, ts: Date.now() });
        next();
    } catch (e) {
        return res.status(e.status || 401).json({ error: e.message || 'Sesiune expirată.' });
    }
};

const hubAPI = {
    useCredits:   async (userId, amount)  => callHub('/api/internal/use-credits',    { userId, amount }),
    useVoiceChars: async (userId, amount) => callHub('/api/internal/use-voice-chars', { userId, amount }),
    checkCredits: async (userId)          => callHub('/api/internal/check-credits',   { userId }),
    getUserInfo:  async (userId)          => callHub('/api/internal/user-info',       { userId })
};

setInterval(() => {
    const now = Date.now();
    for (const [key, val] of tokenCache) {
        if (now - val.ts > CACHE_TTL) tokenCache.delete(key);
    }
}, 60000);

module.exports = { authenticate, hubAPI };
