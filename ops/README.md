# ops/: lo que vigila y mantiene el Baúl

Copias exactas de lo que corre en el servidor de takepower.world (Debian 12, contenedor LXC, systemd). Ninguna clave: cada programa lee las suyas de archivos que no están aquí.

| Carpeta | En el servidor | Qué hace |
|---|---|---|
| `vigilante/` | `/opt/fondo/vigilante/vigilante.js`, `/usr/local/sbin/vigilante-permitir`, `/usr/local/sbin/vigilante-ventana`, `/etc/vigilante.env` | Cada minuto compara las salidas de phoenixd con los reclamos de la base y con `permitidos.txt`. Si sale dinero sin explicación, o se pasa el tope de 24 h, crea `HALT`, detiene el backend y phoenixd y avisa por ntfy. Usa la clave LIMITADA de phoenixd (no puede pagar). |
| `fondo-ip-purge/` | `/usr/local/sbin/fondo-ip-purge.js` | Cada hora borra las IP de reclamos y neutraliza las de votos con más de 22 días (lo que promete la política de privacidad). Corre como `fondo`. |
| `njalla-pay/` | `/usr/local/sbin/njalla-pay.js`, `/etc/njalla-pay.env` | Una vez al día: si la billetera de Njalla (hosting) baja de 20 €, pide un cobro de 15 € en bitcoin y lo paga desde el nodo. Tope de 40.000 sats, el monto debe cuadrar ±15 % con el precio de mercado, dirección validada, un pago cada 7 días como máximo, avisa al vigilante antes de pagar y anota el txid como gasto (el libro lo publica). El token de Njalla está limitado a la IP del servidor y a `get-balance` y `add-payment`. Paga **solo el servidor**. |
| `ledger/` | `/opt/fondo/ledger/fondo-ledger.js` | Cada hora genera los bloques del [libro público](https://takepower.world/ledger/). Lee phoenixd con la clave limitada y la base en solo lectura. El verificador y el espejo están en [Rapayet/takepower-ledger](https://github.com/Rapayet/takepower-ledger). |
| `systemd/` | `/etc/systemd/system/` | Unidades del backend y de phoenixd. Los archivos `*.service.d-*.conf` van en `/etc/systemd/system/<unidad>.service.d/`. |

Usuarios: el backend corre como `fondo` y phoenixd como `phoenix` (su semilla no la puede leer el backend). El vigilante, el libro y njalla-pay corren como root y solo LEEN la base del backend. La purga es la única que escribe en ella además del backend, y por eso corre como `fondo`.

Las unidades de `systemd/` se copiaron de lo instalado; en esa copia las rutas venían ocultas por precaución y se escribieron de nuevo a mano: compruébalas antes de usarlas en otra instalación.
