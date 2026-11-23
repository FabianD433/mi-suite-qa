# DatAscend API — Inventario de endpoints críticos (QA2)

> **Fuente:** OpenAPI 3.0.0 "DatAscend API" v1.1.0, extraído de `https://qa2.datascend.net/api/v1/docs/`.
> `/api/v1/openapi.json` responde **404**; el documento está embebido en `swagger-ui-init.js` (swagger-ui-express) y se lee **sin sesión**.
> **Columna "Observado en QA2":** sondeo real del 2026-11-23 con `fetch`, usando solo GET y recursos temporales `qa_api_*` que se crearon y eliminaron en el mismo momento.
> **Suite asociada:** [`critical-endpoints.api.spec.ts`](./critical-endpoints.api.spec.ts).

## Alcance y criterios

La spec expone **242 operaciones**. Este inventario cubre las **102** que sostienen la operación de DatAscend:

| Área | Tags OpenAPI |
|---|---|
| Autenticación / tokens | `Users-Functionality` (login, refresh, logout, register, reset, API keys) |
| Users | `Users`, `Users-Functionality` (`users-data/*`) |
| Roles / permisos | `Roles-Data`, `Roles-Functionality`, `Permissions` |
| Entidades y registros | `Entities-Data`, `Entities-Structure`, `Entities-Functionality` |
| Workflows / triggers | `Workflow` |
| Notifications | `Notifications` |

| Prioridad | Criterio | Operaciones |
|---|---|---|
| **P0 — Crítico** | Sin él la plataforma no opera (login, sesión, CRUD de registros, RBAC), o un fallo implica fuga de datos, escalamiento de privilegios o pérdida masiva/irreversible de datos. | 53 |
| **P1 — Alto** | Funcionalidad central pero con impacto acotado o alternativa: estructura de entidades (Studio), layouts, historial y utilidades de workflows, recuperación de contraseña, operaciones individuales de notificaciones. | 49 |

| Riesgo | Significado |
|---|---|
| `[Lectura]` | `GET`, sin efectos secundarios. |
| `[Escritura]` | `POST` / `PUT` / `PATCH`: crea o modifica estado. Incluye `login`/`refresh` porque emiten sesiones. |
| `[Destructivo]` | `DELETE`: elimina o revoca. |
| ⚠ _nota_ | Impacto **masivo o estructural** (borrado por filtro, truncate, DDL, sobrescritura de permisos). **Prohibido** en la suite automatizada. |

**Convenciones de la tabla:** `*` = requerido · `path:` / `query:` / `header:` = ubicación del parámetro · `body*: {campo*, +N opc.}` = payload JSON con N campos opcionales · "paginación" = `limit`, `page` · "filtros/orden" = `key`, `operator`, `value`, `condition`, `open_parens`, `close_parens`, `sort_field`, `sort_direction`.

**Notas transversales del contrato:**
- Autenticación: `Authorization: Bearer <accessToken>`. El login también emite la cookie `__Host-auth-token` (HttpOnly, Secure). `expiresIn` = 28 800 s (8 h).
- Todo endpoint de **registros** de entidad (`/entities/{entity}` y `/entities/{entity}/{id}`) exige el header `domain: <domainId>`. Sin él responde 400.
- `version` (query, requerido en Entities) = `active` en QA2 (`GET /configurations/versions/` → `["active"]`).
- Respuesta paginada: `{ data[], pagination: { currentPage, limit, numPages, recordsTotal, hasNextPage, hasPreviousPage, nextPage, previousPage } }`.
- Formato de error: `{ error: true, status, message, errors[] }`.

## Inventario

### 1. Autenticación y tokens

| Prio | Riesgo | Método | Ruta | Auth | Parámetros / payload requerido | Respuestas (spec) | Observado en QA2 |
|---|---|---|---|---|---|---|---|
| **P0** | `[Escritura]` | `POST` | `/api/v1/users/login` | **Pública** | body*: {`email`*, `password`*} | 200, 400, 401, 404, 500 | 200 ok · 400 faltan campos / JSON malformado · 401 password errónea **y email con formato inválido** · 404 usuario inexistente |
| **P0** | `[Escritura]` | `POST` | `/api/v1/users/reset-password` | **Pública** | body*: {`token`*, `new_password`*} | 200, 400, 500 | — |
| **P0** | `[Escritura]` | `POST` | `/api/v1/users/refresh` | Refresh | — | 200, 401, 500 | 200 rota tokens (el access anterior queda revocado → 401) · 401 sin token o con access token · ⚠ **500** con token basura |
| **P0** | `[Escritura]` | `POST` | `/api/v1/users/logout` | Bearer | — | 204, 401, 500 | 401 con token ya revocado · ⚠ **204 sin token** (spec: 401) |
| **P0** | `[Escritura]` | `PUT` | `/api/v1/users/change-password` | Bearer | body*: {`id`, `oldPassword`, `newPassword`} | 200, 500 | — |
| **P0** | `[Escritura]` | `POST` | `/api/v1/users/profile/api-keys` | Bearer | body*: {`name`*, +1 opc.} | 201, 400, 500 | 201 (secreto completo solo en esta respuesta) · 400 sin `name` · 400 `expiresAt` no ISO |
| **P0** | `[Destructivo]` | `DELETE` | `/api/v1/users/profile/api-keys/{keyId}` | Bearer | path:`keyId`* | 200, 404, 500 | 200 (revoca) |
| P1 | `[Escritura]` | `POST` | `/api/v1/users/register` | **Pública** | body*: {`email`*, `password`*, `firstName`*, `lastName`*} | 201, 400, 409, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/users/forgot-password` | **Pública** | body*: {`email`*} | 200, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/users/reset-password/validate` | **Pública** | query:`token`* | 200, 400, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/users/profile/api-keys` | Bearer | — | 200, 401, 500 | 200 (solo `keyPrefix`, sin secreto) · ⚠ **400** sin token / token inválido (spec: 401) |
| P1 | `[Destructivo]` | `DELETE` | `/api/v1/users/profile/api-keys/revoked/{keyId}` | Bearer | path:`keyId`* | 200, 400, 404, 500 | 200 tras revocar |

### 2. Users

| Prio | Riesgo | Método | Ruta | Auth | Parámetros / payload requerido | Respuestas (spec) | Observado en QA2 |
|---|---|---|---|---|---|---|---|
| **P0** | `[Lectura]` | `GET` | `/api/v1/users/me` | Bearer | — | 200, 500 | 200 (incluye `permissions[]`) · 401 token revocado · ⚠ **500** sin token / token basura (TypeError expuesto) |
| **P0** | `[Lectura]` | `GET` | `/api/v1/users/` | Bearer | opc: paginación, filtros/orden | 200, 500 | 200 paginado · 403 sin token · ⚠ **500** con `key` de columna inexistente (SQL expuesto) |
| **P0** | `[Escritura]` | `POST` | `/api/v1/users/` | Bearer | body*: {`firstName`*, `lastName`*, `email`*, `password`*, `active`*, +4 opc.} | 201, 400, 401, 404, 500 | — |
| **P0** | `[Escritura]` | `PUT` | `/api/v1/users/{id}` | Bearer | path:`id`*<br>body*: {`firstName`, `lastName`, `email`, `password`, …} | 200, 400, 401, 404, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/users/profile` | Bearer | — | 200, 500 | 200 (`data[0]`) · ⚠ **500** sin token (TypeError expuesto) |
| **P0** | `[Lectura]` | `GET` | `/api/v1/users/{userId}` | Bearer | path:`userId`* | 200, 400, 401, 500 | 200 · 404 UUID inexistente · ⚠ **500** id no-UUID (SQL expuesto) |
| **P0** | `[Destructivo]` ⚠ _`force=true` = hard delete_ | `DELETE` | `/api/v1/users-data/{userId}` | Bearer | path:`userId`*<br>opc: `force`, `reassignToUserId` | 200, 204, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/users-data/{userId}/domains` | Bearer | path:`userId`* | 200, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/users-data/{userId}/roles` | Bearer | path:`userId`* | 200, 500 | 200 `[{id, name, isAdmin}]` |
| P1 | `[Escritura]` | `PATCH` | `/api/v1/users-data/{userId}/domains/{domain}` | Bearer | path:`domain`, path:`userId`* | 200, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/users-data/{userId}/reactivate` | Bearer | path:`userId`* | 200, 404, 500 | — |

### 3. Roles y permisos

| Prio | Riesgo | Método | Ruta | Auth | Parámetros / payload requerido | Respuestas (spec) | Observado en QA2 |
|---|---|---|---|---|---|---|---|
| **P0** | `[Lectura]` | `GET` | `/api/v1/permissions/{roleId}` | Bearer | path:`roleId`* | 200, 400, 401, 404, 500 | 200 `[{name, permission}]` |
| **P0** | `[Lectura]` | `GET` | `/api/v1/permissions/all/{roleId}` | Bearer | path:`roleId`* | 200, 400, 401, 404, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/roles/` | Bearer | opc: paginación, filtros/orden | 200, 401, 500 | 200 paginado/filtrado/ordenado · 403 sin token · `limit=abc` ignorado · ⚠ **500** `limit=-1` (SQL expuesto) |
| **P0** | `[Escritura]` | `POST` | `/api/v1/roles/` | Bearer | body*: {`item`*, `description`*, +1 opc.} | 201, 401, 500 | 201 · 400 body vacío / tipos inválidos · ⚠ acepta `item` duplicado (201) |
| **P0** | `[Escritura]` | `PUT` | `/api/v1/roles/{roleId}` | Bearer | path:`roleId`*<br>body*: {`item`*, `description`*, +1 opc.} | 200, 401, 500 | 200 sobre rol temporal |
| **P0** | `[Lectura]` | `GET` | `/api/v1/roles/{roleId}` | Bearer | path:`roleId`* | 200, 401, 500 | 200 · 404 (UUID inexistente o no-UUID) |
| **P0** | `[Destructivo]` | `DELETE` | `/api/v1/roles/{roleId}` | Bearer | path:`roleId`* | 204, 401, 403, 500 | 204 · luego GET → 404 |
| **P0** | `[Lectura]` | `GET` | `/api/v1/roles/{roleId}/permissions/{objectType}/{objectItem}` | Bearer | path:`roleId`*, path:`objectType`, path:`objectItem`<br>opc: paginación | 200, 401, 500 | — |
| **P0** | `[Escritura]` ⚠ _sobrescribe permisos del rol_ | `PUT` | `/api/v1/roles/{roleId}/permissions` | Bearer | path:`roleId`*<br>body*: {`objectItem`*, `objectType`*, `permissions`*} | 200, 401, 500 | — |
| **P0** | `[Escritura]` | `PUT` | `/api/v1/roles/{roleId}/users/{userId}` | Bearer | path:`roleId`*, path:`userId`* | 200, 401, 500 | — |
| **P0** | `[Destructivo]` | `DELETE` | `/api/v1/roles/{roleId}/users/{userId}` | Bearer | path:`roleId`*, path:`userId`* | 200, 401, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/roles/objects` | Bearer | opc: paginación | 200, 401, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/roles/actions` | Bearer | opc: paginación | 200, 401, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/roles/permissions/{objectType}/{objectItem}` | Bearer | path:`objectType`, path:`objectItem`<br>opc: paginación | 200, 401, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/roles/{roleId}/users/` | Bearer | path:`roleId`*<br>opc: paginación | 200, 401, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/roles/{roleId}/domains/` | Bearer | path:`roleId`*<br>opc: paginación | 200, 400, 401, 404, 500 | — |
| P1 | `[Escritura]` | `PUT` | `/api/v1/roles/{roleId}/domains/{domainId}` | Bearer | path:`roleId`*, path:`domainId`* | 200, 400, 401, 404, 500 | — |
| P1 | `[Destructivo]` | `DELETE` | `/api/v1/roles/{roleId}/domains/{domainId}` | Bearer | path:`roleId`*, path:`domainId`* | 200, 400, 401, 404, 500 | — |

### 4. Entidades — registros (CRUD de datos)

| Prio | Riesgo | Método | Ruta | Auth | Parámetros / payload requerido | Respuestas (spec) | Observado en QA2 |
|---|---|---|---|---|---|---|---|
| **P0** | `[Escritura]` | `POST` | `/api/v1/entities/{entity}/bulk` | Bearer | path:`entity`*, query:`version`*<br>opc: `domain`<br>body*: [{dinámico según entidad}] | 201, 400, 403, 404, 405, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/entities/{entity}` | Bearer | query:`version`*, path:`entity`*<br>opc: paginación, filtros/orden, `enriched`, `domain`, `fields` | 200, 400, 403, 404, 500 | 200 paginado · **400 sin header `domain`** |
| **P0** | `[Escritura]` | `POST` | `/api/v1/entities/{entity}` | Bearer | path:`entity`*, query:`version`*<br>opc: `domain`<br>body: {dinámico según entidad} | 201, 400, 403, 404, 405, 500 | 201 · 400 propiedad inexistente · 400 sin `domain` · ⚠ **500** valor objeto en campo string |
| **P0** | `[Escritura]` ⚠ _actualiza todo lo que coincida con `filter`_ | `PATCH` | `/api/v1/entities/{entity}` | Bearer | query:`version`*, path:`entity`*, query:`filter`*<br>opc: `domain`<br>body: {dinámico según entidad} | 200, 400, 403, 404, 500 | 200 con `filter[id]=<id>` |
| **P0** | `[Destructivo]` ⚠ _borrado por filtro (masivo)_ | `DELETE` | `/api/v1/entities/{entity}` | Bearer | path:`entity`*, query:`filter`* | 200, 400, 401, 404, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/entities/{entity}/{id}` | Bearer | query:`version`*, path:`entity`*, path:`id`*<br>opc: `domain`, `enriched`, `fields` | 200, 400, 403, 404, 500 | 200 · 404 tras borrar |
| **P0** | `[Destructivo]` | `DELETE` | `/api/v1/entities/{entity}/{id}` | Bearer | query:`version`*, path:`entity`*, path:`id`*<br>opc: `domain` | 200, 400, 401, 404, 500 | 200 |
| P1 | `[Escritura]` | `POST` | `/api/v1/entities/records/tree` | Bearer | opc: `domain`<br>body*: {`entity`*, `record`*, +2 opc.} | 201, 400, 403, 404, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/entities/{entity}/saved-filters` | Bearer | path:`entity`* | 200, 500 | — |
| P1 | `[Escritura]` | `PUT` | `/api/v1/entities/{entity}/{id}/owner` | Bearer | path:`entity`*, path:`id`*, query:`version`*<br>body: {`newOwner`} | 200, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/entities/{entity}/import` | Bearer | path:`entity`*<br>opc: `domain`<br>body(multipart)*: {`type`*, `file`*, `mapping`*, `locale`*, `timezoneOffset`*} | 201, 400, 401, 404, 500 | — |

### 5. Entidades — estructura, permisos y layouts

| Prio | Riesgo | Método | Ruta | Auth | Parámetros / payload requerido | Respuestas (spec) | Observado en QA2 |
|---|---|---|---|---|---|---|---|
| **P0** | `[Destructivo]` ⚠ _elimina la entidad completa_ | `DELETE` | `/api/v1/entities/` | Bearer | query:`version`*<br>opc: `entities` | 200, 401, 404, 405, 409, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/entities/` | Bearer | query:`version`*<br>opc: `datasource`, `ids` | 200, 400, 404, 500 | 200 con `version=active` · 403 sin token |
| **P0** | `[Escritura]` ⚠ _cambia estructura (DDL)_ | `PUT` | `/api/v1/entities/{entity}` | Bearer | query:`version`*, path:`entity`*<br>body*: {`properties`, `fields`, `relationships`} | 200, 400, 401, 404, 405, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/entities/{entity}/permissions` | Bearer | query:`version`*, path:`entity`* | 200, 400, 404, 500 | — |
| **P0** | `[Escritura]` ⚠ _sobrescribe permisos de la entidad_ | `POST` | `/api/v1/entities/{entity}/permissions` | Bearer | query:`version`*, path:`entity`*<br>body*: [{`roleId`*, `actionId`*, `active`*, +3 opc.}] | 200, 400, 404, 500 | — |
| **P0** | `[Destructivo]` ⚠ _vacía toda la entidad_ | `DELETE` | `/api/v1/entities/{entity}/truncate` | Bearer | path:`entity`* | 204, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/entities/` | Bearer | query:`version`*<br>body*: {`objectLabel`, `objectName`, `datasource`, `showOnMenu`, …} | 201, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/entities/{entity}/layout` | Bearer | query:`version`*, path:`entity`*, query:`type`* | 200, 400, 404, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/entities/{entity}/layout` | Bearer | query:`version`*, path:`entity`*<br>body*: [{`type`*, `name`*, `components`*, +3 opc.}] | 200, 400, 404, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/entities/{entity}/fields` | Bearer | query:`version`*, path:`entity`*<br>body*: {`type`, `canReferenceUsers`, `inlineEdit`, `reportable`, …} | 200, 401, 409, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/entities/{entity}/fields` | Bearer | query:`version`*, path:`entity`* | 200, 401, 409, 500 | — |
| P1 | `[Escritura]` | `PUT` | `/api/v1/entities/{entity}/fields/{field}` | Bearer | query:`version`*, path:`entity`*, path:`field`*<br>body*: {`type`, `canReferenceUsers`, `inlineEdit`, `reportable`, …} | 200, 401, 404, 500 | — |
| P1 | `[Destructivo]` ⚠ _elimina columna (DDL)_ | `DELETE` | `/api/v1/entities/{entity}/fields/{field}` | Bearer | query:`version`*, path:`entity`*, path:`field`* | 200, 401, 409, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/entities/relationships` | Bearer | query:`version`*<br>body*: {`label`*, `relationName`*, `relationshipType`*, `lEntity`*, `rEntity`*, `lKey`*, `rKey`*, `localName`*, `foreignName`*, `foreignLabel`*, +16 opc.} | 201, 400, 401, 403, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/entities/{entity}/relationships` | Bearer | query:`version`*, path:`entity`*<br>opc: `direct` | 200, 401, 404, 500 | — |
| P1 | `[Escritura]` | `PUT` | `/api/v1/entities/{entity}/relationships/{relationship}` | Bearer | query:`version`*, path:`entity`*, path:`relationship`<br>body*: {`label`*, `relationName`*, `relationshipType`*, `lEntity`*, `rEntity`*, `lKey`*, `rKey`*, `localName`*, `foreignName`*, `foreignLabel`*, +6 opc.} | 200, 400, 401, 403, 500 | — |
| P1 | `[Destructivo]` ⚠ _elimina relación (DDL)_ | `DELETE` | `/api/v1/entities/{entity}/relationships/{relationship}` | Bearer | query:`version`*, path:`entity`*, path:`relationship` | 200, 401, 409, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/entities/formated` | Bearer | query:`version`* | 200, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/entities/{entity}/actions` | Bearer | path:`entity`* | 200, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/entities/{entity}/usage` | Bearer | query:`version`*, path:`entity`* | 200, 401, 404, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/entities/{entity}/{attribute}` | Bearer | path:`entity`, path:`attribute`<br>opc: `version` | 200, 500 | — |
| P1 | `[Escritura]` | `PUT` | `/api/v1/entities/{entity}/{id}/domain` | Bearer | query:`version`*, path:`entity`*, path:`id`*<br>body: {`newDomain`} | 200, 400, 403, 404, 500 | — |

### 6. Workflows y triggers

| Prio | Riesgo | Método | Ruta | Auth | Parámetros / payload requerido | Respuestas (spec) | Observado en QA2 |
|---|---|---|---|---|---|---|---|
| **P0** | `[Escritura]` | `POST` | `/api/v1/workflow` | Bearer | body*: {`id`*, `name`*, `createdAt`*, `updatedAt`*, `active`*, +10 opc.} | 201, 400, 401, 404, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/workflow` | Bearer | opc: paginación, filtros/orden, `active`, `type` | 201, 400, 401, 404, 500 | 200 paginado (spec dice 201) · 403 sin token |
| **P0** | `[Escritura]` | `POST` | `/api/v1/workflow/field-change` | Bearer | body*: {`entity`*, `field`*, +3 opc.} | 200, 400, 401, 403, 404, 500 | — |
| **P0** | `[Escritura]` | `PUT` | `/api/v1/workflow/{id}` | Bearer | path:`id`*<br>body*: {`id`*, `name`*, `createdAt`*, `updatedAt`*, `active`*, +10 opc.} | 201, 400, 401, 404, 500 | — |
| **P0** | `[Destructivo]` | `DELETE` | `/api/v1/workflow/{id}` | Bearer | path:`id`* | 201, 400, 401, 404, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/workflow/{id}` | Bearer | path:`id`* | 201, 400, 401, 404, 500 | ⚠ **200 `data: []`** con UUID inexistente (spec: 404) · ⚠ **500** id no-UUID (SQL expuesto) |
| **P0** | `[Escritura]` ⚠ _efectos según el workflow_ | `POST` | `/api/v1/workflow/{id}/execute` | Bearer | path:`id`*<br>body*: {dinámico según entidad} | 201, 400, 401, 404, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/workflow/webhook/{id}` | **Pública** | path:`id`* | 400, 401, 404, 500 | — |
| **P0** | `[Escritura]` | `POST` | `/api/v1/workflow/webhook/{id}` | **Pública** | path:`id`*<br>body*: {dinámico según entidad} | 400, 401, 404, 500 | — |
| **P0** | `[Escritura]` | `POST` | `/api/v1/workflow/action/{id}/{recordId}` | Bearer | path:`id`*, path:`recordId`* | 400, 401, 404, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/workflow/nodes` | **Pública** | — | 201, 400, 401, 404, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/workflow/sse` | Bearer | query:`sessionId`* | 200, 400, 401, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/workflow/sse/{sessionId}` | Bearer | path:`sessionId`* | 200, 400, 401, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/workflow/test` | Bearer | body*: {`workflow`*, `triggerData`*} | 200, 400, 401, 404, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/workflow/child-row-change` | Bearer | body*: {`entity`*, `relation`*, `event`*, +3 opc.} | 200, 400, 401, 403, 404, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/workflow/history` | Bearer | opc: paginación, filtros/orden | 201, 400, 401, 404, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/workflow/history/{id}` | Bearer | path:`id`* | 201, 400, 401, 404, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/workflow/{id}/history` | Bearer | path:`id`*<br>opc: paginación, filtros/orden | 201, 400, 401, 404, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/workflow/entity/{entityId}` | Bearer | path:`entityId`* | 200, 401, 404, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/workflow/explain` | Bearer | body*: {`nodes`*, +8 opc.} | 200, 400, 401, 500 | — |
| P1 | `[Lectura]` | `GET` | `/api/v1/workflow/{id}/explain` | Bearer | path:`id`* | 200, 401, 404, 500 | — |
| P1 | `[Escritura]` | `POST` | `/api/v1/workflow/{id}/duplicate` | Bearer | path:`id`*<br>body*: {`name`*} | 201, 400, 401, 404, 500 | — |

### 7. Notifications

| Prio | Riesgo | Método | Ruta | Auth | Parámetros / payload requerido | Respuestas (spec) | Observado en QA2 |
|---|---|---|---|---|---|---|---|
| **P0** | `[Lectura]` | `GET` | `/api/v1/notifications` | Bearer | opc: paginación, `type`, `read` | 200, 400, 401, 500 | 200 paginado · 400 `type` inválido · `read=maybe` ignorado · 403 sin token |
| **P0** | `[Destructivo]` ⚠ _borra todas las notificaciones del usuario_ | `DELETE` | `/api/v1/notifications` | Bearer | — | 204, 401, 403, 500 | — |
| **P0** | `[Lectura]` | `GET` | `/api/v1/notifications/unread-count` | Bearer | — | 200, 401, 500 | 200 `{unreadCount}` |
| P1 | `[Escritura]` | `PUT` | `/api/v1/notifications/{id}/read` | Bearer | path:`id`* | 204, 400, 401, 403, 404, 500 | — |
| P1 | `[Escritura]` ⚠ _marca todas como leídas_ | `PUT` | `/api/v1/notifications/read-all` | Bearer | — | 204, 400, 401, 403, 500 | — |
| P1 | `[Destructivo]` | `DELETE` | `/api/v1/notifications/{id}` | Bearer | path:`id`* | 204, 400, 401, 403, 404, 500 | — |

## Desviaciones y defectos detectados en QA2

Detectados en el sondeo y cubiertos por la suite. Las pruebas de D1–D8 están marcadas con `it.fails`: validan el contrato esperado y pasan mientras el defecto exista. El detalle técnico y la reproducción están en [BACKEND_BUGS_REPORT.md](./BACKEND_BUGS_REPORT.md) (BUG-01 a BUG-04, más BUG-05/06).

| # | Severidad | Endpoint | Esperado | Observado |
|---|---|---|---|---|
| D1 | **Alta** (seguridad) | `GET /roles/?limit=-1`, `GET /users/?key=<col inexistente>`, `GET /users/{no-uuid}`, `GET /workflow/{no-uuid}` | 400/404 con mensaje genérico | **500 con la consulta SQL completa** en `message` (esquema `dasec`, tablas, columnas) |
| D2 | **Alta** | `GET /users/me`, `GET /users/profile` sin token o con token basura | 401 | **500** `TypeError: undefined is not an object (evaluating 'r.id')`, que expone un error interno |
| D3 | Media | `POST /users/refresh` con token malformado | 401 | **500** `TypeError … 's.loginInfo'` |
| D4 | Media | `POST /entities/{entity}` con un objeto en un campo string | 400/422 | **500** `JSON.stringify cannot serialize cyclic structures` |
| D5 | Media | `GET /users/profile/api-keys` sin token | 401 | **400** "User authentication required." |
| D6 | Media | `POST /users/login` con email de formato inválido | 400 (validación) | **401** `login.bad_email` |
| D7 | Baja | `POST /users/logout` sin token | 401 (spec) | **204** |
| D8 | Baja | `GET /workflow/{uuid inexistente}` | 404 | **200** con `data: []` |
| D9 | Info | Listados sin token (`/users`, `/roles`, `/workflow`, `/notifications`, `/entities`) | 401 (spec) | **403**, porque la petición cae en el rol *Anonymous*. La suite lo acepta como rechazo válido. |
| D10 | Info | `POST /roles/` | — | Acepta `item` duplicado (crea dos roles con el mismo nombre) |
| D11 | Info | `GET /roles/?limit=abc`, `GET /notifications?read=maybe` | 400 | Parámetro inválido **ignorado** en silencio (200) |
| D12 | Info | Spec | — | `GET /workflow*` documenta **201** para lecturas; en la práctica responde 200 |

Comportamientos **correctos** verificados:
- `refresh` rota el par de tokens y **revoca** el access token anterior.
- `logout` revoca access y refresh.
- El secreto de la API key solo aparece en la respuesta del `POST`; el listado expone solo `keyPrefix`.
- `PATCH /entities/{e}?filter[id]=` afecta únicamente al registro filtrado.

## Cobertura de la suite `critical-endpoints.api.spec.ts`

Vitest + `fetch` nativo, sin navegador.

| Bloque | Endpoints | Casos |
|---|---|---|
| P0 · Autenticación | `POST /users/login`, `/refresh`, `/logout`, `GET /users/me` | Login OK (tokens JWT, cookie `HttpOnly; Secure`); 401 por password errónea; 404 por usuario inexistente; 400 por campos faltantes o JSON malformado; email inválido (D6); rotación en refresh; refresh 401 (sin token / access token / basura, D3); logout revoca |
| P0 · Perfil y permisos | `GET /users/me`, `/users/profile`, `/users-data/{id}/roles`, `/roles/{id}`, `/permissions/{roleId}`, `/users/{id}` | Identidad, `permissions[]` y roles consistentes; sin campos sensibles (`password`, `hash`, `salt`); 404 para UUID inexistente |
| P0 · Paginación y filtros | `GET /roles`, `/users`, `/notifications`, `/notifications/unread-count`, `/workflow`, `/entities`, `/entities/{entity}` | Metadatos coherentes; páginas sin solapamiento; página fuera de rango; `eq`; orden asc/desc; `type`/`read`; `unreadCount` igual al total de no leídas |
| P0 · Sin token | 9 GET protegidos × (sin header, Bearer malformado) + token revocado, logout y `POST /roles` | 401/403 sin datos ni 5xx (D2, D5, D7, D9); `POST` sin token no crea nada |
| P0 · Datos inválidos | `POST /roles`, `/users/profile/api-keys`, `/entities/{entity}`; `GET` con parámetros inválidos | 400/422 controlado y sin SQL ni stack trace (D1, D4, D8) |
| P0 · CRUD temporal | Role, API key, registro de entidad | `POST → GET → PUT/PATCH → filtro → DELETE → 404`, todo sobre `qa_api_<timestamp>_*` |

**Reglas de seguridad aplicadas por código:**
1. `PUT`, `PATCH` y `DELETE` solo se envían mediante `mutate()`. Esta función rechaza, **antes de enviar**, cualquier id que no haya sido creado en la misma ejecución, y las rutas masivas: `/truncate`, `DELETE /entities/`, borrado por `filter` en `/entities/{e}`, `DELETE /notifications` y `read-all`. Un test lo verifica.
2. Todo recurso se crea con prefijo `qa_api_`. Se elimina en `finally` y, como red de seguridad, en `afterAll`, que solo borra ids registrados en esa ejecución; no hay barridos por prefijo sobre datos preexistentes.
3. Si un `POST` inválido es aceptado por error (2xx), el recurso creado se elimina de inmediato.

**Ejecución:**

```bash
npx vitest run tests/APIs/critical-endpoints.api.spec.ts
```

Variables (`.env`): `DATASCEND_BASE_URL`, `DATASCEND_EMAIL`, `DATASCEND_PASSWORD`. Opcionales:
- `DATASCEND_API_RECORD_ENTITY_ID`: entidad con campos string `name` y `status`; por defecto, *Sprint*.
- `DATASCEND_API_DOMAIN_ID`: por defecto, el primer dominio del usuario.

**Resultado en QA2 (2026-11-23):** 69 de 69 en verde: 54 validan el comportamiento correcto y 15 son `it.fails` de defectos conocidos. Tras la ejecución no quedaron recursos `qa_api_*` en QA2. Cuando el backend corrija un defecto, su `it.fails` pasará a rojo: ahí hay que quitar el `.fails`.

## Fuera de alcance

Tags no inventariados (P2 o configuración de plataforma): WhatsApp, Revisions, SavedFilters, Custom Queries, Environment Config / Variables, Domains, Menu, Category Menus, Datasources, Jobs, Config (versions/deploy), Packages, Docs, Logs Errors, Studio, AI Config / Assistant, Fuzzy Search, Email Config, MCP, Pages, Files y push-subscriptions.

Algunos merecen una revisión de seguridad aparte:
- `POST /configurations/deploy`
- `POST /packages/install`
- `DELETE /revisions`
- `POST /files/orphans/cleanup`
- `DELETE /environment-config/`
