// ══════════════════════════════════════════════════════════════
// viralio-scheduler — server.js
// Post scheduler: YouTube, Facebook, Instagram, TikTok
// Integrare cu HUB-ul Viralio (autentificare & credite)
// ══════════════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const mongoose   = require('mongoose');
const multer     = require('multer');
const Bull       = require('bull');
const { google } = require('googleapis');
const fetch      = require('node-fetch');
const { authenticate, hubAPI } = require('./hub-auth');

const app  = express();
const PORT = process.env.PORT || 3005;

// ── MongoDB ──────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB conectat'))
    .catch(err => console.error('❌ MongoDB error:', err));

// ── Model: Account (conturi conectate per platformă) ─────────
const AccountSchema = new mongoose.Schema({
    userId:      { type: String, required: true },
    platform:    { type: String, enum: ['youtube', 'facebook', 'instagram', 'tiktok'], required: true },
    accessToken:  { type: String },
    refreshToken: { type: String },
    tokenExpiry:  { type: Date },
    channelId:    { type: String },   // YT channel / FB page / IG user / TikTok open_id
    channelName:  { type: String },
    picture:      { type: String },
    pageId:       { type: String },   // Facebook Page ID
    pageName:     { type: String },
    igUserId:     { type: String },   // Instagram Business Account ID
    createdAt:    { type: Date, default: Date.now }
});
AccountSchema.index({ userId: 1, platform: 1 }, { unique: true });
const Account = mongoose.model('Account', AccountSchema);

// ── Model: Post ───────────────────────────────────────────────
const PostSchema = new mongoose.Schema({
    userId:      { type: String, required: true },
    title:       { type: String, default: '' },
    description: { type: String, default: '' },
    hashtags:    [String],
    videoPath:   { type: String },
    videoName:   { type: String },
    videoSize:   { type: Number, default: 0 },
    platforms: [{
        name:           String,
        status:         { type: String, default: 'pending' }, // pending | posting | posted | failed
        platformPostId: String,
        error:          String,
        postedAt:       Date
    }],
    scheduledAt: { type: Date, required: true },
    status:      { type: String, default: 'scheduled', enum: ['scheduled', 'posting', 'completed', 'partial', 'failed', 'cancelled'] },
    jobId:       { type: String },
    createdAt:   { type: Date, default: Date.now }
});
const Post = mongoose.model('Post', PostSchema);

// ── Multer — stocare video local ─────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext  = path.extname(file.originalname);
        const name = `${Date.now()}-${Math.random().toString(36).substr(2, 8)}${ext}`;
        cb(null, name);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
    fileFilter: (req, file, cb) => {
        const allowed = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/avi', 'video/webm', 'video/mov'];
        if (allowed.includes(file.mimetype) || file.mimetype.startsWith('video/')) cb(null, true);
        else cb(new Error('Doar fișiere video acceptate (.mp4, .mov, .avi, .webm)'));
    }
});

// ── Bull Queue (Redis) ────────────────────────────────────────
const postQueue = new Bull('viralio-scheduler', {
    redis: {
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined
    }
});

// ── Google OAuth2 Client ──────────────────────────────────────
const googleOAuth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/api/auth/youtube/callback`
);

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════
// ██ OAUTH — YOUTUBE
// ══════════════════════════════════════════════════════════════
app.get('/api/auth/youtube', authenticate, (req, res) => {
    const url = googleOAuth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [
            'https://www.googleapis.com/auth/youtube.upload',
            'https://www.googleapis.com/auth/youtube.readonly'
        ],
        state: req.userId
    });
    res.json({ url });
});

app.get('/api/auth/youtube/callback', async (req, res) => {
    const { code, state: userId } = req.query;
    if (!code || !userId) return res.redirect(`${process.env.APP_URL}/?error=youtube`);

    try {
        const { tokens } = await googleOAuth2.getToken(code);
        googleOAuth2.setCredentials(tokens);

        const yt      = google.youtube({ version: 'v3', auth: googleOAuth2 });
        const chRes   = await yt.channels.list({ part: ['snippet'], mine: true });
        const channel = chRes.data.items?.[0];

        await Account.findOneAndUpdate(
            { userId, platform: 'youtube' },
            {
                userId, platform: 'youtube',
                accessToken:  tokens.access_token,
                refreshToken: tokens.refresh_token,
                tokenExpiry:  tokens.expiry_date ? new Date(tokens.expiry_date) : null,
                channelId:    channel?.id,
                channelName:  channel?.snippet?.title,
                picture:      channel?.snippet?.thumbnails?.default?.url
            },
            { upsert: true, new: true }
        );

        res.redirect(`${process.env.APP_URL}/?connected=youtube`);
    } catch (err) {
        console.error('❌ YouTube OAuth:', err.message);
        res.redirect(`${process.env.APP_URL}/?error=youtube`);
    }
});

// ══════════════════════════════════════════════════════════════
// ██ OAUTH — FACEBOOK + INSTAGRAM (Meta Graph API)
// Necesită: Meta App cu permisiunile:
//   pages_manage_posts, pages_read_engagement,
//   instagram_basic, instagram_content_publish, pages_show_list
// ══════════════════════════════════════════════════════════════
app.get('/api/auth/facebook', authenticate, (req, res) => {
    const params = new URLSearchParams({
        client_id:     process.env.META_APP_ID,
        redirect_uri:  `${process.env.APP_URL}/api/auth/facebook/callback`,
        scope:         'pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,pages_show_list',
        state:         req.userId,
        response_type: 'code'
    });
    res.json({ url: `https://www.facebook.com/v21.0/dialog/oauth?${params}` });
});

app.get('/api/auth/facebook/callback', async (req, res) => {
    const { code, state: userId } = req.query;
    if (!code || !userId) return res.redirect(`${process.env.APP_URL}/?error=facebook`);

    try {
        // 1. Short-lived token
        const tokenRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?` + new URLSearchParams({
            client_id:     process.env.META_APP_ID,
            client_secret: process.env.META_APP_SECRET,
            redirect_uri:  `${process.env.APP_URL}/api/auth/facebook/callback`,
            code
        }));
        const tokenData = await tokenRes.json();
        if (tokenData.error) throw new Error(tokenData.error.message);

        // 2. Long-lived token (~60 zile)
        const longRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?` + new URLSearchParams({
            grant_type:        'fb_exchange_token',
            client_id:         process.env.META_APP_ID,
            client_secret:     process.env.META_APP_SECRET,
            fb_exchange_token: tokenData.access_token
        }));
        const longData = await longRes.json();
        const longToken = longData.access_token;

        // 3. Lista paginilor
        const pagesRes  = await fetch(`https://graph.facebook.com/v21.0/me/accounts?access_token=${longToken}`);
        const pagesData = await pagesRes.json();
        const page      = pagesData.data?.[0];

        if (!page) throw new Error('Nu ai nicio pagină Facebook. Creează o pagină Business mai întâi.');

        // Salvăm Facebook
        await Account.findOneAndUpdate(
            { userId, platform: 'facebook' },
            {
                userId, platform: 'facebook',
                accessToken:  page.access_token,
                channelId:    page.id,
                channelName:  page.name,
                pageId:       page.id,
                pageName:     page.name
            },
            { upsert: true, new: true }
        );

        // 4. Contul Instagram Business legat de pagină
        try {
            const igPageRes  = await fetch(`https://graph.facebook.com/v21.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
            const igPageData = await igPageRes.json();
            const igId       = igPageData.instagram_business_account?.id;

            if (igId) {
                const igInfoRes  = await fetch(`https://graph.facebook.com/v21.0/${igId}?fields=name,username,profile_picture_url&access_token=${page.access_token}`);
                const igInfo     = await igInfoRes.json();

                await Account.findOneAndUpdate(
                    { userId, platform: 'instagram' },
                    {
                        userId, platform: 'instagram',
                        accessToken:  page.access_token,
                        channelId:    igId,
                        channelName:  igInfo.username || igInfo.name,
                        igUserId:     igId,
                        pageId:       page.id,
                        picture:      igInfo.profile_picture_url
                    },
                    { upsert: true, new: true }
                );
            }
        } catch (igErr) {
            console.warn('⚠️ Instagram link opțional:', igErr.message);
        }

        res.redirect(`${process.env.APP_URL}/?connected=facebook`);
    } catch (err) {
        console.error('❌ Facebook OAuth:', err.message);
        res.redirect(`${process.env.APP_URL}/?error=facebook&msg=${encodeURIComponent(err.message)}`);
    }
});

// ══════════════════════════════════════════════════════════════
// ██ OAUTH — TIKTOK (Content Posting API)
// Necesită aprobare TikTok Developer Portal
// ══════════════════════════════════════════════════════════════
app.get('/api/auth/tiktok', authenticate, (req, res) => {
    const params = new URLSearchParams({
        client_key:    process.env.TIKTOK_CLIENT_KEY,
        scope:         'user.info.basic,video.publish,video.upload',
        response_type: 'code',
        redirect_uri:  `${process.env.APP_URL}/api/auth/tiktok/callback`,
        state:         req.userId
    });
    res.json({ url: `https://www.tiktok.com/v2/auth/authorize?${params}` });
});

app.get('/api/auth/tiktok/callback', async (req, res) => {
    const { code, state: userId } = req.query;
    if (!code || !userId) return res.redirect(`${process.env.APP_URL}/?error=tiktok`);

    try {
        const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
            body:    new URLSearchParams({
                client_key:    process.env.TIKTOK_CLIENT_KEY,
                client_secret: process.env.TIKTOK_CLIENT_SECRET,
                code,
                grant_type:    'authorization_code',
                redirect_uri:  `${process.env.APP_URL}/api/auth/tiktok/callback`
            })
        });
        const tokenData = await tokenRes.json();
        if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

        // User info
        const userRes  = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=display_name,avatar_url,open_id', {
            headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        const userData = await userRes.json();
        const userInfo = userData.data?.user;

        await Account.findOneAndUpdate(
            { userId, platform: 'tiktok' },
            {
                userId, platform: 'tiktok',
                accessToken:  tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                tokenExpiry:  new Date(Date.now() + tokenData.expires_in * 1000),
                channelId:    tokenData.open_id,
                channelName:  userInfo?.display_name || 'TikTok User',
                picture:      userInfo?.avatar_url
            },
            { upsert: true, new: true }
        );

        res.redirect(`${process.env.APP_URL}/?connected=tiktok`);
    } catch (err) {
        console.error('❌ TikTok OAuth:', err.message);
        res.redirect(`${process.env.APP_URL}/?error=tiktok`);
    }
});

// ══════════════════════════════════════════════════════════════
// ██ ACCOUNTS — GET / DELETE
// ══════════════════════════════════════════════════════════════
app.get('/api/accounts', authenticate, async (req, res) => {
    try {
        const accounts = await Account.find({ userId: req.userId })
            .select('-accessToken -refreshToken');
        res.json({ accounts });
    } catch (err) {
        res.status(500).json({ error: 'Eroare la citirea conturilor' });
    }
});

app.delete('/api/accounts/:platform', authenticate, async (req, res) => {
    const allowed = ['youtube', 'facebook', 'instagram', 'tiktok'];
    if (!allowed.includes(req.params.platform)) return res.status(400).json({ error: 'Platformă invalidă' });
    try {
        await Account.deleteOne({ userId: req.userId, platform: req.params.platform });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Eroare la deconectare' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ UPLOAD VIDEO
// ══════════════════════════════════════════════════════════════
app.post('/api/upload', authenticate, upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Niciun fișier primit' });
    res.json({
        videoPath: req.file.path,
        videoName: req.file.originalname,
        videoSize: req.file.size,
        videoUrl:  `/uploads/${req.file.filename}`
    });
});

// ══════════════════════════════════════════════════════════════
// ██ POSTS — CREATE
// ══════════════════════════════════════════════════════════════
app.post('/api/posts', authenticate, async (req, res) => {
    const { title, description, hashtags, videoPath, videoName, videoSize, platforms, scheduledAt } = req.body;

    if (!videoPath)                    return res.status(400).json({ error: 'Lipsește fișierul video' });
    if (!platforms || !platforms.length) return res.status(400).json({ error: 'Selectează cel puțin o platformă' });
    if (!scheduledAt)                  return res.status(400).json({ error: 'Selectează data publicării' });

    const scheduleDate = new Date(scheduledAt);
    if (scheduleDate <= new Date())    return res.status(400).json({ error: 'Data trebuie să fie în viitor' });

    try {
        // 1 credit per platformă
        const { credits } = await hubAPI.checkCredits(req.userId);
        if (credits < platforms.length) {
            return res.status(402).json({ error: `Credite insuficiente. Ai nevoie de ${platforms.length} credite (ai ${credits}).` });
        }

        const post = await Post.create({
            userId:      req.userId,
            title:       title || 'Postare fără titlu',
            description: description || '',
            hashtags:    Array.isArray(hashtags) ? hashtags : [],
            videoPath,
            videoName:   videoName || 'video.mp4',
            videoSize:   videoSize || 0,
            platforms:   platforms.map(p => ({ name: p, status: 'pending' })),
            scheduledAt: scheduleDate,
            status:      'scheduled'
        });

        // Scădem creditele (atomic pe HUB)
        await hubAPI.useCredits(req.userId, platforms.length);

        // Programăm job-ul în Bull
        const delay = scheduleDate.getTime() - Date.now();
        const job   = await postQueue.add(
            { postId: post._id.toString(), userId: req.userId },
            { delay, attempts: 3, backoff: { type: 'exponential', delay: 10000 } }
        );
        await Post.findByIdAndUpdate(post._id, { jobId: job.id.toString() });

        console.log(`📅 POST PROGRAMAT: ${post._id} | platforme: ${platforms.join(', ')} | la: ${scheduleDate.toISOString()}`);
        res.json({ success: true, post });
    } catch (err) {
        console.error('❌ Create post error:', err.message);
        res.status(500).json({ error: err.message || 'Eroare la programare' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ POSTS — GET (toate postările userului)
// ══════════════════════════════════════════════════════════════
app.get('/api/posts', authenticate, async (req, res) => {
    try {
        const posts = await Post.find({ userId: req.userId })
            .sort({ scheduledAt: -1 })
            .limit(100);
        res.json({ posts });
    } catch (err) {
        res.status(500).json({ error: 'Eroare la citire' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ POSTS — DELETE (anulează dacă e programată, rambursează credite)
// ══════════════════════════════════════════════════════════════
app.delete('/api/posts/:id', authenticate, async (req, res) => {
    try {
        const post = await Post.findOne({ _id: req.params.id, userId: req.userId });
        if (!post) return res.status(404).json({ error: 'Postare negăsită' });

        if (post.status === 'scheduled' && post.jobId) {
            const job = await postQueue.getJob(post.jobId);
            if (job) await job.remove();
            // Rambursăm creditele
            const pendingPlatforms = post.platforms.filter(p => p.status === 'pending').length;
            if (pendingPlatforms > 0) await hubAPI.useCredits(req.userId, -pendingPlatforms);
        }

        // Ștergem fișierul video dacă există și nu a fost publicat
        if (post.videoPath && fs.existsSync(post.videoPath)) {
            fs.unlinkSync(post.videoPath);
        }

        await Post.deleteOne({ _id: req.params.id });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Delete post error:', err.message);
        res.status(500).json({ error: 'Eroare la ștergere' });
    }
});

// ══════════════════════════════════════════════════════════════
// ██ BULL QUEUE — PROCESSOR (execuție la data programată)
// ══════════════════════════════════════════════════════════════
postQueue.process(async (job) => {
    const { postId, userId } = job.data;
    console.log(`🚀 EXECUT POST: ${postId}`);

    const post = await Post.findById(postId);
    if (!post) { console.warn('⚠️ Post dispărut:', postId); return; }

    await Post.findByIdAndUpdate(postId, { status: 'posting' });

    const accounts   = await Account.find({ userId, platform: { $in: post.platforms.map(p => p.name) } });
    const accountMap = {};
    accounts.forEach(a => accountMap[a.platform] = a);

    let successCount = 0;
    let failCount    = 0;

    for (const platform of post.platforms) {
        try {
            const account = accountMap[platform.name];
            if (!account) throw new Error('Cont neconectat pentru această platformă');

            let platformPostId;
            if (platform.name === 'youtube')   platformPostId = await postToYouTube(post, account);
            if (platform.name === 'facebook')  platformPostId = await postToFacebook(post, account);
            if (platform.name === 'instagram') platformPostId = await postToInstagram(post, account);
            if (platform.name === 'tiktok')    platformPostId = await postToTikTok(post, account);

            await Post.updateOne(
                { _id: postId, 'platforms.name': platform.name },
                { $set: { 'platforms.$.status': 'posted', 'platforms.$.platformPostId': platformPostId, 'platforms.$.postedAt': new Date() } }
            );
            console.log(`✅ ${platform.name.toUpperCase()} publicat: ${platformPostId}`);
            successCount++;
        } catch (err) {
            console.error(`❌ ${platform.name} EROARE:`, err.message);
            await Post.updateOne(
                { _id: postId, 'platforms.name': platform.name },
                { $set: { 'platforms.$.status': 'failed', 'platforms.$.error': err.message } }
            );
            failCount++;
        }
    }

    const finalStatus = failCount === 0 ? 'completed' : successCount === 0 ? 'failed' : 'partial';
    await Post.findByIdAndUpdate(postId, { status: finalStatus });

    // Ștergem fișierul video după publicare completă
    if (finalStatus === 'completed' && post.videoPath && fs.existsSync(post.videoPath)) {
        fs.unlinkSync(post.videoPath);
        console.log('🗑️ Video șters după publicare:', post.videoPath);
    }
});

postQueue.on('failed', (job, err) => {
    console.error(`❌ JOB ${job.id} eșuat final:`, err.message);
    Post.findByIdAndUpdate(job.data.postId, { status: 'failed' }).catch(() => {});
});

// ══════════════════════════════════════════════════════════════
// ██ FUNCȚII POSTING — YouTube
// ══════════════════════════════════════════════════════════════
async function postToYouTube(post, account) {
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({
        access_token:  account.accessToken,
        refresh_token: account.refreshToken,
        expiry_date:   account.tokenExpiry?.getTime()
    });

    // Refresh automat dacă a expirat
    if (account.tokenExpiry && account.tokenExpiry < new Date()) {
        const { credentials } = await auth.refreshAccessToken();
        await Account.findOneAndUpdate(
            { _id: account._id },
            { accessToken: credentials.access_token, tokenExpiry: new Date(credentials.expiry_date) }
        );
        auth.setCredentials(credentials);
    }

    const yt   = google.youtube({ version: 'v3', auth });
    const tags = post.hashtags?.map(h => h.replace(/^#/, '')) || [];

    const res = await yt.videos.insert({
        part:        ['snippet', 'status'],
        requestBody: {
            snippet: {
                title:       post.title,
                description: `${post.description}\n\n${post.hashtags.join(' ')}`.trim(),
                tags,
                categoryId:  '22'
            },
            status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
        },
        media: { body: fs.createReadStream(post.videoPath) }
    });

    return res.data.id;
}

// ══════════════════════════════════════════════════════════════
// ██ FUNCȚII POSTING — Facebook
// ══════════════════════════════════════════════════════════════
async function postToFacebook(post, account) {
    const caption = `${post.description}\n\n${post.hashtags.join(' ')}`.trim();

    // Citim fișierul și-l trimitem multipart
    const { FormData, Blob } = await import('node-fetch').then(() => ({ FormData: globalThis.FormData, Blob: globalThis.Blob }));
    const form = new (require('form-data'))();
    form.append('file',         fs.createReadStream(post.videoPath), { filename: post.videoName || 'video.mp4' });
    form.append('title',        post.title);
    form.append('description',  caption);
    form.append('access_token', account.accessToken);

    const res  = await fetch(`https://graph-video.facebook.com/v21.0/${account.pageId}/videos`, {
        method:  'POST',
        body:    form,
        headers: form.getHeaders()
    });
    const data = await res.json();
    if (data.error) throw new Error(`FB: ${data.error.message}`);
    return data.id;
}

// ══════════════════════════════════════════════════════════════
// ██ FUNCȚII POSTING — Instagram Reels
// ══════════════════════════════════════════════════════════════
async function postToInstagram(post, account) {
    const caption  = `${post.description}\n\n${post.hashtags.join(' ')}`.trim();
    const videoUrl = `${process.env.APP_URL}/uploads/${path.basename(post.videoPath)}`;

    // 1. Container
    const cRes  = await fetch(`https://graph.facebook.com/v21.0/${account.igUserId}/media`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ media_type: 'REELS', video_url: videoUrl, caption, access_token: account.accessToken })
    });
    const cData = await cRes.json();
    if (cData.error) throw new Error(`IG container: ${cData.error.message}`);

    // 2. Polling status (max 5 minute)
    let ready = false;
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 15000));
        const sRes  = await fetch(`https://graph.facebook.com/v21.0/${cData.id}?fields=status_code,status&access_token=${account.accessToken}`);
        const sData = await sRes.json();
        if (sData.status_code === 'FINISHED') { ready = true; break; }
        if (sData.status_code === 'ERROR') throw new Error(`IG processing: ${sData.status}`);
    }
    if (!ready) throw new Error('IG: Timeout la procesarea video');

    // 3. Publish
    const pRes  = await fetch(`https://graph.facebook.com/v21.0/${account.igUserId}/media_publish`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ creation_id: cData.id, access_token: account.accessToken })
    });
    const pData = await pRes.json();
    if (pData.error) throw new Error(`IG publish: ${pData.error.message}`);
    return pData.id;
}

// ══════════════════════════════════════════════════════════════
// ██ FUNCȚII POSTING — TikTok
// ══════════════════════════════════════════════════════════════
async function postToTikTok(post, account) {
    const fileSize = post.videoSize || fs.statSync(post.videoPath).size;

    // 1. Init upload
    const initRes  = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${account.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body:    JSON.stringify({
            post_info:   {
                title:           post.title.substring(0, 150),
                privacy_level:   'PUBLIC_TO_EVERYONE',
                disable_duet:    false,
                disable_comment: false,
                disable_stitch:  false
            },
            source_info: { source: 'FILE_UPLOAD', video_size: fileSize, chunk_size: fileSize, total_chunk_count: 1 }
        })
    });
    const initData = await initRes.json();
    if (initData.error?.code !== 'ok') throw new Error(`TikTok init: ${initData.error?.message || 'Unknown error'}`);

    const { publish_id, upload_url } = initData.data;

    // 2. Upload video
    const videoBuffer = fs.readFileSync(post.videoPath);
    await fetch(upload_url, {
        method:  'PUT',
        headers: {
            'Content-Type':   'video/mp4',
            'Content-Length': fileSize.toString(),
            'Content-Range':  `bytes 0-${fileSize - 1}/${fileSize}`
        },
        body: videoBuffer
    });

    return publish_id;
}

// ── SPA fallback ──────────────────────────────────────────────
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 Viralio Scheduler pe portul ${PORT}`));
