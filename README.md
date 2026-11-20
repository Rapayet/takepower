# ₿ takepower.world

**Ajurí: Revolución de la Paz**

Plataforma Bitcoin para la redistribución de riqueza y la cooperación global. Tres pilares:

1. **Baúl Común de la Humanidad**: fondo voluntario de Bitcoin redistribuido vía Lightning Network a cualquier persona, sin condiciones ni identificación.
2. **Patrón Energético**: sistema de precios basado en la energía físicamente incorporada (MJ → sats), usando Bitcoin como unidad de cuenta.
3. **Manifiesto**: marco filosófico que conecta termodinámica, justicia económica y coordinación post-petrodólar.

Este repositorio es **el código que corre hoy en takepower.world**: las páginas, el backend y los programas que protegen el dinero del Baúl. No contiene claves: todas se leen de archivos fuera del repositorio (véase `.env.example` y `ops/`).

---

## Estructura

```
frontend/                       (en el servidor, /opt/fondo/frontend/)
├── FONDO-index.html            # /            Baúl Común (recibir / donar sats)
├── VISION-index.html           # /vision/     Manifiesto en 4 idiomas
├── ENERGY-index.html           # /energystandard/  Patrón Energético + calculadora + migración por etapas
├── LEARN-index.html            # /learn/      ¿Qué es Bitcoin?, glosario, riesgos
├── TACTIC-index.html           # /tactic/     Táctica
├── NATURA-index.html           # /natura/     Naturaleza (no se indexa)
├── LEDGER-index.html           # /ledger/     Libro público de movimientos del Baúl
├── PRIVACY-index.html          # /privacy/    Política de privacidad
├── robots.txt
└── sitemap.xml

backend/
└── BACKEND-index.js            # API Node.js (reclamos, donaciones, votos, productos) -> /opt/fondo/backend/index.js

ops/                            # lo que vigila y mantiene el Baúl (ver ops/README.md)
├── vigilante/                  # frena todo si sale dinero sin explicación
├── fondo-ip-purge/             # borra las IP a los 22 días
├── njalla-pay/                 # paga solo el servidor desde el Baúl
├── ledger/                     # genera el libro público
└── systemd/                    # unidades del backend y de phoenixd
```

## Stack

- **Frontend**: HTML + Tailwind CSS + JavaScript sin frameworks. 4 idiomas (ES/EN/PT-BR/FR).
- **Backend**: Node.js + Express + better-sqlite3, corriendo como usuario sin privilegios (`fondo`).
- **Pagos**: Lightning Network con [phoenixd](https://phoenix.acinq.co/server), corriendo como usuario propio (`phoenix`).
- **Anti-spam**: Cloudflare Turnstile (falla cerrado: sin verificación no hay reclamo ni donación).
- **Analítica**: Umami (sin cookies).

## Cómo se protege el dinero

- **Cada reclamo paga exactamente 10.000 sats.** El backend exige un invoice de ese monto exacto, de la red principal, que no vaya al propio nodo; con Lightning Address vuelve a validar el invoice que le devuelven. A phoenixd solo le entrega el invoice ya validado.
- **Topes**: 50.000 sats al día en reclamos (backend) y 60.000 sats en 24 h en total (vigilante). Una reserva de operación (37.500 sats como mínimo) no se reparte.
- **Vigilante independiente** (cada minuto): compara lo que phoenixd dice que pagó con lo que la base dice que debía pagar. Si sale dinero que nadie explica, crea `HALT`, detiene el backend y phoenixd y avisa al operador.
- **Libro público** de cada movimiento, encadenado y copiado con sellos de tiempo en Bitcoin: [takepower.world/ledger](https://takepower.world/ledger/) y su espejo [Rapayet/takepower-ledger](https://github.com/Rapayet/takepower-ledger).

## Instalación local

```bash
git clone https://github.com/Rapayet/takepower.git
cd takepower
cp .env.example backend/.env        # y edítalo con tus valores de phoenixd y Turnstile
cd backend
cp BACKEND-index.js index.js
npm install express better-sqlite3 bolt11 helmet express-rate-limit dotenv
node index.js

# Frontend: sirve frontend/ con cualquier servidor estático (cada página va en su carpeta, véase la estructura)
```

## Contribuir

- Abre un [Issue](../../issues) para reportar errores o sugerir mejoras.
- Envía un Pull Request con código, traducciones o correcciones.
- Copia el código y lanza tu propia instancia del Baúl.

Contacto: power.area517@passinbox.com (también en la [política de privacidad](https://takepower.world/privacy/)).

## Auditar el fondo

- Libro de movimientos: [takepower.world/ledger](https://takepower.world/ledger/), verificable por cualquiera con `verify_ledger.py` del [repositorio del libro](https://github.com/Rapayet/takepower-ledger).
- Canal Lightning del nodo actual (apertura, 19-nov-2026): [ver en mempool.space](https://mempool.space/tx/ca242f44fb6189dba4801191e643818a19d9278a5337838dbed0e1a9cca81ae4)

## Licencia

- **Contenido** (textos, manifiesto, traducciones): [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), dominio público.
- **Código** (backend, páginas, scripts de `ops/`): [MIT](LICENSE)

---

*"La verdad oculta fundamental del mundo es que es algo que creamos juntos y que fácilmente podríamos crear diferente" — David Graeber*
