# 🚀 Deploy Guide — SEO Customer Journey Dashboard

## Resumen
App Next.js con login OAuth de Google que lee datos de Search Console y Analytics en vivo. Opcionalmente genera recomendaciones con Claude IA.

---

## PASO 1 — Google Cloud Console (5 min)

Ya tienes Google Cloud Console. Solo necesitas configurar el OAuth:

1. Ve a https://console.cloud.google.com
2. Selecciona tu proyecto (o crea uno nuevo)
3. Ve a **APIs & Services → Credentials**
4. Clic en **"+ CREATE CREDENTIALS" → "OAuth 2.0 Client ID"**
5. Application type: **Web application**
6. Name: `SEO Dashboard`
7. En **Authorized redirect URIs**, añade:
   - `http://localhost:3000/api/auth/callback/google` (para desarrollo)
   - `https://TU-APP.vercel.app/api/auth/callback/google` (la añadirás después del deploy)
8. Clic **Create**
9. **Copia el Client ID y Client Secret** — los necesitarás en Vercel

> ⚠️ Si no tienes las APIs habilitadas, ve a **APIs & Services → Library** y activa:
> - Google Search Console API
> - Google Analytics Data API

---

## PASO 2 — Subir a GitHub (2 min)

1. Ve a https://github.com/new
2. Nombre: `seo-dashboard` (o el que quieras)
3. Deja público o privado
4. **NO** inicialices con README
5. Clic **"Create repository"**
6. En la página del repo vacío, haz clic en **"uploading an existing file"**
7. **Arrastra TODOS los archivos del ZIP** descomprimido
8. Clic **"Commit changes"**

> Importante: arrastra el CONTENIDO de la carpeta, no la carpeta en sí. GitHub debe ver `package.json` en la raíz del repo.

> Nota técnica: La carpeta `app/api/auth/_nextauth/` tiene un guión bajo en vez de corchetes porque GitHub no acepta `[...nextauth]` en el drag & drop. El script `setup-auth.js` la renombra automáticamente durante el build en Vercel. No tienes que hacer nada.

---

## PASO 3 — Deploy en Vercel (3 min)

1. Ve a https://vercel.com/dashboard
2. Clic **"Add New" → "Project"**
3. Selecciona el repo `seo-dashboard` de tu GitHub
4. Framework: **Next.js** (lo detecta automáticamente)
5. Abre **"Environment Variables"** y añade estas 4:

| Variable | Valor |
|----------|-------|
| `GOOGLE_CLIENT_ID` | El Client ID del Paso 1 |
| `GOOGLE_CLIENT_SECRET` | El Client Secret del Paso 1 |
| `NEXTAUTH_SECRET` | Genera uno aquí: https://generate-secret.vercel.app/32 |
| `NEXTAUTH_URL` | `https://TU-APP.vercel.app` (Vercel te da la URL) |

6. Clic **"Deploy"**
7. Espera ~1-2 minutos

---

## PASO 4 — Añadir redirect URI en Google Cloud (1 min)

Una vez desplegado, Vercel te da una URL tipo `https://seo-dashboard-xxxx.vercel.app`.

1. Vuelve a Google Cloud Console → Credentials
2. Edita tu OAuth 2.0 Client ID
3. Añade esta URI en **Authorized redirect URIs**:
   ```
   https://seo-dashboard-xxxx.vercel.app/api/auth/callback/google
   ```
4. Guarda

---

## PASO 5 — Probar

1. Abre `https://seo-dashboard-xxxx.vercel.app`
2. Clic "Conectar con Google"
3. Acepta los permisos (Search Console + Analytics)
4. Selecciona tus propiedades en el selector
5. Clic "Generar Dashboard"
6. Verás tus datos reales de GSC + GA4

---

## PASO 6 (Opcional) — Activar Claude IA

Cuando tengas tu API key de Anthropic:

1. Ve al panel de Vercel → tu proyecto → Settings → Environment Variables
2. Añade:

| Variable | Valor |
|----------|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-xxxxx...` |

3. Clic "Save"
4. Ve a **Deployments** y clic **"Redeploy"** en el último deploy
5. Ahora el badge "🤖 IA" aparecerá como "ON" y al generar el dashboard se incluirán recomendaciones de Claude

---

## PASO 7 (Opcional) — Añadir DataForSEO

Si quieres datos de competencia:

| Variable | Valor |
|----------|-------|
| `DATAFORSEO_LOGIN` | Tu login |
| `DATAFORSEO_PASSWORD` | Tu password |

Redeploy después de añadir.

---

## Estructura del proyecto

```
seo-dashboard/
├── app/
│   ├── api/
│   │   ├── auth/_nextauth/route.ts   ← OAuth Google (se renombra solo en build)
│   │   ├── gsc/route.ts              ← Search Console API
│   │   ├── ga4/route.ts              ← Analytics API
│   │   └── insights/route.ts         ← Claude IA (opcional)
│   ├── dashboard/page.tsx            ← Dashboard principal
│   ├── page.tsx                      ← Login
│   ├── layout.tsx                    ← Layout raíz
│   ├── providers.tsx                 ← NextAuth provider
│   └── globals.css                   ← Estilos
├── setup-auth.js                     ← Renombra _nextauth → [...nextauth]
├── package.json
├── tsconfig.json
├── next.config.js
├── .env.example                      ← Template de variables
└── DEPLOY.md                         ← Este archivo
```

## Coste mensual

| Servicio | Coste |
|----------|-------|
| Vercel Hobby | Gratis |
| GitHub | Gratis |
| Google Cloud (APIs) | Gratis |
| Anthropic API | ~$0.60/mes por cliente (opcional) |

---

## Troubleshooting

**"Error: redirect_uri_mismatch"**
→ La URL de redirect en Google Cloud no coincide con la de Vercel. Copia la URL exacta.

**"Error: access_denied"**
→ Las APIs de GSC o GA4 no están habilitadas en Google Cloud. Ve a Library y actívalas.

**No veo propiedades de Search Console**
→ La cuenta de Google con la que te logueas debe tener acceso a las propiedades de GSC.

**El badge IA dice "OFF"**
→ Falta ANTHROPIC_API_KEY en Vercel. Añádela y redeploy.
