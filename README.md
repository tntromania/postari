# 📅 Viralio Scheduler

Programează automat postări video pe **YouTube, Facebook, Instagram și TikTok** dintr-un singur loc.
Integrat cu HUB-ul Viralio pentru autentificare și credite.

---

## 🗂️ Structura fișierelor

```
viralio-scheduler/
├── server.js           ← Backend Express + Bull + OAuth
├── hub-auth.js         ← Modul partajat HUB (autentificare & credite)
├── package.json
├── .env.example        ← Copiază în .env și completează
├── Dockerfile
├── docker-compose.yml  ← Dev local + referință Coolify
└── public/
    ├── index.html      ← SPA frontend
    └── style.css       ← Dark theme Viralio
```

---

## ⚡ Deploy pe Coolify (Hetzner)

### 1. Creează serviciul în Coolify

1. **New Resource → Docker Compose** sau **Dockerfile**
2. Selectează repo-ul Git (sau urcă fișierele direct)
3. **Port:** `3005`
4. **Domain:** `scheduler.viralio.ro`

### 2. Adaugă Redis ca serviciu separat în Coolify

1. **New Resource → Redis** (din marketplace Coolify)
2. Notează hostname-ul intern (ex: `viralio-scheduler-redis`)
3. Setează `REDIS_HOST` în variabilele de mediu ale app-ului

### 3. Setează variabilele de mediu în Coolify

```env
PORT=3005
APP_URL=https://scheduler.viralio.ro
MONGO_URI=mongodb+srv://...
REDIS_HOST=<hostname-redis-coolify>
REDIS_PORT=6379
HUB_URL=https://hub.viralio.ro
INTERNAL_API_KEY=<aceeasi_cheie_ca_pe_hub>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
META_APP_ID=...
META_APP_SECRET=...
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
```

### 4. Volume pentru upload-uri

În Coolify, adaugă un volume persistent:
- **Container path:** `/app/uploads`
- **Host path:** `/data/viralio-scheduler/uploads` (sau lași Coolify să-l gestioneze)

---

## 🔑 Setup OAuth per platformă

### YouTube
1. [console.cloud.google.com](https://console.cloud.google.com) → New Project
2. **APIs & Services → Enable APIs** → YouTube Data API v3
3. **Credentials → OAuth 2.0 Client ID** (tip: Web application)
4. **Authorized redirect URIs:** `https://scheduler.viralio.ro/api/auth/youtube/callback`
5. Copiază Client ID și Client Secret în `.env`

### Facebook + Instagram
1. [developers.facebook.com](https://developers.facebook.com) → New App (tip: Business)
2. **Products → Add:** Facebook Login, Instagram Graph API
3. **Facebook Login → Settings → Valid OAuth Redirect URIs:**
   `https://scheduler.viralio.ro/api/auth/facebook/callback`
4. **Permissions necesare** (necesită App Review pentru producție):
   - `pages_manage_posts`
   - `pages_read_engagement`
   - `pages_show_list`
   - `instagram_basic`
   - `instagram_content_publish`
5. **Cerință Instagram:** Utilizatorul trebuie să aibă cont **Professional/Business** legat de o Pagină FB

### TikTok
1. [developers.tiktok.com](https://developers.tiktok.com) → Create App
2. **Solicită acces la:** Content Posting API (necesită review ~2-4 săptămâni)
3. **Redirect URI:** `https://scheduler.viralio.ro/api/auth/tiktok/callback`
4. **Scopes:** `user.info.basic`, `video.publish`, `video.upload`

---

## 💡 Costul per postare

| Platforme selectate | Credite consumate |
|---------------------|-------------------|
| 1 platformă         | 1 credit          |
| 2 platforme         | 2 credite         |
| 3 platforme         | 3 credite         |
| 4 platforme         | 4 credite         |

Creditele sunt gestionate atomic pe HUB. Dacă anulezi o postare programată, creditele se rambursează automat.

---

## 🛠️ Dezvoltare locală

```bash
# 1. Clone sau copiază fișierele
cp .env.example .env
# Editează .env

# 2. Cu Docker Compose
docker-compose up

# 3. Fără Docker (necesită Redis local)
npm install
npm run dev
```

---

## 📋 API Endpoints

| Method   | Endpoint                      | Descriere                          |
|----------|-------------------------------|------------------------------------|
| `GET`    | `/api/auth/youtube`           | Obține URL OAuth YouTube           |
| `GET`    | `/api/auth/youtube/callback`  | Callback OAuth YouTube             |
| `GET`    | `/api/auth/facebook`          | Obține URL OAuth Facebook/IG       |
| `GET`    | `/api/auth/facebook/callback` | Callback OAuth Facebook/IG         |
| `GET`    | `/api/auth/tiktok`            | Obține URL OAuth TikTok            |
| `GET`    | `/api/auth/tiktok/callback`   | Callback OAuth TikTok              |
| `GET`    | `/api/accounts`               | Lista conturi conectate            |
| `DELETE` | `/api/accounts/:platform`     | Deconectează o platformă           |
| `POST`   | `/api/upload`                 | Urcă video (multipart/form-data)   |
| `POST`   | `/api/posts`                  | Creează & programează un post      |
| `GET`    | `/api/posts`                  | Lista postărilor utilizatorului    |
| `DELETE` | `/api/posts/:id`              | Șterge/anulează un post            |

---

## ⚠️ Limitări cunoscute

- **TikTok:** API-ul Content Posting necesită aprobare specială. Fără aprobare, poți testa doar în sandbox.
- **Instagram:** Necesită obligatoriu cont Business/Creator + pagină Facebook. Conturile personale nu sunt suportate de API.
- **Facebook:** Postarea pe **profile personale** nu mai este permisă de Meta API din 2018. Doar pagini.
- **Video storage:** Videos sunt stocate local în `/app/uploads`. Asigură-te că ai suficient spațiu pe disk sau adaptează pentru S3.
