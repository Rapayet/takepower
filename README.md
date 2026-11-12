# ₿ takepower.world

**Ajurí: Revolución de la Paz**

Plataforma Bitcoin para la redistribución de riqueza y la cooperación global. Tres pilares:

1. **Baúl Común de la Humanidad** — Fondo voluntario de Bitcoin redistribuido vía Lightning Network a cualquier persona, sin condiciones ni identificación.
2. **Patrón Energético** — Sistema de precios basado en la energía físicamente incorporada (MJ → sats), usando Bitcoin como unidad de cuenta.
3. **Manifiesto** — Marco filosófico que conecta termodinámica, justicia económica y coordinación post-petrodólar.

---

## Estructura

```
frontend/
├── index.html              # Baúl Común (recibir/donar sats)
├── vision/index.html        # Manifiesto en 4 idiomas
├── energystandard/index.html # Patrón Energético + calculadora
├── learn/index.html          # ¿Qué es Bitcoin? + glosario + timeline
├── tactic/index.html         # Táctica revolucionaria
├── natura/index.html         # Naturaleza y biocentrismo
├── privacy/index.html        # Política de privacidad
├── robots.txt
└── sitemap.xml

backend/
└── index.js                 # API Node.js (claims, donaciones, votos, productos)
```

## Stack

- **Frontend**: HTML + Tailwind CSS + vanilla JS. Sin frameworks. 4 idiomas (ES/EN/PT-BR/FR).
- **Backend**: Node.js + Express + better-sqlite3 + phoenixd (Lightning).
- **Pagos**: Lightning Network vía [phoenixd](https://phoenix.acinq.co/server).
- **CAPTCHA**: Cloudflare Turnstile.
- **Analytics**: Umami (privacy-first).

## Instalación local

```bash
# Clonar
git clone https://github.com/TU_USUARIO/takepower.git
cd takepower

# Backend
cd backend
cp .env.example .env
# Edita .env con tus credenciales de phoenixd
npm install
node index.js

# Frontend
# Sirve frontend/ con cualquier servidor estático
npx serve frontend
```

## Contribuir

Este proyecto es de dominio público. Puedes:
- Abrir un [Issue](../../issues) para reportar bugs o sugerir mejoras
- Enviar un Pull Request con código, traducciones o correcciones
- Copiar el código y lanzar tu propia instancia del Baúl

No tenemos correo de contacto. La comunicación es vía Issues de GitHub.

## Auditar el fondo

El canal Lightning del Baúl es público y auditable:
🔍 [Ver en mempool.space](https://mempool.space/tx/52ed766422728e6e73b1b096ed938ba9e35e185ee1080e1c775a3671a3d4bfb7)

## Licencia

- **Contenido** (textos, manifiesto, traducciones): [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — Dominio público.
- **Código** (backend, scripts): [MIT](LICENSE)

---

*"La verdad oculta fundamental del mundo es que es algo que creamos juntos y que fácilmente podríamos crear diferente" — David Graeber*
