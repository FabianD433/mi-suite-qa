# DatAscend API — Reporte de defectos de backend (QA2)

| | |
|---|---|
| **Entorno** | `https://qa2.datascend.net` — API v1.1.0 (OpenAPI 3.0.0) |
| **Fecha** | 2026-11-23 |
| **Detectado por** | Suite `tests/APIs/critical-endpoints.api.spec.ts` (Vitest + `fetch` nativo) y sondeo manual de la API |
| **Usuario de prueba** | Cuenta administradora de QA (`.env` → `DATASCEND_EMAIL`) |
| **Estado en la suite** | Cada caso está marcado con `it.fails` y referencia su BUG-xx. Cuando se corrija el defecto, el caso empezará a fallar: es la señal para quitar el `.fails`. |

## Resumen

| Grupo | Defecto | Severidad | Casos `it.fails` |
|---|---|---|---|
| **1** | Exposición de SQL crudo de PostgreSQL en errores 500 | **Alta** (seguridad, CWE-209) | 4 |
| **2** | `TypeError` no controlado → 500 por falta de Auth Guard | **Alta** | 5 |
| **3** | Error de serialización circular → 500 al crear un registro con tipo inválido | Media | 1 |
| **4** | Códigos HTTP inconsistentes con la spec y con la semántica REST | Media / Baja | 5 |
| | **Total** | | **15** |

Además hay dos hallazgos fuera de los 4 grupos, que afectan la estabilidad de cualquier cliente (ver [Hallazgos adicionales](#hallazgos-adicionales)): BUG-05 (tokens de login inutilizables de forma intermitente) y BUG-06 (500 en `/users/me` bajo concurrencia).

### Reproducción

```bash
BASE=https://qa2.datascend.net
TOKEN=$(curl -s -X POST "$BASE/api/v1/users/login" -H 'Content-Type: application/json' \
  -d '{"email":"<qa-email>","password":"<qa-password>"}' | jq -r .accessToken)
```

Ninguna reproducción modifica datos preexistentes. BUG-03 crea un registro solo si el defecto se corrige mal; la suite lo borra automáticamente.

---

## Grupo 1 — Exposición de SQL crudo / PostgreSQL en respuestas 500

**Severidad: Alta (seguridad).** Exposición de información, CWE-209 (*Generation of Error Message Containing Sensitive Information*). Cuando un parámetro de entrada no es válido, el backend no lo valida. La excepción de Knex/PostgreSQL se propaga hasta el cliente y se serializa en `message`, con:
- la sentencia SQL completa;
- el esquema (`dasec`), las tablas (`role`, `user`, `workflow`) y las columnas;
- el tipo de dato y la versión implícita del motor.

Esto le da a un atacante el mapa del modelo de datos y le confirma qué entradas llegan sin filtrar a la base. BUG-01b también muestra que `key` se interpola como **identificador de columna**: aunque el valor va parametrizado (`$1`), el nombre de columna no pasa por ninguna lista blanca, y ese es el patrón previo a una inyección SQL por identificador.

| ID | Endpoint | Reproducción | Esperado | Actual |
|---|---|---|---|---|
| BUG-01a | `GET /api/v1/roles/` | `curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/roles/?limit=-1&page=0"` | `400` "limit/page inválidos" | `500` — `error: select "dasec"."role".* from "dasec"."role" order by "dasec"."role"."id"::text ASC NULLS FIRST limit $1 offset $2 - LIMIT must not be negative` |
| BUG-01b | `GET /api/v1/users/` | `curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/users/?limit=1&page=1&key=qa_api_nonexistent_col&operator=eq&value=x&condition=AND&open_parens=0&close_parens=0"` | `400` "campo de filtro desconocido" | `500` — `error: select count(*) as "count" from "dasec"."user" where ("qa_api_nonexistent_col" = $1) and "dasec"."user"."active"::boolean = $2 - column "qa_api_nonexistent_col" does not exist` |
| BUG-01c | `GET /api/v1/users/{userId}` | `curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/users/not-a-uuid"` | `400` (id inválido) o `404` | `500` — `error: select TRUE from "dasec"."user" where "id" = $1 limit $2 - invalid input syntax for type uuid: "not-a-uuid"` |
| BUG-01d | `GET /api/v1/workflow/{id}` | `curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/workflow/not-a-uuid"` | `400` o `404` | `500` — `error: select * from "dasec"."workflow" where "id" = $1 limit $2 - invalid input syntax for type uuid: "not-a-uuid"` |

Formato de la respuesta actual:
```json
{ "error": true, "status": 500, "message": "error: select … - <detalle de PostgreSQL>", "errors": ["network.internal_server_error"] }
```

Contraste: `GET /api/v1/roles/not-a-uuid` ya responde `404` limpio, así que el patrón correcto existe en el código pero no se aplica de forma uniforme.

**Recomendación:**
1. Que el handler global de errores **nunca** devuelva `err.message` para errores 5xx. Debe responder un mensaje genérico con un `correlationId` y registrar el detalle solo en los logs.
2. Validar `limit` (entero ≥ 1, con tope máximo), `page` (entero ≥ 1) e ids de ruta (UUID) en la capa de validación del request, antes del repositorio.
3. Contrastar `key` y `sort_field` contra una **lista blanca** de columnas de la entidad, y responder `400` si no están.

**Pruebas:**
- `P0 · Validación de datos inválidos › GET /roles con limit negativo / page 0`
- `› GET /users con columna de filtro inexistente`
- `› GET /users/{id} con id no-UUID`
- `› GET /workflow/{id} con id no-UUID`

---

## Grupo 2 — `TypeError` no controlado → 500 por falta de Auth Guard

**Severidad: Alta.** Estos endpoints asumen que el middleware de autenticación ya pobló el usuario o la sesión, sin un guard que corte la petición con `401` cuando no hay credenciales válidas. El handler intenta leer propiedades de `undefined` y la excepción sale al cliente como 500 junto con el texto del `TypeError`.

Consecuencias:
- **Contrato roto.** Los clientes (frontend, integraciones, MCP) no pueden distinguir entre "sesión expirada, hay que reautenticar" y "fallo del servidor", y el flujo de reautenticación no se dispara.
- **Información interna expuesta.** El mensaje revela nombres de variables minificadas y la estructura del handler.
- **Ruido en monitoreo.** Cada request anónimo cuenta como 5xx en las alertas.

| ID | Endpoint | Reproducción | Esperado | Actual |
|---|---|---|---|---|
| BUG-02a | `GET /api/v1/users/me` | `curl "$BASE/api/v1/users/me"` <br> `curl -H "Authorization: Bearer invalid.token.value" "$BASE/api/v1/users/me"` | `401` | `500` — `TypeError: undefined is not an object (evaluating 'r.id')` |
| BUG-02b | `GET /api/v1/users/profile` | `curl "$BASE/api/v1/users/profile"` <br> `curl -H "Authorization: Bearer invalid.token.value" "$BASE/api/v1/users/profile"` | `401` | `500` — `TypeError: undefined is not an object (evaluating 'e.user.id')` |
| BUG-02c | `POST /api/v1/users/refresh` | `curl -X POST -H "Authorization: Bearer not.a.valid-token" "$BASE/api/v1/users/refresh"` | `401` `refresh.invalid_refresh_token` | `500` — `TypeError: undefined is not an object (evaluating 's.loginInfo')` |

Contraste dentro del mismo endpoint:
- `POST /users/refresh` **sin** header ya responde `401 refresh.invalid_refresh_token`. El fallo ocurre solo cuando el header existe pero el token no decodifica a una sesión.
- Con un token **revocado** (después de un logout), `/users/me` responde `401 login.invalid_token login.reauthenticate`. La rama correcta existe; lo que falta es el caso "token ausente o ilegible".

**Recomendación:** aplicar un guard de autenticación en estas rutas que responda `401` con `{ error: true, message: "login.invalid_token", errors: ["network.unauthorized"] }` antes de llegar al handler, y validar en el handler de refresh que la sesión exista antes de leer `loginInfo`.

**Pruebas:** 5 casos.
- `P0 · Requests sin token son rechazados › sin Authorization › GET /api/v1/users/me`
- `› sin Authorization › GET /api/v1/users/profile`
- `› con Bearer malformado › GET /api/v1/users/me`
- `› con Bearer malformado › GET /api/v1/users/profile`
- `P0 · Autenticación › refresh con un token malformado → 401`

---

## Grupo 3 — Error de serialización circular al crear un registro

**Severidad: Media.** `POST /api/v1/entities/{entity}` no valida el **tipo** de cada valor contra la definición del campo. Un objeto en un campo `string` llega a una capa interna (persistencia, auditoría o revisiones; la entidad tiene `audited`/`revisionTracking`) que hace `JSON.stringify` de una estructura con referencias cíclicas y falla con 500.

| ID | Endpoint | Reproducción | Esperado | Actual |
|---|---|---|---|---|
| BUG-03 | `POST /api/v1/entities/{entity}` | `curl -X POST -H "Authorization: Bearer $TOKEN" -H "domain: <domainId>" -H 'Content-Type: application/json' "$BASE/api/v1/entities/a1d50794-eeea-4e55-9b94-e25f9ed5b3ee?version=active" -d '{"name":{"qa_api":true}}'` (`name` es `string` en la entidad *Sprint*) | `400`/`422` "tipo inválido para `name`" | `500` — `TypeError: JSON.stringify cannot serialize cyclic structures.` |

Contraste: una propiedad **inexistente** (`{"qa_api_unknown_field":"x"}`) sí responde `400 Property [...] does not exists in entity [Sprint]`. Se valida la existencia del campo, pero no su tipo.

**Riesgo adicional:** hay que confirmar que el 500 ocurre **antes** del commit. En las ejecuciones de la suite no quedaron registros huérfanos, pero un fallo después del INSERT dejaría datos sin auditoría.

**Recomendación:** validar el tipo de cada valor contra el `type` del campo (string, number, boolean, date, multivalor) en el controlador de Entities-Data. Responder `400` con el campo y el tipo esperado.

**Prueba:** `P0 · Validación de datos inválidos › POST /entities/{entity} con tipo inválido (objeto en campo string) → 400/422`.

---

## Grupo 4 — Inconsistencia de códigos HTTP

**Severidad: Media (04a, 04b) / Baja (04c, 04d).** Las respuestas no siguen ni la spec OpenAPI publicada ni la semántica estándar. Los clientes deben tratar casos especiales, y las pruebas de contrato no pueden basarse en el código de estado.

| ID | Endpoint | Reproducción | Esperado | Actual | Impacto |
|---|---|---|---|---|---|
| BUG-04a | `POST /api/v1/users/login` | `curl -X POST -H 'Content-Type: application/json' "$BASE/api/v1/users/login" -d '{"email":"not-an-email","password":"x"}'` | `400`/`422`: es un error de validación del payload | `401` `type: "BadRequest"`, `message: "login.bad_email"`, `errors: ["network.bad_request"]` | El propio body dice *BadRequest* con status 401. El frontend lo confunde con credenciales erróneas y el rate-limit de fallos de autenticación cuenta errores de formato. |
| BUG-04b | `GET /api/v1/users/profile/api-keys` | `curl "$BASE/api/v1/users/profile/api-keys"` <br> `curl -H "Authorization: Bearer invalid.token.value" "$BASE/api/v1/users/profile/api-keys"` | `401` (la spec lo documenta) | `400` "User authentication required." `errors: ["network.bad_request"]` | Un cliente no dispara la reautenticación: un 400 se interpreta como un error propio del request. |
| BUG-04c | `POST /api/v1/users/logout` | `curl -i -X POST "$BASE/api/v1/users/logout"` | `401` (la spec lo documenta) | `204 No Content` | Bajo: el logout es idempotente. Pero el contrato documentado no se cumple y el cliente cree haber cerrado una sesión que no envió. |
| BUG-04d | `GET /api/v1/workflow/{id}` | `curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/workflow/00000000-0000-4000-8000-000000000000"` | `404` (la spec lo documenta) | `200` `{"message":"status_messages.workflow_getting_successfully","data":[]}` | El cliente no distingue entre "no existe" y "vacío". Además `data` es un array cuando para un recurso único debería ser un objeto. |

Nota sobre la spec: los endpoints de `Workflow` documentan `201` para respuestas de lectura (`GET /workflow`, `GET /workflow/{id}`). En la práctica responden `200`, así que conviene corregir también el OpenAPI.

**Recomendación:**
- 04a: mover la validación del formato del email al validador del request, que responde `400`.
- 04b: usar el mismo guard de autenticación que en el Grupo 2.
- 04c: exigir token y responder `401` si falta, o bien documentar en la spec que el logout es idempotente.
- 04d: responder `404` cuando el `SELECT` no devuelva filas.

**Pruebas:** 5 casos.
- `P0 · Autenticación › email con formato inválido → 400/422`
- `P0 · Requests sin token son rechazados › sin Authorization › GET /api/v1/users/profile/api-keys`
- `› con Bearer malformado › GET /api/v1/users/profile/api-keys`
- `› POST /users/logout sin token → 401 (spec)`
- `P0 · Validación de datos inválidos › GET /workflow/{id} con UUID inexistente → 404`

---

## Hallazgos adicionales

Están fuera de los 4 grupos solicitados y no se marcan con `it.fails` porque son intermitentes.

### BUG-05 — Login devuelve tokens inutilizables de forma intermitente (Alta)

`POST /users/login` responde `200` con un `accessToken` bien formado. Una fracción de esos tokens es tratada **de forma permanente** como anónima:
- `403 You don't have access to this entity` en listados;
- `500 TypeError` en `/users/me` (ver BUG-02a).

Reproducción: 20 logins seguidos con la misma cuenta. Cada token se validó contra `GET /roles/?limit=1`, de inmediato, a los 5 s y a los 20 s:

```
t+0     ..X.X.X.X.X.X.XX.X.X      (. = 200, X = 403)
t+20s   ..X.X.X.X.X.X.XX.X.X      ← el mismo patrón: no es un retraso de propagación
```

El fallo es estable por token y no por request, con un patrón casi alternado. Eso apunta a una colisión o sobrescritura en el almacén de sesiones cuando hay varias sesiones del mismo usuario. Al inicio de la jornada no se reproducía, y apareció después de acumular muchas sesiones de la cuenta de QA. En una ejecución también se observó que el token admin pasó a `401 login.invalid_token login.reauthenticate` a mitad de la suite.

**Mitigación en la suite:** `validLogin()` comprueba cada token antes de usarlo y reintenta, y un `beforeEach` renueva la sesión admin si dejó de ser válida. Sin esto, los `it.fails` podrían "pasar" por una sesión caída en vez de por el defecto. El caso `el access token obtenido autentica requests protegidos` usa el login sin verificar a propósito, y **puede fallar de forma intermitente mientras BUG-05 exista**.

### BUG-06 — `/users/me` responde 500 bajo concurrencia (Media)

Con tokens válidos, varias llamadas **en paralelo** a `GET /users/me` devuelven `500 TypeError` en parte de los requests. Las mismas llamadas en serie devuelven siempre `200`. Esto sugiere estado compartido entre requests en el handler o en el middleware de sesión.

### Observación — información de infraestructura en el JWT (Baja)

El payload del `accessToken` (que solo está codificado en base64, no cifrado) incluye el objeto `user` completo y `loginInfo.remoteAddr` con una IP interna de la red de contenedores (`172.21.x.x`). Se recomienda reducir los claims a `sub` y `exp`, más los mínimos imprescindibles.
