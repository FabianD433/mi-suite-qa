/**
 * DatAscend (qa2) – Settings › Users
 * Casos de origen: tests/users/TestCases_06-11-26-17_51_55.csv (módulo "Users": TC1450–TC1454, TC1523–TC1528).
 *
 * La pantalla (TC1527) y el filtro por email (TC1528) son de solo lectura. La paginación (TC1526) crea
 * usuarios temporales si no hay más de 10 activos (precondición del caso) y los borra al terminar.
 * Los casos de ciclo de vida (crear, editar, inactivar/activar, borrado permanente) trabajan SOLO sobre
 * usuarios temporales `qa-users-*@yopmail.com` creados por la propia suite; `afterAll` los borra
 * físicamente (y los registros que hayan creado) aunque algún test falle, y restaura BASELINE.
 * TC1525 cambia el idioma de la sesión a español; se restaura BASELINE al terminar.
 *
 * Diferencias entre el CSV y qa2 (verificadas en la app):
 *  - TC1450 / TC1451: el perfil ya no tiene "Phone Number List" ni "Address List" → obsoletos (skip).
 *  - TC1454: la creación ya no es un wizard (Basic Information/Addresses/Account) sino una vista única
 *    (TC1523, que lo reemplaza) → obsoleto (skip). El paso 3 de TC1453 (pestaña "Address") tampoco aplica.
 *  - TC1527: los filtros fijos "Filter by salutation/first_name/last_name" se sustituyeron por el drawer de
 *    filtros genérico (First Name, Last Name, Email, Active) y Edit/Delete están en el menú ⋮ de cada fila.
 *  - TC1528: el filtro no se aplica al escribir; requiere "Apply Filters".
 *  - TC1525: la opción se llama "Safe Inactivation (Recommended)" (el CSV dice "Safe Deactivation").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASELINE,
  BASE_URL,
  SEL,
  applyPreferences,
  evalJson,
  login,
  newIsolatedPage,
  startBrowser,
  waitUntil,
  type Browser,
  type Page,
} from '../support/datascend';

/** Entidad en la que los usuarios temporales crean un registro propio (Sprint en qa2; campo "name"). */
const RECORD_ENTITY_ID = process.env.DATASCEND_USERS_RECORD_ENTITY_ID ?? 'a1d50794-eeea-4e55-9b94-e25f9ed5b3ee';
const RECORD_ENTITY_FIELD = process.env.DATASCEND_USERS_RECORD_ENTITY_FIELD ?? 'name';
/** Rol y dominio que se asignan a los usuarios temporales para que puedan crear registros. */
const TEMP_ROLE = 'Administrator';
const TEMP_DOMAIN = 'PRINCIPAL';
const PAGE_SIZE = 10;

const U = {
  userMenuTrigger: '[data-testid="layout.main.header"] a.nav-link.search-toggle.py-0',
  userMenu: '.dropdown-menu.show',
  subheader: '[data-testid="layout.main.subheader"]',
  addUser: '[data-testid="layout.main.subheader.actions"] button.btn-primary',
  content: '[data-testid="layout.main.content"]',
  row: '.rdt_TableRow',
  headerCol: '.rdt_TableCol',
  rowMenuBtn: '[data-testid="button-menu"]',
  menu: '[data-testid="button-menu.menu"]',
  // Ítems del menú ⋮ por tipo (independiente del idioma)
  menuEdit: '[data-testid="button-menu.menu"] [role=menuitem] a[href*="/settings/users/edit/"]',
  menuDelete: '[data-testid="button-menu.menu"] [role=menuitem] button.btn-outline-danger',
  menuActivate: '[data-testid="button-menu.menu"] [role=menuitem] button.btn-outline-success',
  pagSelect: '.custom-pagination__select',
  pagLabel: '.custom-pagination__section:last-child .custom-pagination__label',
  prev: '.custom-pagination__btn[aria-label="Previous Page"]',
  next: '.custom-pagination__btn[aria-label="Next Page"]',
  filterField: '.filter-offcanvas.show [data-testid="filter.drawer.condition.field"]',
  filterOperator: '.filter-offcanvas.show [data-testid="filter.drawer.condition.operator"]',
  filterClear: '[id="filter.drawer.clear"]',
  treePanel: '.p-treeselect-panel',
  form: {
    firstName: 'input[name="firstName"]',
    lastName: 'input[name="lastName"]',
    email: 'input[name="email"]',
    password: 'input[name="password"]',
    save: 'form button[type="submit"]',
    cancel: 'form button.btn-light',
  },
  tab: (key: 'details' | 'roles' | 'domains') => `[role=tab][data-rr-ui-event-key="${key}"]`,
  modal: '.modal.show',
  softCard: '.modal.show .delete-mode-card:not(.hard-delete)',
  hardCard: '.modal.show .delete-mode-card.hard-delete',
  reassign: '.modal.show .delete-user-reassign-container',
  modalConfirm: '.modal.show .modal-footer .btn-danger, .modal.show .modal-footer .btn-success',
  modalCancel: '.modal.show .modal-footer .btn-secondary',
  langToggle: 'a.search-toggle.nav-link:has(img)',
} as const;

const rowSel = (id: string) => `[id="row-${id}"]`;

/** Textos de /locales/{en,es}/translation.json → users.* */
const T = {
  en: {
    created: 'Account created successfully.',
    edited: 'User has been edited successfully',
    roleUpdated: 'Role updated successfully',
    deleteTitle: 'Delete user?',
    deleteMessage: 'Please select one of the options to proceed with the deletion of user',
    softTitle: 'Safe Inactivation (Recommended)',
    hardTitle: 'Permanent Deletion',
    reassignLabel: 'Reassign records to (Optional):',
    reassignPlaceholder: 'Search and select a new owner',
    reassignInfo: 'If no user is selected, associated records will have no owner (NULL).',
    forceAction: 'Permanently remove',
    softSuccess: 'User inactivated successfully',
    hardSuccess: 'User permanently removed successfully',
    activateMessage: 'Are you sure you want to reactivate the user',
    activateSuccess: 'User activated successfully',
    loginError: 'Login error. Please verify your information and try again.',
  },
  es: {
    deleteTitle: '¿Eliminar usuario?',
    deleteMessage: 'Selecciona una de las opciones para proceder con la eliminación del usuario',
    softTitle: 'Inactivación Segura (Recomendado)',
    hardTitle: 'Eliminación Permanente',
    activateMessage: '¿Estás seguro de que deseas reactivar al usuario',
    activateSuccess: 'Usuario activado correctamente',
  },
};

interface ApiUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  active: boolean;
}
interface Req {
  method: string;
  url: string;
  status: number;
}
interface TempUser {
  id: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

/**
 * Registra las peticiones a /api/ (XHR y fetch) con su status y todos los toasts que se muestran,
 * aunque se cierren solos antes de que el test los lea.
 */
const TRACK = `(() => {
  if (window.__usersTrack) return;
  window.__usersTrack = true;
  window.__reqs = [];
  window.__toasts = [];
  const skip = (u) => !/\\/api\\//.test(u) || /notifications|ai-assistant/.test(u);
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__m = String(m).toUpperCase(); this.__u = String(u); return open.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (body) {
    if (!skip(this.__u)) {
      const rec = { method: this.__m, url: this.__u.replace(location.origin, ''), status: 0 };
      window.__reqs.push(rec);
      this.addEventListener('loadend', () => { rec.status = this.status; });
    }
    return send.call(this, body);
  };
  const f = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    if (skip(url)) return f(input, init);
    const rec = { method: String(init.method || input?.method || 'GET').toUpperCase(), url: url.replace(location.origin, ''), status: 0 };
    window.__reqs.push(rec);
    const r = await f(input, init);
    rec.status = r.status;
    return r;
  };
  new MutationObserver(() => {
    for (const t of document.querySelectorAll('.Toastify__toast')) {
      const text = t.innerText.trim();
      if (text && t.__seen !== text) { t.__seen = text; window.__toasts.push(text); }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

let b: Browser;
const tempUsers: TempUser[] = [];
const tempRecords: string[] = [];

beforeAll(async () => {
  b = await startBrowser();
});

afterAll(async () => {
  if (!b) return;
  try {
    const page = await adminPage();
    for (const r of tempRecords) await api(page, 'DELETE', `/api/v1/entities/${RECORD_ENTITY_ID}/${r}`);
    for (const u of tempUsers) await api(page, 'DELETE', `/api/v1/users-data/${u.id}?force=true`);
    // Red de seguridad: usuarios temporales que no llegaron a registrarse (p. ej. un test falló a mitad).
    for (const filter of [filterQuery('email', 'lk', 'qa-users-'), filterQuery('active', 'eq', 'false')]) {
      const { users } = await apiUsers(page, { limit: 50, filter });
      for (const u of users.filter((x) => x.email.startsWith('qa-users-'))) {
        await api(page, 'DELETE', `/api/v1/users-data/${u.id}?force=true`);
      }
    }
    await applyPreferences(page, BASELINE);
  } finally {
    await b.stop();
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

/** Página aislada con sesión iniciada (y dominio seleccionado). */
async function loggedInPage(email?: string, password?: string): Promise<Page> {
  const { page } = await newIsolatedPage(b, TRACK);
  await login(page, email, password);
  // Tras el login la app redirige a /dashboard/welcome de forma asíncrona: esperar antes de navegar.
  await waitUntil(page, `location.pathname === '/dashboard/welcome' && localStorage.getItem('selectedDomain')`, 20_000);
  await page.wait(1000);
  return page;
}

/**
 * Carga `path` y verifica que la navegación ocurrió (justo después del login `page.go` puede perderse
 * frente a la redirección de la app). Los formularios de Users hacen `history.back()` al guardar:
 * para llegar a ellos se navega con clics (SPA), como el usuario, y no con esta función.
 */
async function navigate(page: Page, path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    await page.go(`${BASE_URL}${path}`);
    try {
      await waitUntil(page, `location.pathname + location.search === ${JSON.stringify(path)}`, 5_000);
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
}

const adminPage = () => loggedInPage();

async function goToUsers(page: Page, query = ''): Promise<void> {
  await navigate(page, `/settings/users${query}`);
  await waitForList(page);
}

/** Espera a que la tabla termine de cargar (sin petición de listado pendiente). */
async function waitForList(page: Page): Promise<void> {
  await waitUntil(page, `document.querySelector('${U.pagLabel}') && document.querySelector('${U.row}')`, 20_000);
  await waitUntil(page, `!(window.__reqs ?? []).some(r => r.method === 'GET' && /\\/api\\/v1\\/users\\/\\?/.test(r.url) && r.status === 0)`);
  await page.wait(500);
}

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const raw = await page.evaluate<string>(
    `(async () => {
      let domain = localStorage.getItem('selectedDomain');
      try { const d = JSON.parse(domain); domain = d?.id ?? d?.value ?? d; } catch {}
      const r = await fetch(${JSON.stringify(path)}, {
        method: ${JSON.stringify(method)},
        headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json', ...(domain ? { domain } : {}) },
        ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
      });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { json = text; }
      return JSON.stringify({ status: r.status, json });
    })()`,
  );
  return JSON.parse(raw);
}

const filterQuery = (key: string, operator: string, value: string) =>
  `&key=${key}&operator=${operator}&value=${encodeURIComponent(value)}&condition=AND&open_parens=0&close_parens=0`;

async function apiUsers(page: Page, opts: { limit?: number; page?: number; filter?: string } = {}) {
  const r = await api<{ data: ApiUser[]; pagination: { recordsTotal: number } }>(
    page,
    'GET',
    `/api/v1/users/?limit=${opts.limit ?? PAGE_SIZE}&page=${opts.page ?? 1}${opts.filter ?? ''}`,
  );
  expect(r.status).toBe(200);
  return { users: r.json.data, total: r.json.pagination.recordsTotal };
}

async function apiUser(page: Page, id: string): Promise<{ status: number; user?: ApiUser }> {
  const r = await api<{ data: ApiUser }>(page, 'GET', `/api/v1/users/${id}`);
  return { status: r.status, user: r.status === 200 ? r.json.data : undefined };
}

const reqs = (page: Page) => evalJson<Req[]>(page, 'window.__reqs ?? []');

async function waitForReq(page: Page, method: string, url: RegExp, timeout = 20_000): Promise<Req> {
  await waitUntil(page, `(window.__reqs ?? []).some(r => r.method === '${method}' && ${url}.test(r.url) && r.status > 0)`, timeout);
  return (await reqs(page)).filter((r) => r.method === method && url.test(r.url)).at(-1)!;
}

/** Espera un toast que contenga `text` (registrado por el observer aunque ya se haya cerrado). */
async function waitForToast(page: Page, text: string, timeout = 15_000): Promise<string[]> {
  await waitUntil(page, `(window.__toasts ?? []).some(t => t.includes(${JSON.stringify(text)}))`, timeout);
  return evalJson<string[]>(page, 'window.__toasts');
}

const resetTracking = (page: Page) =>
  page.evaluate(`window.__reqs = []; window.__toasts = []; document.querySelectorAll('${SEL.toast}').forEach(t => t.remove())`);

async function renderedRows(page: Page) {
  return evalJson<{ id: string; firstName: string; lastName: string; email: string; inactive: boolean }[]>(
    page,
    `[...document.querySelectorAll('${U.row}')].map(r => ({
      id: r.id.replace(/^row-/, ''),
      firstName: r.querySelector('[id^="cell-first_name-"]')?.innerText.trim() ?? '',
      lastName: r.querySelector('[id^="cell-last_name-"]')?.innerText.trim() ?? '',
      email: r.querySelector('[id^="cell-email-"]')?.innerText.trim() ?? '',
      inactive: r.classList.contains('inactive-row'),
    }))`,
  );
}

const exists = (page: Page, sel: string) => page.evaluate<boolean>(`!!document.querySelector('${sel}')`);
const pagLabel = (page: Page) => page.evaluate<string>(`document.querySelector('${U.pagLabel}').innerText.trim()`);
const isDisabled = (page: Page, sel: string) => page.evaluate<boolean>(`document.querySelector('${sel}').disabled`);

async function openRowMenu(page: Page, userId: string): Promise<string[]> {
  await page.find(`${rowSel(userId)} ${U.rowMenuBtn}`).click();
  await waitUntil(page, `document.querySelector('${U.menu} [role=menuitem]')`);
  return evalJson<string[]>(page, `[...document.querySelectorAll('${U.menu} [role=menuitem]')].map(e => e.innerText.trim())`);
}

async function closeRowMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await waitUntil(page, `!document.querySelector('${U.menu}')`).catch(async () => {
    await page.find(U.content).click();
    await waitUntil(page, `!document.querySelector('${U.menu}')`);
  });
}

async function openDeleteModal(page: Page, userId: string): Promise<void> {
  await openRowMenu(page, userId);
  await page.find(U.menuDelete).click();
  await waitUntil(page, `document.querySelector('${U.softCard}')`);
}

async function closeModalWithCancel(page: Page): Promise<void> {
  await page.find(U.modalCancel).click();
  await waitUntil(page, `!document.querySelector('${U.modal}')`);
  await page.wait(400);
}

/** Selecciona `label` en un TreeSelect de PrimeReact (`root` es el contenedor .p-treeselect). */
async function pickTreeOption(page: Page, root: string, label: string): Promise<void> {
  await page.find(`${root} .p-treeselect-trigger`).click();
  await waitUntil(page, `document.querySelector('${U.treePanel} li[aria-label="${label}"]')`);
  await page.find(`${U.treePanel} li[aria-label="${label}"] .p-treenode-content`).click();
  await waitUntil(page, `!document.querySelector('${U.treePanel}')`).catch(() => page.keyboard.press('Escape'));
  await page.wait(300);
}

/** Aplica un filtro desde el drawer "Filters" y espera la recarga de la tabla. */
async function applyFilter(
  page: Page,
  f: { field: 'First Name' | 'Last Name' | 'Email' | 'Active'; operator?: string; name?: string; value: string },
): Promise<void> {
  await page.find(SEL.filterToggle).click();
  await waitUntil(page, `document.querySelector('${SEL.filterDrawer}')`);
  await page.wait(400);
  await pickTreeOption(page, U.filterField, f.field);
  if (f.operator) await pickTreeOption(page, U.filterOperator, f.operator);
  if (f.field === 'Active') {
    await page.find(`${SEL.filterDrawer} input[name="active"][value="${f.value}"]`).click();
  } else {
    await page.find(`${SEL.filterDrawer} input[name="${f.name}"]`).fill(f.value);
  }
  await page.evaluate('window.__reqs = []');
  await page.find(SEL.filterApply).click();
  await waitForReq(page, 'GET', /\/api\/v1\/users\/\?/);
  await waitUntil(page, `!document.querySelector('${SEL.filterDrawer}')`);
  await page.wait(500);
}

/** Lista de usuarios inactivos (filtro Active = No aplicado desde el drawer). */
async function goToInactiveUsers(page: Page): Promise<void> {
  await goToUsers(page);
  await applyFilter(page, { field: 'Active', value: 'false' });
}

async function setRoleOrDomain(
  page: Page,
  userId: string,
  kind: 'roles' | 'domains',
  name: string,
  on: boolean,
): Promise<Req & { itemId: string }> {
  const prefix = kind === 'roles' ? 'role_' : 'domain_';
  if (!(await page.url()).includes(`/settings/users/edit/${userId}`)) await openEditFromList(page, userId);
  await page.find(U.tab(kind)).click();
  await waitUntil(page, `document.querySelector('input[id^="${prefix}"]')`, 20_000);
  await page.wait(500);
  const input = await page.evaluate<string>(
    `[...document.querySelectorAll('input[id^="${prefix}"]')].find(i => i.closest('[role=row]').querySelector('[role=cell]').innerText.trim() === ${JSON.stringify(name)})?.id ?? ''`,
  );
  expect(input, `${kind}: "${name}" en la tabla`).not.toBe('');
  const itemId = input.slice(prefix.length);
  const checked = await page.evaluate<boolean>(`document.getElementById('${input}').checked`);
  if (checked === on) return { method: 'NONE', url: '', status: 200, itemId };
  await page.evaluate('window.__reqs = []');
  await page.find(`[id="${input}"]`).click();
  await waitUntil(page, `(window.__reqs ?? []).some(r => r.method !== 'GET' && r.url.includes('${itemId}') && r.status > 0)`);
  await waitUntil(page, `document.getElementById('${input}').checked === ${on}`);
  return { ...(await reqs(page)).find((r) => r.method !== 'GET' && r.url.includes(itemId))!, itemId };
}

/** Ids de roles o dominios asignados según la API (acepta lista de ids o de objetos). */
async function assignedIds(page: Page, userId: string, kind: 'roles' | 'domains'): Promise<string[]> {
  const r = await api<{ data: (string | { id: string })[] }>(page, 'GET', `/api/v1/users-data/${userId}/${kind}`);
  expect(r.status).toBe(200);
  return r.json.data.map((x) => (typeof x === 'string' ? x : x.id)).sort();
}

/** Lista filtrada por el email exacto del usuario. */
async function showOnlyUser(page: Page, email: string): Promise<void> {
  await goToUsers(page);
  await applyFilter(page, { field: 'Email', operator: 'Equals to', name: 'email', value: email });
}

/** Abre la edición haciendo clic en el nombre (navegación SPA, como el usuario). */
async function openEditFromList(page: Page, userId: string): Promise<void> {
  const user = (await apiUser(page, userId)).user!;
  await showOnlyUser(page, user.email);
  await page.find(`${rowSel(userId)} [id^="cell-first_name-"] a`).click();
  await waitUntil(page, `location.pathname === '/settings/users/edit/${userId}' && document.querySelector('${U.form.email}')?.value`, 20_000);
  await page.wait(500);
}

/** Crea un usuario desde "Add User" y lo registra para limpieza. */
async function createUserViaUi(page: Page, label: string): Promise<TempUser> {
  const ts = Date.now();
  const u = {
    email: `qa-users-${label}-${ts}@yopmail.com`,
    password: `Qa!Users${ts % 100000}`,
    firstName: 'QA',
    lastName: `Users ${label} ${ts}`,
  };
  await goToUsers(page);
  await page.find(U.addUser).click();
  await waitUntil(page, `location.pathname === '/settings/users/create' && document.querySelector('${U.form.firstName}')`);
  await page.find(U.form.firstName).fill(u.firstName);
  await page.find(U.form.lastName).fill(u.lastName);
  await page.find(U.form.email).fill(u.email);
  await page.find(U.form.password).fill(u.password);
  await page.find(U.form.save).click();
  await waitUntil(page, `location.pathname === '/settings/users'`, 20_000);
  const { users } = await apiUsers(page, { limit: 1, filter: filterQuery('email', 'eq', u.email) });
  expect(users, `usuario ${u.email} creado`).toHaveLength(1);
  const user = { ...u, id: users[0].id };
  tempUsers.push(user);
  return user;
}

/** Usuario temporal con rol + dominio y un registro propio (owner = ese usuario). */
async function userWithRecord(admin: Page, label: string): Promise<{ user: TempUser; recordId: string }> {
  const user = await createUserViaUi(admin, label);
  await setRoleOrDomain(admin, user.id, 'roles', TEMP_ROLE, true);
  await setRoleOrDomain(admin, user.id, 'domains', TEMP_DOMAIN, true);
  const recordId = await createOwnRecord(user);
  return { user, recordId };
}

async function createOwnRecord(user: TempUser): Promise<string> {
  const page = await loggedInPage(user.email, user.password);
  const r = await api<{ data: { id: string; owner: string }[] }>(page, 'POST', `/api/v1/entities/${RECORD_ENTITY_ID}`, {
    [RECORD_ENTITY_FIELD]: `qa-users-owner-${Date.now()}`,
  });
  expect(r.status, 'el usuario temporal puede crear un registro').toBe(201);
  const rec = r.json.data[0];
  tempRecords.push(rec.id);
  expect(rec.owner).toBe(user.id);
  return rec.id;
}

async function recordOwner(page: Page, recordId: string): Promise<string | null> {
  const r = await api<{ data: { owner: string | null }[] }>(page, 'GET', `/api/v1/entities/${RECORD_ENTITY_ID}/${recordId}`);
  expect(r.status).toBe(200);
  return r.json.data[0].owner;
}

/**
 * Abre la vista del registro en una página aislada (esa vista bloquea la navegación posterior)
 * y devuelve el valor de "Owner:" que muestra.
 */
async function recordViewOwner(recordId: string): Promise<string> {
  const page = await adminPage();
  await navigate(page, `/dashboard/entity/${RECORD_ENTITY_ID}/view/${recordId}`);
  await waitUntil(page, `document.querySelector('[data-testid="record-timestamps"]')`, 20_000);
  await page.wait(1000);
  const text = await page.evaluate<string>(`document.querySelector('[data-testid="record-timestamps"]').innerText`);
  return text.match(/Owner:[ \t]*(.*)/)?.[1].trim() ?? '';
}

/** Intenta iniciar sesión y devuelve la ruta final y los toasts mostrados. */
async function attemptLogin(email: string, password: string): Promise<{ path: string; toasts: string[]; token: boolean }> {
  const { page } = await newIsolatedPage(b, TRACK);
  await page.go(`${BASE_URL}/auth/login`);
  await waitUntil(page, `document.querySelector('${SEL.email}')`);
  // Esperar a que i18n resuelva las claves (antes muestra "login.sign-in" y los errores como "login.failed").
  await waitUntil(page, `!/^login\\./.test(document.querySelector('${SEL.submit}').innerText)`);
  await page.find(SEL.email).fill(email);
  await page.find(SEL.password).fill(password);
  await page.find(SEL.submit).click();
  await waitUntil(page, `(window.__toasts ?? []).length > 0 || !location.pathname.startsWith('/auth/login')`, 20_000);
  await page.wait(1000);
  return evalJson(page, `{ path: location.pathname, toasts: window.__toasts, token: !!localStorage.getItem('token') }`);
}

/** Cambia el idioma desde la cabecera (se guarda en el perfil; afterAll restaura BASELINE). Solo en /settings/users. */
async function switchLanguage(page: Page, lang: 'es' | 'en'): Promise<void> {
  const title = lang === 'es' ? 'Usuarios' : 'Users';
  await page.find(U.langToggle).click();
  await page.find(`[id="public-docs.lang-${lang}"]`).click();
  await waitUntil(page, `document.querySelector('${U.subheader}')?.innerText.trim().startsWith('${title}')`);
  await page.wait(500);
}

// ────────────────────────────────────────────────────────────────────────────────
// Casos de solo lectura
// ────────────────────────────────────────────────────────────────────────────────

describe('Settings › Users', () => {
  describe('TC1527 – Pantalla Users', () => {
    let page: Page;

    beforeAll(async () => {
      page = await adminPage();
    });

    it('menú de usuario → "Settings" redirige a /settings/users', async () => {
      await waitUntil(page, `document.querySelector('${U.userMenuTrigger}')`);
      await page.find(U.userMenuTrigger).click();
      await waitUntil(page, `document.querySelector('${U.userMenu}')`);
      const items = await evalJson<string[]>(page, `[...document.querySelectorAll('${U.userMenu} .dropdown-item')].map(e => e.innerText.trim())`);
      expect(items).toContain('Settings');

      await page.evaluate(`[...document.querySelectorAll('${U.userMenu} .dropdown-item')].find(e => e.innerText.trim() === 'Settings').click()`);
      await waitUntil(page, `location.pathname === '/settings/users'`, 15_000);
      await waitForList(page);
      expect(await page.url()).toBe(`${BASE_URL}/settings/users`);
    });

    it('muestra el título "Users", el botón "Add User" y el acceso a filtros', async () => {
      const head = await evalJson<{ title: string; add: string; filters: boolean; sidebarActive: boolean }>(
        page,
        `{ title: document.querySelector('${U.subheader}').innerText.split('\\n')[0].trim(),
           add: document.querySelector('${U.addUser}')?.innerText.trim(),
           filters: !!document.querySelector('${SEL.filterToggle}'),
           sidebarActive: !!document.querySelector('[data-testid="sidebar"] a.nav-link.active[href="/settings/users"]') }`,
      );
      expect(head).toEqual({ title: 'Users', add: 'Add User', filters: true, sidebarActive: true });
    });

    it('el drawer de filtros ofrece First Name, Last Name, Email y Active, con "Apply Filters" y "Clear"', async () => {
      await page.find(SEL.filterToggle).click();
      await waitUntil(page, `document.querySelector('${SEL.filterDrawer}')`);
      const buttons = await evalJson<string[]>(page, `[...document.querySelectorAll('${SEL.filterDrawer} .offcanvas-title button')].map(b => b.innerText.trim())`);
      expect(buttons).toEqual(['Apply Filters', 'Clear']);

      await page.find(`${U.filterField} .p-treeselect-trigger`).click();
      await waitUntil(page, `document.querySelector('${U.treePanel} li[role=treeitem]')`);
      const fields = await evalJson<string[]>(page, `[...document.querySelectorAll('${U.treePanel} li[role=treeitem]')].map(li => li.getAttribute('aria-label'))`);
      expect(fields).toEqual(['First Name', 'Last Name', 'Email', 'Active']);

      await page.keyboard.press('Escape');
      await page.find(`${SEL.filterDrawer} .btn-close`).click();
      await waitUntil(page, `!document.querySelector('${SEL.filterDrawer}')`);
      await page.wait(500);
    });

    it('la tabla tiene las columnas First Name, Last Name, Email y una columna de acciones siempre visible', async () => {
      const cols = await evalJson<string[]>(page, `[...document.querySelectorAll('${U.headerCol}')].map(c => c.innerText.replace(/[▲▼]/g, '').trim())`);
      expect(cols).toEqual(['First Name', 'Last Name', 'Email', '']);

      const actions = await evalJson<{ rows: number; withMenu: number; inViewport: boolean }>(
        page,
        `(() => { const rows = [...document.querySelectorAll('${U.row}')];
          const btns = rows.map(r => r.querySelector('${U.rowMenuBtn}')).filter(Boolean);
          return { rows: rows.length, withMenu: btns.length,
            inViewport: btns.every(b => { const x = b.getBoundingClientRect(); return x.width > 0 && x.right <= innerWidth; }) }; })()`,
      );
      expect(actions.rows).toBeGreaterThan(0);
      expect(actions.withMenu).toBe(actions.rows);
      expect(actions.inViewport).toBe(true);
    });

    it('el menú ⋮ de cada fila ofrece Edit y Delete', async () => {
      const [first] = await renderedRows(page);
      expect(await openRowMenu(page, first.id)).toEqual(['Edit', 'Delete']);
      expect(await page.find(U.menuEdit).attr('href')).toBe(`/settings/users/edit/${first.id}`);
      await closeRowMenu(page);
    });

    it('muestra la paginación con "Rows per page" y el rango de registros', async () => {
      const { total } = await apiUsers(page);
      const options = await evalJson<string[]>(page, `[...document.querySelectorAll('${U.pagSelect} option')].map(o => o.value)`);
      expect(options).toEqual(['10', '20', '30', '40', '50']);
      expect(await pagLabel(page)).toBe(`1-${Math.min(total, PAGE_SIZE)} of ${total}`);
    });
  });

  describe('TC1528 – Filtro por Email', () => {
    let page: Page;
    let all: ApiUser[];

    beforeAll(async () => {
      page = await adminPage();
      all = (await apiUsers(page, { limit: 50 })).users;
      await goToUsers(page);
    });

    it('sin filtros se muestra la lista completa de usuarios', async () => {
      const rows = await renderedRows(page);
      expect(rows.map((r) => r.id)).toEqual(all.slice(0, PAGE_SIZE).map((u) => u.id));
    });

    it('"Email" + "Equals to" con un email existente muestra solo ese usuario', async () => {
      const target = all.find((u) => u.email !== 'system@multiplied.com') ?? all[0];
      await applyFilter(page, { field: 'Email', operator: 'Equals to', name: 'email', value: target.email });

      const listReq = (await reqs(page)).find((r) => r.method === 'GET' && /\/api\/v1\/users\/\?/.test(r.url))!;
      expect(decodeURIComponent(listReq.url)).toContain(`key=email&operator=eq&value=${target.email}`);
      expect((await renderedRows(page)).map((r) => r.email)).toEqual([target.email]);
      expect(await page.find(SEL.activeFilters).text()).toContain(target.email);
    });

    it('"Email" + "Like" muestra solo los usuarios cuyo email contiene el texto', async () => {
      // Fragmento compartido por al menos un email, pero no por todos (si es posible).
      const domains = [...new Set(all.map((u) => u.email.split('@')[1]))];
      const fragment = domains.find((d) => all.filter((u) => u.email.includes(d)).length < all.length) ?? domains[0];
      const expected = all.filter((u) => u.email.toLowerCase().includes(fragment.toLowerCase()));

      await goToUsers(page);
      await applyFilter(page, { field: 'Email', operator: 'Like', name: 'email', value: fragment });

      const rows = await renderedRows(page);
      expect(rows.length).toBe(Math.min(expected.length, PAGE_SIZE));
      expect(rows.every((r) => r.email.toLowerCase().includes(fragment.toLowerCase()))).toBe(true);
      expect(await page.find(SEL.activeFilters).text()).toContain(`Email Like: ${fragment}`);
      expect(await pagLabel(page)).toMatch(new RegExp(`of ${expected.length}$`));
    });

    it('quitar el filtro restaura la lista completa', async () => {
      await page.evaluate('window.__reqs = []');
      await page.find(`${SEL.activeFilters} button`).click();
      await waitForReq(page, 'GET', /\/api\/v1\/users\/\?/);
      await waitForList(page);
      expect((await renderedRows(page)).map((r) => r.id)).toEqual(all.slice(0, PAGE_SIZE).map((u) => u.id));
    });
  });

  describe('TC1526 – Paginación (navegación entre páginas)', () => {
    let page: Page;
    let total: number;
    const seeded: string[] = [];

    beforeAll(async () => {
      page = await adminPage();
      total = (await apiUsers(page)).total;
      // Precondición del caso: más usuarios activos de los que caben en una página (12 si se muestran 10).
      // Si no los hay, se crean usuarios temporales desde "Add User" (se borran en afterAll).
      for (let i = total; i < PAGE_SIZE + 2; i++) seeded.push((await createUserViaUi(page, `page${i}`)).id);
      total = (await apiUsers(page)).total;
      await goToUsers(page);
    });

    afterAll(async () => {
      for (const id of seeded) await api(page, 'DELETE', `/api/v1/users-data/${id}?force=true`);
    });

    it('la primera página muestra "1-N of X" con "<" deshabilitado', async () => {
      expect(await pagLabel(page)).toBe(`1-${Math.min(total, PAGE_SIZE)} of ${total}`);
      expect(await isDisabled(page, U.prev)).toBe(true);
      expect((await renderedRows(page)).length).toBe(Math.min(total, PAGE_SIZE));
    });

    it('">" carga la segunda página y "<" vuelve a la primera', async () => {
      expect(total).toBeGreaterThan(PAGE_SIZE);
      const firstPage = (await renderedRows(page)).map((r) => r.id);
      const page2 = (await apiUsers(page, { page: 2 })).users.map((u) => u.id);

      await page.evaluate('window.__reqs = []');
      await page.find(U.next).click();
      const req = await waitForReq(page, 'GET', /\/api\/v1\/users\/\?.*page=2/);
      expect(req.status).toBe(200);
      await waitUntil(page, `document.querySelector('${U.pagLabel}').innerText.startsWith('${PAGE_SIZE + 1}-')`);
      expect(await pagLabel(page)).toBe(`${PAGE_SIZE + 1}-${Math.min(total, 2 * PAGE_SIZE)} of ${total}`);
      expect(await isDisabled(page, U.prev)).toBe(false);
      expect((await renderedRows(page)).map((r) => r.id)).toEqual(page2);

      await page.find(U.prev).click();
      await waitUntil(page, `document.querySelector('${U.pagLabel}').innerText.startsWith('1-')`);
      expect(await pagLabel(page)).toBe(`1-${PAGE_SIZE} of ${total}`);
      expect(await isDisabled(page, U.prev)).toBe(true);
      expect((await renderedRows(page)).map((r) => r.id)).toEqual(firstPage);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Ciclo de vida con usuarios temporales (se borran en afterAll)
  // ────────────────────────────────────────────────────────────────────────────────

  describe('Ciclo de vida de un usuario temporal', () => {
    let admin: Page;
    let userA: TempUser | undefined;
    let recordA: string | undefined;

    beforeAll(async () => {
      admin = await adminPage();
    });

    /** Los casos posteriores reutilizan el usuario de TC1523; si ese caso falló, lo crean aquí. */
    async function ensureUserA(): Promise<TempUser> {
      if (!userA) userA = await createUserViaUi(admin, 'a');
      return userA;
    }

    describe('TC1523 – Happy Path: creación de usuario (vista única)', () => {
      const ts = Date.now();
      const data = {
        firstName: 'QA',
        lastName: `Users a ${ts}`,
        email: `qa-users-a-${ts}@yopmail.com`,
        password: `Qa!Users${ts % 100000}`,
      };

      it('"Add User" abre una vista única con solo First name, Last name, Email y Password', async () => {
        await goToUsers(admin);
        await admin.find(U.addUser).click();
        await waitUntil(admin, `location.pathname === '/settings/users/create' && document.querySelector('${U.form.firstName}')`);

        const view = await evalJson<{ inputs: string[]; labels: string[]; tabs: number; buttons: string[] }>(
          admin,
          `(() => { const f = document.querySelector('${U.content} form');
            return { inputs: [...f.querySelectorAll('input, select, textarea')].map(i => i.name),
              labels: [...f.querySelectorAll('label')].map(l => l.innerText.trim()),
              tabs: document.querySelectorAll('${U.content} [role=tab]').length,
              buttons: [...f.querySelectorAll('button:not([tabindex="-1"])')].map(b => b.innerText.trim()) }; })()`,
        );
        expect(view.inputs).toEqual(['firstName', 'lastName', 'email', 'password']);
        expect(view.labels).toEqual(['First Name *', 'Last Name *', 'Email *', 'Password *']);
        expect(view.tabs).toBe(0); // sin wizard ni pestañas secundarias
        expect(view.buttons).toEqual(['Save', 'Cancel']);
      });

      it('al guardar se crea el usuario, se confirma con un mensaje y aparece en la lista', async () => {
        await resetTracking(admin);
        await admin.find(U.form.firstName).fill(data.firstName);
        await admin.find(U.form.lastName).fill(data.lastName);
        await admin.find(U.form.email).fill(data.email);
        await admin.find(U.form.password).fill(data.password);
        await admin.find(U.form.save).click();

        await waitUntil(admin, `location.pathname === '/settings/users'`, 20_000);
        const { users } = await apiUsers(admin, { limit: 1, filter: filterQuery('email', 'eq', data.email) });
        expect(users).toHaveLength(1);
        userA = { ...data, id: users[0].id };
        tempUsers.push(userA);
        expect(users[0]).toMatchObject({ firstName: data.firstName, lastName: data.lastName, active: true });

        await waitForList(admin);
        await applyFilter(admin, { field: 'Email', operator: 'Equals to', name: 'email', value: data.email });
        expect(await renderedRows(admin)).toEqual([
          { id: userA.id, firstName: data.firstName, lastName: data.lastName, email: data.email, inactive: false },
        ]);
        expect(await evalJson<string[]>(admin, 'window.__toasts')).toContain(T.en.created);
      });
    });

    describe('TC1524 – Vista de edición: campos requeridos y pestañas Roles / Domains', () => {
      let user: TempUser;

      beforeAll(async () => {
        user = await ensureUserA();
        await goToUsers(admin, '');
        await applyFilter(admin, { field: 'Email', operator: 'Equals to', name: 'email', value: user.email });
      });

      it('al hacer clic en el usuario se abre la edición con los datos precargados', async () => {
        await admin.find(`${rowSel(user.id)} [id^="cell-first_name-"] a`).click();
        await waitUntil(admin, `location.pathname === '/settings/users/edit/${user.id}' && document.querySelector('${U.form.email}')?.value`, 20_000);
        const form = await evalJson<Record<string, string>>(
          admin,
          `Object.fromEntries([...document.querySelectorAll('${U.content} form input')].map(i => [i.name, i.value]))`,
        );
        expect(form).toMatchObject({ firstName: user.firstName, lastName: user.lastName, email: user.email });
        expect(form.password).toBeTruthy(); // valor enmascarado
        const labels = await evalJson<string[]>(admin, `[...document.querySelectorAll('${U.content} form label')].map(l => l.innerText.trim())`);
        expect(labels).toEqual(['First Name *', 'Last Name *', 'Email *', 'New Password *']);
      });

      it('solo existen las pestañas Basic Information, Roles y Domains', async () => {
        const tabs = await evalJson<string[]>(admin, `[...document.querySelectorAll('${U.content} [role=tab]')].map(t => t.innerText.trim())`);
        expect(tabs).toEqual(['Basic Information', 'Roles', 'Domains']);
      });

      it('Roles muestra los roles asignados y permite asignar y quitar roles', async () => {
        await admin.find(U.tab('roles')).click();
        await waitUntil(admin, `document.querySelector('input[id^="role_"]')`, 20_000);
        await admin.wait(500);
        const shown = await evalJson<{ id: string; checked: boolean }[]>(
          admin,
          `[...document.querySelectorAll('input[id^="role_"]')].map(i => ({ id: i.id.slice(5), checked: i.checked }))`,
        );
        expect(shown.filter((r) => r.checked).map((r) => r.id).sort()).toEqual(await assignedIds(admin, user.id, 'roles'));

        // Asignar y quitar "Default role" (sin permisos).
        await resetTracking(admin);
        const add = await setRoleOrDomain(admin, user.id, 'roles', 'Default role', true);
        expect(add.method).toBe('PUT');
        expect(add.url).toMatch(new RegExp(`/api/v1/roles/[0-9a-f-]+/users/${user.id}$`));
        expect(add.status).toBe(200);
        await waitForToast(admin, T.en.roleUpdated);
        expect(await assignedIds(admin, user.id, 'roles')).toContain(add.itemId);

        const remove = await setRoleOrDomain(admin, user.id, 'roles', 'Default role', false);
        expect(remove.status).toBeLessThan(300);
        expect(await assignedIds(admin, user.id, 'roles')).not.toContain(add.itemId);

        // Rol con permisos que se usa luego para crear un registro propio.
        await setRoleOrDomain(admin, user.id, 'roles', TEMP_ROLE, true);
      });

      it('Domains muestra los dominios asignados y permite asignarlos', async () => {
        await admin.find(U.tab('domains')).click();
        await waitUntil(admin, `document.querySelector('input[id^="domain_"]')`, 20_000);
        await admin.wait(500);
        const shown = await evalJson<string[]>(admin, `[...document.querySelectorAll('input[id^="domain_"]:checked')].map(i => i.id.slice(7))`);
        expect(shown.sort()).toEqual(await assignedIds(admin, user.id, 'domains'));

        const req = await setRoleOrDomain(admin, user.id, 'domains', TEMP_DOMAIN, true);
        expect(req.status).toBeLessThan(300);
        expect(await assignedIds(admin, user.id, 'domains')).toContain(req.itemId);
      });

      it('modificar un campo y guardar actualiza el usuario con mensaje de confirmación', async () => {
        await openEditFromList(admin, user.id);
        const lastName = `${user.lastName} edited`;
        await resetTracking(admin);
        await admin.find(U.form.lastName).fill(lastName);
        await admin.find(U.form.save).click();
        const req = await waitForReq(admin, 'PUT', new RegExp(`/api/v1/users/${user.id}$`));
        expect(req.status).toBe(200);
        await waitForToast(admin, T.en.edited);
        expect((await apiUser(admin, user.id)).user?.lastName).toBe(lastName);
        user.lastName = lastName;
      });
    });

    describe('TC1453 – Edición de un usuario por otro usuario', () => {
      let user: TempUser;
      let since: number;

      beforeAll(async () => {
        user = await ensureUserA();
      });

      it('la edición carga desde la lista, se guarda con éxito y redirige a la lista', async () => {
        await goToUsers(admin);
        await applyFilter(admin, { field: 'Email', operator: 'Equals to', name: 'email', value: user.email });
        await openRowMenu(admin, user.id);
        await admin.find(U.menuEdit).click();
        await waitUntil(admin, `location.pathname === '/settings/users/edit/${user.id}' && document.querySelector('${U.form.firstName}')?.value`, 20_000);

        since = Date.now();
        await resetTracking(admin);
        await admin.find(U.form.firstName).fill('QA2');
        await admin.find(U.form.save).click();
        await waitForToast(admin, T.en.edited);
        await waitUntil(admin, `location.pathname === '/settings/users'`, 15_000);
        await waitForList(admin);
        expect((await apiUser(admin, user.id)).user).toMatchObject({ firstName: 'QA2', lastName: user.lastName, email: user.email });
        user.firstName = 'QA2';
        expect(await renderedRows(admin)).toContainEqual(expect.objectContaining({ id: user.id, firstName: 'QA2' }));
      });

      it('el usuario editado conserva su contraseña y recibe una notificación', async () => {
        const page = await loggedInPage(user.email, user.password);
        const end = Date.now() + 45_000;
        let recent: { body: string; createdAt: string }[] = [];
        while (Date.now() < end) {
          const r = await api<{ data: { body: string; createdAt: string }[] }>(page, 'GET', '/api/v1/notifications?page=1&limit=20');
          recent = (r.json.data ?? []).filter((n) => Date.parse(n.createdAt) >= since - 5_000);
          if (recent.length) break;
          await page.wait(3000);
        }
        expect(recent.length, 'notificación al usuario editado').toBeGreaterThan(0);
      });
    });

    describe('TC1525 – Inactivación segura y reactivación', () => {
      let user: TempUser;

      beforeAll(async () => {
        user = await ensureUserA();
        // Precondición: el usuario tiene registros propios (rol + dominio asignados en TC1524).
        await setRoleOrDomain(admin, user.id, 'roles', TEMP_ROLE, true);
        await setRoleOrDomain(admin, user.id, 'domains', TEMP_DOMAIN, true);
        recordA = await createOwnRecord(user);
      });

      afterAll(async () => {
        const page = await adminPage();
        await applyPreferences(page, BASELINE);
      });

      it('el modal de borrado ofrece "Safe Inactivation (Recommended)" (seleccionada) y "Permanent Deletion"', async () => {
        await goToUsers(admin);
        await applyFilter(admin, { field: 'Email', operator: 'Equals to', name: 'email', value: user.email });
        await openDeleteModal(admin, user.id);

        const modal = await evalJson<{ title: string; message: string; bold: string; cards: string[]; selected: string[]; confirm: string }>(
          admin,
          `{ title: document.querySelector('${U.modal} .modal-title').innerText.trim(),
             message: document.querySelector('${U.modal} .delete-user-modal-container p').innerText.trim(),
             bold: document.querySelector('${U.modal} .delete-user-modal-container p strong').innerText.trim(),
             cards: [...document.querySelectorAll('${U.modal} .delete-mode-card .card-title')].map(c => c.innerText.trim()),
             selected: [...document.querySelectorAll('${U.modal} .delete-mode-card.selected .card-title')].map(c => c.innerText.trim()),
             confirm: document.querySelector('${U.modal} .modal-footer .btn-danger').innerText.trim() }`,
        );
        expect(modal.title).toBe(T.en.deleteTitle);
        expect(modal.message).toBe(`${T.en.deleteMessage} ${user.firstName}:`);
        expect(modal.bold).toBe(user.firstName);
        expect(modal.cards).toEqual([T.en.softTitle, T.en.hardTitle]);
        expect(modal.selected).toEqual([T.en.softTitle]);
        expect(modal.confirm).toBe('Delete');
      });

      it('al confirmar, el usuario pasa a inactivo con toast de éxito y sale de la lista de activos', async () => {
        await resetTracking(admin);
        await admin.find(U.modalConfirm).click();
        const req = await waitForReq(admin, 'DELETE', new RegExp(`/api/v1/users-data/${user.id}\\?force=false$`));
        expect(req.status).toBeLessThan(300);
        await waitForToast(admin, T.en.softSuccess);
        await waitUntil(admin, `!document.querySelector('${U.modal}')`);
        expect((await apiUser(admin, user.id)).user?.active).toBe(false);
        await waitUntil(admin, `!document.querySelector('${rowSel(user.id)}')`);
      });

      it('con el filtro Active = No, la fila aparece atenuada y el menú muestra Activate en lugar de Delete', async () => {
        await goToInactiveUsers(admin);
        expect(await exists(admin, rowSel(user.id))).toBe(true);
        const row = await evalJson<{ cls: boolean; opacity: number }>(
          admin,
          `{ cls: document.querySelector('${rowSel(user.id)}').classList.contains('inactive-row'),
             opacity: Number(getComputedStyle(document.querySelector('${rowSel(user.id)} [id^="cell-email-"]')).opacity) }`,
        );
        expect(row.cls).toBe(true);
        expect(row.opacity).toBeLessThan(1);

        expect(await openRowMenu(admin, user.id)).toEqual(['Edit', 'Activate']);
        expect(await exists(admin, U.menuDelete)).toBe(false);
        expect(await exists(admin, U.menuActivate)).toBe(true); // botón con contorno verde
        await closeRowMenu(admin);
      });

      it('el usuario inactivo no puede iniciar sesión', async () => {
        const r = await attemptLogin(user.email, user.password);
        expect(r.path).toBe('/auth/login');
        expect(r.token).toBe(false);
        expect(r.toasts.join(' ')).toContain(T.en.loginError);
      });

      it('sus registros conservan el Owner (el usuario inactivo sigue asignado)', async () => {
        expect(recordA).toBeDefined();
        expect(await recordOwner(admin, recordA!)).toBe(user.id);
        expect(await recordViewOwner(recordA!)).toBe(`${user.firstName} ${user.lastName}`);
      });

      it('en español: "Activar" pide confirmación con el nombre en negrita y muestra el toast traducido', async () => {
        await goToInactiveUsers(admin);
        await switchLanguage(admin, 'es');
        await resetTracking(admin);

        await openRowMenu(admin, user.id);
        await admin.find(U.menuActivate).click();
        await waitUntil(admin, `document.querySelector('${U.modal} .modal-footer .btn-success')`);
        const modal = await evalJson<{ body: string; bold: string }>(
          admin,
          `{ body: document.querySelector('${U.modal} .modal-body').innerText.trim(),
             bold: document.querySelector('${U.modal} .modal-body strong')?.innerText.trim() }`,
        );
        const fullName = `${user.firstName} ${user.lastName}`;
        expect(modal.body).toBe(`${T.es.activateMessage} ${fullName}?`);
        expect(modal.bold).toBe(fullName);

        await admin.find(U.modalConfirm).click();
        const req = await waitForReq(admin, 'POST', new RegExp(`/api/v1/users-data/${user.id}/reactivate$`));
        expect(req.status).toBe(200);
        await waitForToast(admin, T.es.activateSuccess);
        expect((await apiUser(admin, user.id)).user?.active).toBe(true);
      });

      it('en español, el modal de borrado también está traducido (se cierra con Cancelar)', async () => {
        await goToUsers(admin);
        await waitUntil(admin, `document.querySelector('${U.subheader}').innerText.startsWith('Usuarios')`);
        // Cualquier usuario activo sirve: solo se abre el modal y se cancela.
        const [first] = await renderedRows(admin);
        await openDeleteModal(admin, first.id);
        const modal = await evalJson<{ title: string; message: string; cards: string[] }>(
          admin,
          `{ title: document.querySelector('${U.modal} .modal-title').innerText.trim(),
             message: document.querySelector('${U.modal} .delete-user-modal-container p').innerText.trim(),
             cards: [...document.querySelectorAll('${U.modal} .delete-mode-card .card-title')].map(c => c.innerText.trim()) }`,
        );
        expect(modal.title).toBe(T.es.deleteTitle);
        expect(modal.message).toContain(T.es.deleteMessage);
        expect(modal.cards).toEqual([T.es.softTitle, T.es.hardTitle]);
        await closeModalWithCancel(admin);
      });

      it('tras reactivar, la fila vuelve a opacidad completa y el menú muestra Delete', async () => {
        await applyPreferences(admin, BASELINE); // vuelve a inglés
        await goToUsers(admin);
        await applyFilter(admin, { field: 'Email', operator: 'Equals to', name: 'email', value: user.email });
        const row = await evalJson<{ cls: boolean; opacity: number }>(
          admin,
          `{ cls: document.querySelector('${rowSel(user.id)}').classList.contains('inactive-row'),
             opacity: Number(getComputedStyle(document.querySelector('${rowSel(user.id)} [id^="cell-email-"]')).opacity) }`,
        );
        expect(row).toEqual({ cls: false, opacity: 1 });
        expect(await openRowMenu(admin, user.id)).toEqual(['Edit', 'Delete']);
        await closeRowMenu(admin);
      });
    });

    describe('TC1452 – Borrado permanente de un usuario', () => {
      it('con reasignación: el usuario se elimina y sus registros pasan al usuario seleccionado', async () => {
        const user = await ensureUserA();
        if (!recordA) {
          await setRoleOrDomain(admin, user.id, 'roles', TEMP_ROLE, true);
          await setRoleOrDomain(admin, user.id, 'domains', TEMP_DOMAIN, true);
          recordA = await createOwnRecord(user);
        }
        const me = (await api<{ data: { id: string; firstName: string; lastName: string } }>(admin, 'GET', '/api/v1/users/me')).json.data;

        await goToUsers(admin);
        await applyFilter(admin, { field: 'Email', operator: 'Equals to', name: 'email', value: user.email });
        await openDeleteModal(admin, user.id);

        // Permanent Deletion se resalta (borde rojo) y despliega el selector de reasignación.
        await admin.find(U.hardCard).click();
        await waitUntil(admin, `document.querySelector('${U.reassign}')`);
        // El borde cambia con una transición CSS: esperar a que termine (rojo).
        await waitUntil(
          admin,
          `(([r, g, b]) => r > 150 && g < 100 && b < 100)(getComputedStyle(document.querySelector('${U.hardCard}')).borderTopColor.match(/\\d+/g).map(Number))`,
          5_000,
        ).catch(() => {});
        const hard = await evalJson<{ selected: boolean; border: string; label: string; placeholder: string; info: string; confirm: string }>(
          admin,
          `(() => { const c = document.querySelector('${U.hardCard}'); const s = getComputedStyle(c);
            return { selected: c.classList.contains('selected'), border: s.borderTopColor,
              label: document.querySelector('${U.reassign} label').innerText.trim(),
              placeholder: document.querySelector('${U.reassign} .p-treeselect-label').innerText.trim(),
              info: document.querySelector('${U.reassign} .smallest').innerText.trim(),
              confirm: document.querySelector('${U.modal} .modal-footer .btn-danger').innerText.trim() }; })()`,
        );
        expect(hard.selected).toBe(true);
        const [r, g, bl] = hard.border.match(/\d+/g)!.map(Number);
        expect(r).toBeGreaterThan(150); // rojo
        expect(g).toBeLessThan(100);
        expect(bl).toBeLessThan(100);
        expect(hard).toMatchObject({
          label: T.en.reassignLabel,
          placeholder: T.en.reassignPlaceholder,
          info: T.en.reassignInfo,
          confirm: T.en.forceAction,
        });

        // Reasignar al usuario de QA actual.
        const meLabel = `${me.firstName} ${me.lastName}`;
        await pickTreeOption(admin, `${U.reassign} .p-treeselect`, meLabel);
        expect(await admin.find(`${U.reassign} .p-treeselect-label`).text()).toBe(meLabel);

        await resetTracking(admin);
        await admin.find(U.modalConfirm).click();
        const req = await waitForReq(admin, 'DELETE', new RegExp(`/api/v1/users-data/${user.id}\\?`));
        expect(req.url).toContain('force=true');
        expect(req.url).toContain(me.id);
        expect(req.status).toBeLessThan(300);
        await waitForToast(admin, T.en.hardSuccess);
        await waitUntil(admin, `!document.querySelector('${U.modal}')`);

        expect((await apiUser(admin, user.id)).status).toBe(404);
        await goToUsers(admin);
        expect((await renderedRows(admin)).map((x) => x.id)).not.toContain(user.id);
        await goToInactiveUsers(admin);
        expect((await renderedRows(admin)).map((x) => x.id)).not.toContain(user.id);

        expect(await recordOwner(admin, recordA!)).toBe(me.id);
        expect(await recordViewOwner(recordA!)).toBe(meLabel);
      });

      it('sin reasignación: el usuario se elimina y sus registros quedan sin Owner (NULL)', async () => {
        const { user, recordId } = await userWithRecord(admin, 'b');

        await goToUsers(admin);
        await applyFilter(admin, { field: 'Email', operator: 'Equals to', name: 'email', value: user.email });
        await openDeleteModal(admin, user.id);
        await admin.find(U.hardCard).click();
        await waitUntil(admin, `document.querySelector('${U.reassign}')`);

        await resetTracking(admin);
        await admin.find(U.modalConfirm).click();
        const req = await waitForReq(admin, 'DELETE', new RegExp(`/api/v1/users-data/${user.id}\\?`));
        expect(req.url).toContain('force=true');
        expect(req.status).toBeLessThan(300);
        await waitForToast(admin, T.en.hardSuccess);

        expect((await apiUser(admin, user.id)).status).toBe(404);
        expect(await recordOwner(admin, recordId)).toBeNull();
        expect(await recordViewOwner(recordId)).not.toContain(user.lastName);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Casos obsoletos (la funcionalidad ya no existe en qa2)
  // ────────────────────────────────────────────────────────────────────────────────

  describe('Casos obsoletos', () => {
    // El perfil (/profile) solo tiene Avatar, Notifications, General Information y Preferences.
    it.skip('[obsoleto] TC1450 – Gestión de teléfonos en el perfil (Add / Edit / Delete)', () => {});
    it.skip('[obsoleto] TC1451 – Gestión de direcciones en el perfil (Add / Edit / Delete)', () => {});
    // Reemplazado por TC1523 (vista única de creación) y TC1524 (pestañas Roles / Domains).
    it.skip('[obsoleto] TC1454 – Wizard de creación (Basic Information → Addresses → Account)', () => {});
  });
});
