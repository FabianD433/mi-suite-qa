/**
 * Suite de API pura (sin navegador) para los flujos P0 de DatAscend en QA2.
 * Inventario y contrato de referencia: tests/APIs/API_CRITICAL_ENDPOINTS.md
 *
 * REGLAS DE SEGURIDAD DE DATOS (aplicadas por código, no solo por convención):
 *  - PUT / PATCH / DELETE solo pasan por `mutate()`, que exige un id registrado en `owned`,
 *    es decir, creado por esta misma ejecución con prefijo `qa_api_`. Cualquier otro id lanza error
 *    antes de enviar la petición.
 *  - Nunca se usan endpoints de borrado masivo (DELETE /entities/{e}?filter, /truncate,
 *    DELETE /notifications, DELETE /entities/ ...): `mutate()` los rechaza por ruta.
 *  - Todo recurso creado se elimina en `finally` y, como red de seguridad, en `afterAll`.
 *  - Las pruebas de validación que envían POST inválidos limpian el recurso si el backend
 *    lo crea por error (2xx), para no dejar basura aunque la prueba falle.
 *
 * DEFECTOS CONOCIDOS (`it.fails`):
 *  - Los casos marcados con `it.fails` / `it.fails.each` validan el contrato correcto, pero QA2 hoy
 *    lo incumple. Cada uno referencia su BUG-xx en tests/APIs/BACKEND_BUGS_REPORT.md.
 *    Las aserciones se mantienen intactas: el caso "pasa" mientras el defecto exista.
 *  - Cuando el backend se corrija, el `it.fails` empezará a FALLAR. Es la señal para quitar el `.fails`.
 *  - `it.fails` acepta cualquier fallo, también un 401 por sesión caída. Por eso el token admin
 *    se valida antes de cada test (`beforeEach` + `validLogin`, ver BUG-05). Así el fallo
 *    proviene del defecto y no de la sesión.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, requireEnv } from '../support/env';

loadEnv();

const BASE_URL = (process.env.DATASCEND_BASE_URL ?? 'https://qa2.datascend.net').replace(/\/$/, '');
const EMAIL = requireEnv('DATASCEND_EMAIL');
const PASSWORD = requireEnv('DATASCEND_PASSWORD');
/** Entidad de pruebas con campos string `name` y `status` (Sprint en QA2). */
const RECORD_ENTITY_ID = process.env.DATASCEND_API_RECORD_ENTITY_ID ?? 'a1d50794-eeea-4e55-9b94-e25f9ed5b3ee';
const PREFIX = 'qa_api_';
const RUN = `${PREFIX}${Date.now()}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
/** Señales de que un error interno (SQL, stack, TypeError) se filtró al cliente. */
const LEAK = /select .* from|invalid input syntax|"dasec"\.|TypeError|ReferenceError|at \w+ \(/i;

// ────────────────────────────────────────────────────────────────────────────────
// Cliente HTTP (fetch nativo)
// ────────────────────────────────────────────────────────────────────────────────

interface ApiResponse<T = any> {
  status: number;
  json: T;
  headers: Headers;
}

interface Pagination {
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  recordsTotal: number;
  currentPage: number;
  numPages: number | null;
  limit: number | null;
}

interface RequestOptions {
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  domain?: string;
}

let adminToken = '';
let domainId = '';

async function request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const token = opts.token === undefined ? adminToken : opts.token;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined || opts.rawBody !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.domain) headers.domain = opts.domain;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    redirect: 'manual',
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* respuesta no JSON: se deja como texto */
  }
  return { status: res.status, json: json as T, headers: res.headers };
}

const get = <T = any>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts);
const post = <T = any>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body });

// ────────────────────────────────────────────────────────────────────────────────
// Guardas de seguridad de datos
// ────────────────────────────────────────────────────────────────────────────────

type Kind = 'role' | 'apiKey' | 'record';
/** Ids creados por ESTA ejecución. Único origen permitido para PUT/PATCH/DELETE. */
const owned = new Map<string, Kind>();
const deleted = new Set<string>();

const FORBIDDEN_ROUTES: RegExp[] = [
  /\/truncate(\?|$)/,
  /^\/api\/v1\/entities\/?(\?|$)/, // DELETE /entities/ elimina entidades completas
  /^\/api\/v1\/entities\/[^/?]+\/?\?(.*&)?filter/i, // borrado/patch masivo por filtro (salvo filtro por id propio, ver abajo)
  /^\/api\/v1\/notifications\/?(\?|$)/, // DELETE de todas las notificaciones
  /^\/api\/v1\/notifications\/read-all/,
  /^\/api\/v1\/revisions/,
];

function own(id: string, kind: Kind, name: string): string {
  expect(name.startsWith(PREFIX), `recurso temporal sin prefijo ${PREFIX}: ${name}`).toBe(true);
  expect(id, `id del recurso temporal ${name}`).toMatch(UUID);
  owned.set(id, kind);
  return id;
}

/**
 * Única vía para PUT/PATCH/DELETE. Exige que `ownedId` haya sido creado por esta ejecución
 * y que aparezca en la ruta; bloquea rutas de borrado masivo.
 */
async function mutate<T = any>(
  method: 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  ownedId: string,
  opts: RequestOptions = {},
): Promise<ApiResponse<T>> {
  if (!owned.has(ownedId)) throw new Error(`BLOQUEADO: ${method} ${path} sobre un id que no creó esta suite (${ownedId})`);
  if (!path.includes(ownedId)) throw new Error(`BLOQUEADO: ${method} ${path} no apunta al recurso temporal ${ownedId}`);
  const isOwnIdFilter = new RegExp(`[?&]filter%5Bid%5D=${ownedId}(&|$)`).test(path);
  if (FORBIDDEN_ROUTES.some((r) => r.test(path)) && !(method === 'PATCH' && isOwnIdFilter)) {
    throw new Error(`BLOQUEADO: ${method} ${path} es un endpoint masivo/destructivo prohibido en esta suite`);
  }
  return request<T>(method, path, opts);
}

/** Elimina un recurso temporal. Idempotente: se puede llamar desde `finally` y `afterAll`. */
async function cleanup(id: string): Promise<void> {
  const kind = owned.get(id);
  if (!kind || deleted.has(id)) return;
  if (kind === 'role') {
    const r = await mutate('DELETE', `/api/v1/roles/${id}`, id);
    if ([200, 204, 404].includes(r.status)) deleted.add(id);
  } else if (kind === 'apiKey') {
    await mutate('DELETE', `/api/v1/users/profile/api-keys/${id}`, id); // revocar (idempotente)
    const r = await mutate('DELETE', `/api/v1/users/profile/api-keys/revoked/${id}`, id);
    if ([200, 204, 404].includes(r.status)) deleted.add(id);
  } else {
    const r = await mutate('DELETE', `/api/v1/entities/${RECORD_ENTITY_ID}/${id}?version=active`, id, { domain: domainId });
    if ([200, 204, 404].includes(r.status)) deleted.add(id);
  }
}

/** Si un POST que debía fallar creó algo, se registra y se borra para no dejar basura. */
async function cleanupIfCreated(kind: Kind, res: ApiResponse, label: string): Promise<void> {
  if (res.status >= 300) return;
  const data = Array.isArray(res.json?.data) ? res.json.data[0] : res.json?.data;
  if (data?.id && UUID.test(data.id)) {
    owned.set(data.id, kind); // se creó a partir de un payload qa_api_* de esta suite
    await cleanup(data.id);
  }
  console.warn(`[cleanup] ${label}: el backend aceptó un payload inválido (HTTP ${res.status}); recurso eliminado.`);
}

// ────────────────────────────────────────────────────────────────────────────────
// Aserciones comunes
// ────────────────────────────────────────────────────────────────────────────────

/** El error es controlado: no es 5xx y no expone SQL/stack traces. */
function expectControlledError(res: ApiResponse, allowed: number[]): void {
  const body = typeof res.json === 'string' ? res.json : JSON.stringify(res.json);
  expect(body, 'el mensaje de error no debe exponer SQL ni errores internos').not.toMatch(LEAK);
  expect(res.status, `HTTP esperado ${allowed.join('/')} (respuesta: ${body.slice(0, 200)})`).toBeOneOf(allowed);
}

function expectPagination(p: Pagination | undefined, page: number, limit: number): asserts p is Pagination {
  expect(p, 'objeto pagination').toBeDefined();
  expect(p).toMatchObject({ currentPage: page, limit });
  expect(p!.recordsTotal).toBeTypeOf('number');
  expect(p!.numPages).toBe(Math.ceil(p!.recordsTotal / limit));
  expect(p!.hasPreviousPage).toBe(page > 1);
  expect(p!.hasNextPage).toBe(page < Math.ceil(p!.recordsTotal / limit));
}

const filterQs = (key: string, operator: string, value: string) =>
  `key=${encodeURIComponent(key)}&operator=${operator}&value=${encodeURIComponent(value)}&condition=AND&open_parens=0&close_parens=0`;

/** Recorre el JSON buscando claves que nunca deberían viajar al cliente. */
function sensitiveKeys(o: unknown, path = ''): string[] {
  if (!o || typeof o !== 'object') return [];
  return Object.entries(o).flatMap(([k, v]) => [
    ...(/^(password|passwordHash|hash|salt)$/i.test(k) ? [`${path}${k}`] : []),
    ...sensitiveKeys(v, `${path}${k}.`),
  ]);
}

async function login(email = EMAIL, password = PASSWORD) {
  return post<{ accessToken: string; refreshToken: string; expiresIn: number; tokenType: string; error: boolean; message: string }>(
    '/api/v1/users/login',
    { email, password },
    { token: null },
  );
}

/**
 * Login cuyo access token se comprueba antes de usarlo. BUG-05: QA2 emite de forma intermitente
 * tokens (login 200 OK) que el backend trata como anónimos de forma permanente (403/500).
 */
async function validLogin(attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    const res = await login();
    if (res.status !== 200) continue;
    const probe = await get('/api/v1/roles/?limit=1&page=1', { token: res.json.accessToken });
    if (probe.status === 200) return res;
  }
  throw new Error(`No se obtuvo un access token utilizable tras ${attempts} logins (BUG-05)`);
}

// ────────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ────────────────────────────────────────────────────────────────────────────────

let me: { id: string; email: string; isAdmin: boolean; permissions: { roleId: string; role: string; objectItem: string; actionItem: string }[] };

beforeAll(async () => {
  adminToken = (await validLogin()).json.accessToken;
  me = (await get('/api/v1/users/me')).json.data;
  const domains = await get<{ data: string[] }>(`/api/v1/users-data/${me.id}/domains`);
  domainId = process.env.DATASCEND_API_DOMAIN_ID ?? domains.json.data[0];
  expect(domainId, 'el usuario de QA necesita al menos un dominio').toMatch(UUID);
});

/** La sesión admin debe estar viva antes de cada caso; si QA2 la invalidó, se renueva. */
beforeEach(async () => {
  if ((await get('/api/v1/roles/?limit=1&page=1')).status !== 200) {
    adminToken = (await validLogin()).json.accessToken;
  }
});

afterAll(async () => {
  // Red de seguridad: solo ids creados por esta ejecución.
  for (const id of owned.keys()) await cleanup(id).catch((e) => console.error(`[cleanup] ${id}:`, e));
  const leftovers = [...owned.keys()].filter((id) => !deleted.has(id));
  if (leftovers.length) console.error(`[cleanup] Recursos temporales sin borrar: ${leftovers.join(', ')}`);
});

// ════════════════════════════════════════════════════════════════════════════════
// P0 · Autenticación
// ════════════════════════════════════════════════════════════════════════════════

describe('P0 · Autenticación (POST /users/login, /refresh, /logout)', () => {
  it('login válido devuelve 200 con access/refresh token Bearer y cookie segura', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ error: false, tokenType: 'Bearer' });
    expect(res.json.accessToken).toMatch(JWT);
    expect(res.json.refreshToken).toMatch(JWT);
    expect(res.json.accessToken).not.toBe(res.json.refreshToken);
    expect(res.json.expiresIn).toBeGreaterThan(0);
    expect(sensitiveKeys(res.json)).toEqual([]);

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie, 'cookie de sesión').toMatch(/__Host-auth-token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
  });

  it('el access token obtenido autentica requests protegidos', async () => {
    const { json } = await login();
    const res = await get('/api/v1/users/me', { token: json.accessToken });
    expect(res.status).toBe(200);
    expect(res.json.data.email.trim().toLowerCase()).toBe(EMAIL.trim().toLowerCase());
  });

  it('password incorrecta → 401 sin emitir tokens', async () => {
    const res = await login(EMAIL, `${RUN}_Wrong!9`);
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ error: true, accessToken: '', refreshToken: '' });
  });

  it('usuario inexistente → 404 sin emitir tokens (comportamiento documentado en la spec)', async () => {
    const res = await login(`${RUN}_nobody@example.com`, 'Whatever-123!');
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: true, accessToken: '', refreshToken: '' });
  });

  it.each([
    ['body vacío', {}],
    ['sin password', { email: EMAIL }],
    ['sin email', { password: 'x' }],
  ])('credenciales incompletas (%s) → 400', async (_label, body) => {
    const res = await post('/api/v1/users/login', body, { token: null });
    expectControlledError(res, [400, 422]);
    expect(res.json.accessToken ?? '').toBe('');
  });

  it('JSON malformado → 400', async () => {
    const res = await request('POST', '/api/v1/users/login', { token: null, rawBody: '{"email": ' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(true);
  });

  // BUG-04a (grupo 4, códigos HTTP inconsistentes): QA2 responde 401 `login.bad_email` a un error de
  // validación del payload; debería ser 400/422. Ver BACKEND_BUGS_REPORT.md.
  it.fails('email con formato inválido → 400/422 (validación de payload)', async () => {
    const res = await post('/api/v1/users/login', { email: 'not-an-email', password: 'x' }, { token: null });
    expectControlledError(res, [400, 422]);
    expect(res.json.accessToken ?? '').toBe('');
  });

  it('refresh con refresh token válido emite tokens nuevos y revoca el access token anterior', async () => {
    const session = (await validLogin()).json;
    const res = await post('/api/v1/users/refresh', undefined, { token: session.refreshToken });
    expect(res.status).toBe(200);
    expect(res.json.accessToken).toMatch(JWT);
    expect(res.json.accessToken).not.toBe(session.accessToken);

    expect((await get('/api/v1/users/me', { token: res.json.accessToken })).status).toBe(200);
    expect((await get('/api/v1/users/me', { token: session.accessToken })).status, 'access token rotado').toBe(401);
  });

  it.each([
    ['sin token', null],
    ['con un access token en vez de refresh', 'ACCESS'],
  ])('refresh %s → 401', async (_label, tok) => {
    const token = tok === 'ACCESS' ? (await login()).json.accessToken : tok;
    const res = await post('/api/v1/users/refresh', undefined, { token });
    expectControlledError(res, [401]);
  });

  // BUG-02c (grupo 2, TypeError sin Auth Guard): el handler de refresh desreferencia la sesión
  // sin validar el token y responde 500 `TypeError … evaluating 's.loginInfo'`. Ver BACKEND_BUGS_REPORT.md.
  it.fails('refresh con un token malformado → 401', async () => {
    const res = await post('/api/v1/users/refresh', undefined, { token: 'not.a.valid-token' });
    expectControlledError(res, [401]);
  });

  it('logout invalida el access token (luego 401)', async () => {
    const session = (await validLogin()).json;
    const res = await post('/api/v1/users/logout', undefined, { token: session.accessToken });
    expect(res.status).toBe(204);
    expect((await get('/api/v1/users/me', { token: session.accessToken })).status).toBe(401);
    expect((await post('/api/v1/users/refresh', undefined, { token: session.refreshToken })).status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// P0 · Perfil y permisos
// ════════════════════════════════════════════════════════════════════════════════

describe('P0 · Perfil y permisos', () => {
  it('GET /users/me devuelve el usuario autenticado con sus permisos y sin datos sensibles', async () => {
    const res = await get('/api/v1/users/me');
    expect(res.status).toBe(200);
    const u = res.json.data;
    expect(u.id).toMatch(UUID);
    expect(u.email.trim().toLowerCase()).toBe(EMAIL.trim().toLowerCase());
    expect(u.active).toBe(true);
    expect(Array.isArray(u.permissions) && u.permissions.length).toBeGreaterThan(0);
    for (const p of u.permissions.slice(0, 20)) {
      expect(p).toMatchObject({ actionItem: expect.any(String), objectItem: expect.any(String), roleId: expect.stringMatching(UUID) });
    }
    expect(sensitiveKeys(res.json)).toEqual([]);
  });

  it('GET /users/profile devuelve preferencias y roles del usuario', async () => {
    const res = await get('/api/v1/users/profile');
    expect(res.status).toBe(200);
    const profile = res.json.data[0];
    expect(profile.id).toBe(me.id);
    expect(profile.preferences).toMatchObject({ language: expect.any(String), timeZone: expect.any(String) });
    expect(profile.roles.length).toBeGreaterThan(0);
    expect(sensitiveKeys(res.json)).toEqual([]);
  });

  it('GET /users-data/{me}/roles coincide con los roles de los permisos de /users/me', async () => {
    const res = await get(`/api/v1/users-data/${me.id}/roles`);
    expect(res.status).toBe(200);
    const roleIds = res.json.data.map((r: { id: string }) => r.id).sort();
    const fromPermissions = [...new Set(me.permissions.map((p) => p.roleId))].sort();
    expect(roleIds).toEqual(expect.arrayContaining(fromPermissions));
  });

  it('GET /roles/{roleId} y /permissions/{roleId} del rol del usuario', async () => {
    const roleId = me.permissions[0].roleId;
    const role = await get(`/api/v1/roles/${roleId}`);
    expect(role.status).toBe(200);
    expect(role.json.data).toMatchObject({ id: roleId, item: me.permissions[0].role });

    const perms = await get(`/api/v1/permissions/${roleId}`);
    expect(perms.status).toBe(200);
    expect(perms.json.data.length).toBeGreaterThan(0);
    for (const p of perms.json.data) expect(p).toMatchObject({ name: expect.any(String), permission: expect.any(Boolean) });
  });

  it('GET /users/{id} con UUID inexistente → 404', async () => {
    const res = await get('/api/v1/users/00000000-0000-4000-8000-000000000000');
    expectControlledError(res, [404]);
  });

  it('GET /roles/{id} con UUID inexistente → 404', async () => {
    const res = await get('/api/v1/roles/00000000-0000-4000-8000-000000000000');
    expectControlledError(res, [404]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// P0 · Consultas con paginación y filtros (solo lectura)
// ════════════════════════════════════════════════════════════════════════════════

describe('P0 · Paginación y filtros', () => {
  it('GET /roles: páginas consecutivas sin solapamiento y metadatos coherentes', async () => {
    const p1 = await get('/api/v1/roles/?limit=2&page=1');
    const p2 = await get('/api/v1/roles/?limit=2&page=2');
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expectPagination(p1.json.pagination, 1, 2);
    expectPagination(p2.json.pagination, 2, 2);
    expect(p1.json.data.length).toBeLessThanOrEqual(2);
    const ids1 = p1.json.data.map((r: { id: string }) => r.id);
    const ids2 = p2.json.data.map((r: { id: string }) => r.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toEqual([]);
  });

  it('GET /roles: página fuera de rango devuelve lista vacía', async () => {
    const res = await get('/api/v1/roles/?limit=2&page=9999');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual([]);
    expect(res.json.pagination.hasNextPage).toBe(false);
  });

  it('GET /roles: filtro key/operator/value=eq devuelve solo coincidencias', async () => {
    const roleName = me.permissions[0].role;
    const res = await get(`/api/v1/roles/?limit=10&page=1&${filterQs('item', 'eq', roleName)}`);
    expect(res.status).toBe(200);
    expect(res.json.data.length).toBeGreaterThan(0);
    for (const r of res.json.data) expect(r.item).toBe(roleName);
  });

  it('GET /roles: sort_direction desc es el inverso de asc', async () => {
    const asc = await get('/api/v1/roles/?limit=50&page=1&sort_field=item&sort_direction=asc');
    const desc = await get('/api/v1/roles/?limit=50&page=1&sort_field=item&sort_direction=desc');
    expect(asc.status).toBe(200);
    expect(desc.status).toBe(200);
    const names = (r: ApiResponse) => r.json.data.map((x: { item: string }) => x.item);
    expect(names(desc)).toEqual([...names(asc)].reverse());
  });

  it('GET /users: filtro por email exacto devuelve solo al usuario autenticado', async () => {
    const res = await get(`/api/v1/users/?limit=5&page=1&${filterQs('email', 'eq', me.email)}`);
    expect(res.status).toBe(200);
    expect(res.json.data.map((u: { id: string }) => u.id)).toEqual([me.id]);
    expect(res.json.pagination.recordsTotal).toBe(1);
    expect(sensitiveKeys(res.json)).toEqual([]);
  });

  it('GET /notifications: respeta limit y los filtros type/read', async () => {
    const [all, system, unread, count] = await Promise.all([
      get('/api/v1/notifications?limit=3&page=1'),
      get('/api/v1/notifications?limit=5&page=1&type=system'),
      get('/api/v1/notifications?limit=5&page=1&read=false'),
      get('/api/v1/notifications/unread-count'),
    ]);
    for (const r of [all, system, unread, count]) expect(r.status).toBe(200);
    expectPagination(all.json.pagination, 1, 3);
    expect(all.json.data.length).toBeLessThanOrEqual(3);
    for (const n of all.json.data) expect(n.userId, 'solo notificaciones propias').toBe(me.id);
    for (const n of system.json.data) expect(n.type).toBe('system');
    for (const n of unread.json.data) expect(n.readAt).toBeNull();
    expect(count.json.data.unreadCount).toBeTypeOf('number');
    expect(unread.json.pagination.recordsTotal).toBe(count.json.data.unreadCount);
  });

  it('GET /workflow: paginación y filtro por type', async () => {
    const res = await get('/api/v1/workflow?limit=2&page=1&type=Basic');
    expect(res.status).toBe(200);
    expectPagination(res.json.pagination, 1, 2);
    expect(res.json.data.length).toBeLessThanOrEqual(2);
    for (const w of res.json.data) expect(w.type).toBe('Basic');
  });

  it('GET /entities: lista de entidades de la versión activa', async () => {
    const res = await get('/api/v1/entities/?version=active');
    expect(res.status).toBe(200);
    expect(res.json.data.length).toBeGreaterThan(0);
    for (const e of res.json.data.slice(0, 10)) {
      expect(e).toMatchObject({ id: expect.stringMatching(UUID), objectName: expect.any(String), fields: expect.any(Array) });
    }
  });

  it('GET /entities/{entity}: registros paginados con header domain', async () => {
    const res = await get(`/api/v1/entities/${RECORD_ENTITY_ID}?version=active&limit=2&page=1`, { domain: domainId });
    expect(res.status).toBe(200);
    expectPagination(res.json.pagination, 1, 2);
    expect(res.json.data.length).toBeLessThanOrEqual(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// P0 · Rechazo de requests sin token / con token inválido
// ════════════════════════════════════════════════════════════════════════════════

/**
 * La spec documenta 401 para requests sin credenciales. En QA2 los listados devuelven 403
 * porque la petición cae en el rol "Anonymous"; se acepta 401/403 como rechazo válido, pero
 * nunca 2xx (fuga de datos) ni 5xx (error no controlado).
 */
const PROTECTED_GETS = [
  '/api/v1/users/?limit=1&page=1',
  '/api/v1/roles/?limit=1&page=1',
  '/api/v1/notifications?limit=1&page=1',
  '/api/v1/notifications/unread-count',
  '/api/v1/workflow?limit=1&page=1',
  '/api/v1/entities/?version=active',
];

/** BUG-02a/02b (grupo 2): sin Auth Guard, el handler lanza TypeError → 500 en vez de 401. */
const PROTECTED_GETS_BUG_TYPEERROR_500 = ['/api/v1/users/me', '/api/v1/users/profile'];

/** BUG-04b (grupo 4): responde 400 "User authentication required." en vez de 401. */
const PROTECTED_GETS_BUG_400 = ['/api/v1/users/profile/api-keys'];

const NO_AUTH_VARIANTS: [label: string, token: string | null][] = [
  ['sin Authorization', null],
  ['con Bearer malformado', 'invalid.token.value'],
];

/** Aserción común: el request no autenticado se rechaza sin datos ni error interno. */
async function expectRejectedWithoutData(path: string, token: string | null): Promise<void> {
  const res = await get(path, { token });
  expectControlledError(res, [401, 403]);
  expect(res.json?.data ?? null, 'no debe devolver datos').toBeFalsy();
}

describe('P0 · Requests sin token son rechazados', () => {
  describe.each(NO_AUTH_VARIANTS)('%s', (_variant, token) => {
    it.each(PROTECTED_GETS)('GET %s → 401/403 sin datos', async (path) => {
      await expectRejectedWithoutData(path, token);
    });

    // BUG-02a (/users/me) y BUG-02b (/users/profile), grupo 2: 500 `TypeError: undefined is not an
    // object (evaluating 'r.id' | 'e.user.id')`. El handler lee req.user sin Auth Guard previo.
    it.fails.each(PROTECTED_GETS_BUG_TYPEERROR_500)('GET %s → 401/403 sin datos', async (path) => {
      await expectRejectedWithoutData(path, token);
    });

    // BUG-04b (grupo 4): 400 "User authentication required." en lugar de 401.
    it.fails.each(PROTECTED_GETS_BUG_400)('GET %s → 401/403 sin datos', async (path) => {
      await expectRejectedWithoutData(path, token);
    });
  });

  it('GET /users/me con token revocado (logout) → 401 exacto', async () => {
    const session = (await validLogin()).json;
    await post('/api/v1/users/logout', undefined, { token: session.accessToken });
    const res = await get('/api/v1/users/me', { token: session.accessToken });
    expect(res.status).toBe(401);
  });

  // BUG-04c (grupo 4): QA2 responde 204 No Content a un logout sin credenciales; la spec documenta 401.
  it.fails('POST /users/logout sin token → 401 (spec)', async () => {
    const res = await post('/api/v1/users/logout', undefined, { token: null });
    expectControlledError(res, [401]);
  });

  it('POST /roles sin token → rechazado y no crea nada', async () => {
    const name = `${RUN}_role_noauth`;
    const res = await post('/api/v1/roles/', { item: name, description: 'qa_api sin token' }, { token: null });
    try {
      expectControlledError(res, [401, 403]);
      const check = await get(`/api/v1/roles/?limit=5&page=1&${filterQs('item', 'eq', name)}`);
      expect(check.json.data, 'el rol no debe existir').toEqual([]);
    } finally {
      await cleanupIfCreated('role', res, 'POST /roles sin token');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// P0 · Validación de datos inválidos (400/422)
// ════════════════════════════════════════════════════════════════════════════════

describe('P0 · Validación de datos inválidos', () => {
  it.each([
    ['body vacío', {}],
    ['sin item', { description: `${RUN} sin item` }],
    ['tipos inválidos', { item: 123, description: true }],
  ])('POST /roles con %s → 400', async (label, body) => {
    const res = await post('/api/v1/roles/', body);
    try {
      expectControlledError(res, [400, 422]);
    } finally {
      await cleanupIfCreated('role', res, `POST /roles ${label}`);
    }
  });

  it.each([
    ['sin name', {}],
    ['expiresAt no ISO', { name: `${RUN}_key_baddate`, expiresAt: 'not-a-date' }],
  ])('POST /users/profile/api-keys %s → 400', async (label, body) => {
    const res = await post('/api/v1/users/profile/api-keys', body);
    try {
      expectControlledError(res, [400, 422]);
    } finally {
      await cleanupIfCreated('apiKey', res, `POST api-keys ${label}`);
    }
  });

  it('POST /entities/{entity} con propiedad inexistente → 400', async () => {
    const res = await post(`/api/v1/entities/${RECORD_ENTITY_ID}?version=active`, { [`${PREFIX}unknown_field`]: 'x' }, { domain: domainId });
    try {
      expectControlledError(res, [400, 422]);
    } finally {
      await cleanupIfCreated('record', res, 'POST record propiedad inexistente');
    }
  });

  // BUG-03 (grupo 3): el valor objeto llega sin validar de tipo a la capa de persistencia/auditoría y
  // revienta con 500 `TypeError: JSON.stringify cannot serialize cyclic structures.`
  it.fails('POST /entities/{entity} con tipo inválido (objeto en campo string) → 400/422', async () => {
    const res = await post(`/api/v1/entities/${RECORD_ENTITY_ID}?version=active`, { name: { qa_api: true } }, { domain: domainId });
    try {
      expectControlledError(res, [400, 422]);
    } finally {
      await cleanupIfCreated('record', res, 'POST record tipo inválido');
    }
  });

  it('POST /entities/{entity} sin header domain → 400', async () => {
    const res = await post(`/api/v1/entities/${RECORD_ENTITY_ID}?version=active`, { name: `${RUN}_nodomain` });
    try {
      expectControlledError(res, [400]);
    } finally {
      await cleanupIfCreated('record', res, 'POST record sin domain');
    }
  });

  it('GET /entities/{entity} sin header domain → 400', async () => {
    const res = await get(`/api/v1/entities/${RECORD_ENTITY_ID}?version=active&limit=1&page=1`);
    expectControlledError(res, [400]);
  });

  it('GET /notifications con type fuera del enum → 400', async () => {
    const res = await get('/api/v1/notifications?type=bogus');
    expectControlledError(res, [400]);
  });

  // BUG-01a (grupo 1, SQL expuesto): `limit`/`page` llegan sin validar a Knex/PostgreSQL → 500 con
  // `select "dasec"."role".* … LIMIT must not be negative` en el `message`.
  it.fails('GET /roles con limit negativo / page 0 → 400 (sin error SQL)', async () => {
    const res = await get('/api/v1/roles/?limit=-1&page=0');
    expectControlledError(res, [400, 422]);
  });

  // BUG-01b (grupo 1): `key` se interpola como identificador de columna sin lista blanca → 500 con
  // `select count(*) … from "dasec"."user" where ("<key>" = $1) … column does not exist`.
  it.fails('GET /users con columna de filtro inexistente → 400 (sin error SQL)', async () => {
    const res = await get(`/api/v1/users/?limit=1&page=1&${filterQs(`${PREFIX}nonexistent_col`, 'eq', 'x')}`);
    expectControlledError(res, [400, 422]);
  });

  // BUG-01c (grupo 1): el id de ruta no se valida como UUID → 500 con
  // `select TRUE from "dasec"."user" where "id" = $1 … invalid input syntax for type uuid`.
  it.fails('GET /users/{id} con id no-UUID → 400/404 (sin error SQL)', async () => {
    const res = await get('/api/v1/users/not-a-uuid');
    expectControlledError(res, [400, 404]);
  });

  // BUG-01d (grupo 1): ídem en workflow → 500 con `select * from "dasec"."workflow" where "id" = $1 …`.
  it.fails('GET /workflow/{id} con id no-UUID → 400/404 (sin error SQL)', async () => {
    const res = await get('/api/v1/workflow/not-a-uuid');
    expectControlledError(res, [400, 404]);
  });

  // BUG-04d (grupo 4): un workflow inexistente devuelve 200 con `data: []` en lugar de 404.
  it.fails('GET /workflow/{id} con UUID inexistente → 404', async () => {
    const res = await get('/api/v1/workflow/00000000-0000-4000-8000-000000000000');
    expectControlledError(res, [404]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// P0 · Ciclos CRUD sobre recursos temporales qa_api_*
// ════════════════════════════════════════════════════════════════════════════════

describe('P0 · CRUD sobre recursos temporales (qa_api_*)', () => {
  it('Role: POST → GET → PUT → filtro → DELETE → 404', async () => {
    const name = `${RUN}_role`;
    let id = '';
    try {
      const created = await post('/api/v1/roles/', { item: name, description: 'qa_api role temporal' });
      expect(created.status).toBe(201);
      id = own(created.json.data[0].id, 'role', name);
      expect(created.json.data[0]).toMatchObject({ item: name });

      const read = await get(`/api/v1/roles/${id}`);
      expect(read.status).toBe(200);
      expect(read.json.data).toMatchObject({ id, item: name, isAdmin: false });

      const renamed = `${name}_upd`;
      const upd = await mutate('PUT', `/api/v1/roles/${id}`, id, { body: { item: renamed, description: 'qa_api role actualizado' } });
      expect(upd.status).toBe(200);
      expect((await get(`/api/v1/roles/${id}`)).json.data).toMatchObject({ item: renamed, description: 'qa_api role actualizado' });

      const found = await get(`/api/v1/roles/?limit=5&page=1&${filterQs('item', 'eq', renamed)}`);
      expect(found.json.data.map((r: { id: string }) => r.id)).toEqual([id]);

      const del = await mutate('DELETE', `/api/v1/roles/${id}`, id);
      expect(del.status).toBe(204);
      deleted.add(id);
      expect((await get(`/api/v1/roles/${id}`)).status).toBe(404);
    } finally {
      if (id) await cleanup(id);
    }
  });

  it('API key: POST (secreto solo una vez) → listado → revocar → borrar revocada', async () => {
    const name = `${RUN}_key`;
    let id = '';
    try {
      const created = await post('/api/v1/users/profile/api-keys', { name });
      expect(created.status).toBe(201);
      id = own(created.json.data.id, 'apiKey', name);
      expect(created.json.data).toMatchObject({ name, userId: me.id, revokedAt: null });
      expect(JSON.stringify(created.json), 'el POST entrega el secreto completo una única vez').toMatch(/da_live_[\w-]{20,}/);

      const list = await get('/api/v1/users/profile/api-keys');
      expect(list.status).toBe(200);
      const listed = list.json.data.find((k: { id: string }) => k.id === id);
      expect(listed, 'la key aparece en el listado').toBeDefined();
      const listedText = JSON.stringify(listed);
      expect(listedText, 'el listado no debe exponer el secreto completo').not.toMatch(/da_live_[\w-]{20,}/);

      const revoke = await mutate('DELETE', `/api/v1/users/profile/api-keys/${id}`, id);
      expect(revoke.status).toBe(200);
      expect(revoke.json.data.revokedAt).toBeTruthy();

      const del = await mutate('DELETE', `/api/v1/users/profile/api-keys/revoked/${id}`, id);
      expect(del.status).toBe(200);
      deleted.add(id);
      const after = await get('/api/v1/users/profile/api-keys');
      expect(after.json.data.some((k: { id: string }) => k.id === id)).toBe(false);
    } finally {
      if (id) await cleanup(id);
    }
  });

  it('Registro de entidad: POST → GET → filtro → PATCH (filter[id] propio) → DELETE → 404', async () => {
    const name = `${RUN}_record`;
    let id = '';
    try {
      const created = await post(`/api/v1/entities/${RECORD_ENTITY_ID}?version=active`, { name, status: 'qa_api_new' }, { domain: domainId });
      expect(created.status).toBe(201);
      id = own(created.json.data[0].id, 'record', name);
      expect(created.json.data[0]).toMatchObject({ createdBy: me.id, domain: domainId, data: { name, status: 'qa_api_new' } });

      const read = await get(`/api/v1/entities/${RECORD_ENTITY_ID}/${id}?version=active`, { domain: domainId });
      expect(read.status).toBe(200);
      expect(read.json.data[0]).toMatchObject({ id, data: { name } });

      const found = await get(`/api/v1/entities/${RECORD_ENTITY_ID}?version=active&limit=5&page=1&${filterQs('name', 'eq', name)}`, { domain: domainId });
      expect(found.json.data.map((r: { id: string }) => r.id)).toEqual([id]);

      const patch = await mutate('PATCH', `/api/v1/entities/${RECORD_ENTITY_ID}?version=active&filter%5Bid%5D=${id}`, id, {
        domain: domainId,
        body: { status: 'qa_api_upd' },
      });
      expect(patch.status).toBe(200);
      expect(patch.json.data.map((r: { id: string }) => r.id), 'el PATCH solo afecta al registro temporal').toEqual([id]);
      const reread = await get(`/api/v1/entities/${RECORD_ENTITY_ID}/${id}?version=active`, { domain: domainId });
      expect(reread.json.data[0].data).toMatchObject({ name, status: 'qa_api_upd' });

      const del = await mutate('DELETE', `/api/v1/entities/${RECORD_ENTITY_ID}/${id}?version=active`, id, { domain: domainId });
      expect(del.status).toBe(200);
      deleted.add(id);
      expect((await get(`/api/v1/entities/${RECORD_ENTITY_ID}/${id}?version=active`, { domain: domainId })).status).toBe(404);
    } finally {
      if (id) await cleanup(id);
    }
  });

  it('la guarda bloquea PUT/PATCH/DELETE sobre ids no creados por la suite y endpoints masivos', async () => {
    const foreign = me.permissions[0].roleId; // id preexistente en QA2: nunca se envía
    await expect(mutate('DELETE', `/api/v1/roles/${foreign}`, foreign)).rejects.toThrow(/BLOQUEADO/);
    await expect(mutate('PUT', `/api/v1/roles/${foreign}`, foreign, { body: {} })).rejects.toThrow(/BLOQUEADO/);
    const fake = `${RUN}_fake`;
    owned.set(fake, 'record');
    try {
      await expect(mutate('DELETE', `/api/v1/entities/${fake}/truncate`, fake)).rejects.toThrow(/BLOQUEADO/);
      await expect(mutate('DELETE', `/api/v1/entities/${RECORD_ENTITY_ID}?filter%5Bname%5D=${fake}`, fake)).rejects.toThrow(/BLOQUEADO/);
    } finally {
      owned.delete(fake);
    }
  });
});
