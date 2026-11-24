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
  applyPreferences,
  evalJson,
  newIsolatedPage,
  startBrowser,
  waitUntil,
  type Browser,
  type Page,
} from '../support/datascend';
import { AppShell, SHELL_SEL } from '../support/pages/AppShell';
import { ConfirmModal } from '../support/pages/ConfirmModal';
import { FILTER_SEL, FilterDrawer } from '../support/pages/FilterDrawer';
import { LoginPage, type LoginAttempt } from '../support/pages/LoginPage';
import { UserFormPage, type AssignmentKind } from '../support/pages/UserFormPage';
import { USERS_SEL as U, UsersListPage } from '../support/pages/UsersListPage';
import { api, loggedInPage as sessionPage, navigate } from '../support/session';

/** Entidad en la que los usuarios temporales crean un registro propio (Sprint en qa2; campo "name"). */
const RECORD_ENTITY_ID = process.env.DATASCEND_USERS_RECORD_ENTITY_ID ?? 'a1d50794-eeea-4e55-9b94-e25f9ed5b3ee';
const RECORD_ENTITY_FIELD = process.env.DATASCEND_USERS_RECORD_ENTITY_FIELD ?? 'name';
/** Rol y dominio que se asignan a los usuarios temporales para que puedan crear registros. */
const TEMP_ROLE = 'Administrator';
const TEMP_DOMAIN = 'PRINCIPAL';
const PAGE_SIZE = 10;

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

/** Página aislada con sesión iniciada, dominio seleccionado y registro de peticiones/toasts (TRACK). */
const loggedInPage = (email?: string, password?: string): Promise<Page> =>
  sessionPage(b, { email, password, initScript: TRACK });

/**
 * Hora actual según el servidor de QA2 (cabecera `Date`, resolución de 1 s). Se usa para comparar con
 * `createdAt` de las notificaciones: el reloj local puede ir desfasado varios segundos respecto a QA2
 * (observado: ~7 s por delante), lo que hacía descartar notificaciones legítimas. Si la cabecera no está
 * disponible, recurre al reloj local.
 */
async function serverNow(page: Page): Promise<number> {
  const date = await page
    .evaluate<string>(`fetch('/api/v1/notifications/unread-count', { cache: 'no-store' }).then(r => r.headers.get('date') ?? '')`)
    .catch(() => '');
  const t = Date.parse(date);
  return Number.isNaN(t) ? Date.now() : t;
}

const adminPage = () => loggedInPage();

/**
 * Abre el listado de Users y espera a la tabla. Los formularios de Users hacen `history.back()` al
 * guardar: para llegar a ellos se navega con clics desde el listado (SPA), como el usuario.
 */
async function goToUsers(page: Page, query = ''): Promise<UsersListPage> {
  const list = new UsersListPage(page);
  await list.goto(query);
  return list;
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

const resetTracking = (page: Page) =>
  page.evaluate(`window.__reqs = []; window.__toasts = []; document.querySelectorAll('${SHELL_SEL.toast}').forEach(t => t.remove())`);

/** Aplica un filtro desde el drawer "Filters" (FilterDrawer) y espera la recarga de la tabla. */
async function applyFilter(
  page: Page,
  f: { field: 'First Name' | 'Last Name' | 'Email' | 'Active'; operator?: string; name?: string; value: string },
): Promise<void> {
  const drawer = new FilterDrawer(page);
  await drawer.addCondition({
    field: f.field,
    operator: f.operator,
    value: f.value,
    input: f.field === 'Active' ? { name: 'active', type: 'radio' } : { name: f.name },
  });
  await page.evaluate('window.__reqs = []');
  await drawer.apply();
  await waitForReq(page, 'GET', /\/api\/v1\/users\/\?/);
  await page.wait(500);
}

/** Lista de usuarios inactivos (filtro Active = No aplicado desde el drawer). */
async function goToInactiveUsers(page: Page): Promise<UsersListPage> {
  const list = await goToUsers(page);
  await applyFilter(page, { field: 'Active', value: 'false' });
  return list;
}

/** Lista filtrada por el email exacto del usuario. */
async function showOnlyUser(page: Page, email: string): Promise<UsersListPage> {
  const list = await goToUsers(page);
  await applyFilter(page, { field: 'Email', operator: 'Equals to', name: 'email', value: email });
  return list;
}

/**
 * Asigna o quita un rol/dominio desde la pestaña Roles/Domains de la edición (la abre desde el
 * listado si hace falta) y devuelve la petición que guardó el cambio ('NONE' si ya estaba así).
 */
async function setRoleOrDomain(
  page: Page,
  userId: string,
  kind: AssignmentKind,
  name: string,
  on: boolean,
): Promise<Req & { itemId: string }> {
  let form = new UserFormPage(page);
  if (!(await form.isEditing(userId))) form = await openEditFromList(page, userId);
  await form.openAssignmentTab(kind);
  const item = await form.findAssignment(kind, name);
  expect(item, `${kind}: "${name}" en la tabla`).toBeDefined();
  const { itemId } = item!;
  if (item!.checked === on) return { method: 'NONE', url: '', status: 200, itemId };
  await page.evaluate('window.__reqs = []');
  await form.toggleAssignment(item!);
  await waitUntil(page, `(window.__reqs ?? []).some(r => r.method !== 'GET' && r.url.includes('${itemId}') && r.status > 0)`);
  await form.waitForAssignment(item!, on);
  return { ...(await reqs(page)).find((r) => r.method !== 'GET' && r.url.includes(itemId))!, itemId };
}

/** Ids de roles o dominios asignados según la API (acepta lista de ids o de objetos). */
async function assignedIds(page: Page, userId: string, kind: AssignmentKind): Promise<string[]> {
  const r = await api<{ data: (string | { id: string })[] }>(page, 'GET', `/api/v1/users-data/${userId}/${kind}`);
  expect(r.status).toBe(200);
  return r.json.data.map((x) => (typeof x === 'string' ? x : x.id)).sort();
}

/** Abre la edición haciendo clic en el nombre (navegación SPA, como el usuario). */
async function openEditFromList(page: Page, userId: string): Promise<UserFormPage> {
  const user = (await apiUser(page, userId)).user!;
  const list = await showOnlyUser(page, user.email);
  return list.openEdit(userId);
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
  const list = await goToUsers(page);
  const form = await list.clickAddUser();
  await form.fill(u);
  await form.save();
  await waitUntil(page, `location.pathname === '${UsersListPage.PATH}'`, 20_000);
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

/** Intenta iniciar sesión en un contexto limpio y devuelve la ruta final, los toasts y si quedó sesión. */
async function attemptLogin(email: string, password: string): Promise<LoginAttempt> {
  const { page } = await newIsolatedPage(b, TRACK);
  return new LoginPage(page).attempt(email, password);
}

// ────────────────────────────────────────────────────────────────────────────────
// Casos de solo lectura
// ────────────────────────────────────────────────────────────────────────────────

describe('Settings › Users', () => {
  describe('TC1527 – Pantalla Users', () => {
    let page: Page;
    let list: UsersListPage;

    beforeAll(async () => {
      page = await adminPage();
      list = new UsersListPage(page);
    });

    it('menú de usuario → "Settings" redirige a /settings/users', async () => {
      const shell = new AppShell(page);
      expect((await shell.userMenuItems()).map((i) => i.text)).toContain('Settings');

      await shell.clickUserMenuItem('Settings');
      await waitUntil(page, `location.pathname === '${UsersListPage.PATH}'`, 15_000);
      await list.waitForLoaded();
      expect(await page.url()).toBe(`${BASE_URL}${UsersListPage.PATH}`);
    });

    it('muestra el título "Users", el botón "Add User" y el acceso a filtros', async () => {
      const head = await evalJson<{ add: string; filters: boolean; sidebarActive: boolean }>(
        page,
        `{ add: document.querySelector('${U.addUser}')?.innerText.trim(),
           filters: !!document.querySelector('${FILTER_SEL.toggle}'),
           sidebarActive: !!document.querySelector('${U.sidebarLink}') }`,
      );
      expect({ title: await list.title(), ...head }).toEqual({ title: 'Users', add: 'Add User', filters: true, sidebarActive: true });
    });

    it('el drawer de filtros ofrece First Name, Last Name, Email y Active, con "Apply Filters" y "Clear"', async () => {
      const drawer = new FilterDrawer(page);
      await drawer.open();
      // "Clear" está en la cabecera y "Apply Filters" en el pie del drawer: se espera a que ambos
      // existan con texto antes de leerlos.
      const drawerButtons = `[${JSON.stringify(FILTER_SEL.apply)}, ${JSON.stringify(FILTER_SEL.clear)}].map(s => document.querySelector(s)?.innerText.trim() ?? '')`;
      await waitUntil(page, `(${drawerButtons}).every(Boolean)`);
      const buttons = await evalJson<string[]>(page, drawerButtons);
      expect(buttons).toEqual(['Apply Filters', 'Clear']);

      expect(await drawer.field.getOptions()).toEqual(['First Name', 'Last Name', 'Email', 'Active']);

      // Cierra el panel del TreeSelect y el drawer, y espera a que termine de deslizarse y se desmonte.
      await drawer.close();
    });

    it('la tabla tiene las columnas First Name, Last Name, Email y una columna de acciones siempre visible', async () => {
      expect(await list.columnHeaders()).toEqual(['First Name', 'Last Name', 'Email', '']);

      const actions = await list.rowActionsLayout();
      expect(actions.rows).toBeGreaterThan(0);
      expect(actions.withMenu).toBe(actions.rows);
      expect(actions.inViewport).toBe(true);
    });

    it('el menú ⋮ de cada fila ofrece Edit y Delete', async () => {
      const [first] = await list.rows();
      expect(await list.openRowMenu(first.id)).toEqual(['Edit', 'Delete']);
      expect(await list.editHref()).toBe(`/settings/users/edit/${first.id}`);
      await list.closeRowMenu();
    });

    it('muestra la paginación con "Rows per page" y el rango de registros', async () => {
      const { total } = await apiUsers(page);
      expect(await list.pageSizeOptions()).toEqual(['10', '20', '30', '40', '50']);
      const firstLabel = `1-${Math.min(total, PAGE_SIZE)} of ${total}`;
      expect(await list.paginationLabelEventually(firstLabel)).toBe(firstLabel);
    });
  });

  describe('TC1528 – Filtro por Email', () => {
    let page: Page;
    let list: UsersListPage;
    let all: ApiUser[];

    beforeAll(async () => {
      page = await adminPage();
      all = (await apiUsers(page, { limit: 50 })).users;
      list = await goToUsers(page);
    });

    it('sin filtros se muestra la lista completa de usuarios', async () => {
      const rows = await list.rows();
      expect(rows.map((r) => r.id)).toEqual(all.slice(0, PAGE_SIZE).map((u) => u.id));
    });

    it('"Email" + "Equals to" con un email existente muestra solo ese usuario', async () => {
      const target = all.find((u) => u.email !== 'system@multiplied.com') ?? all[0];
      await applyFilter(page, { field: 'Email', operator: 'Equals to', name: 'email', value: target.email });

      const listReq = (await reqs(page)).find((r) => r.method === 'GET' && /\/api\/v1\/users\/\?/.test(r.url))!;
      expect(decodeURIComponent(listReq.url)).toContain(`key=email&operator=eq&value=${target.email}`);
      expect((await list.rows()).map((r) => r.email)).toEqual([target.email]);
      expect(await new FilterDrawer(page).getActiveFilters()).toContain(target.email);
    });

    it('"Email" + "Like" muestra solo los usuarios cuyo email contiene el texto', async () => {
      // Fragmento compartido por al menos un email, pero no por todos (si es posible).
      const domains = [...new Set(all.map((u) => u.email.split('@')[1]))];
      const fragment = domains.find((d) => all.filter((u) => u.email.includes(d)).length < all.length) ?? domains[0];
      const expected = all.filter((u) => u.email.toLowerCase().includes(fragment.toLowerCase()));

      await list.goto();
      await applyFilter(page, { field: 'Email', operator: 'Like', name: 'email', value: fragment });

      const rows = await list.rows();
      expect(rows.length).toBe(Math.min(expected.length, PAGE_SIZE));
      expect(rows.every((r) => r.email.toLowerCase().includes(fragment.toLowerCase()))).toBe(true);
      expect(await new FilterDrawer(page).getActiveFilters()).toContain(`Email Like: ${fragment}`);
      const totalRe = new RegExp(`of ${expected.length}$`);
      expect(await list.paginationLabelEventually(totalRe)).toMatch(totalRe);
    });

    it('quitar el filtro restaura la lista completa', async () => {
      await page.evaluate('window.__reqs = []');
      await new FilterDrawer(page).removeActiveFilter();
      await waitForReq(page, 'GET', /\/api\/v1\/users\/\?/);
      await list.waitForLoaded();
      expect((await list.rows()).map((r) => r.id)).toEqual(all.slice(0, PAGE_SIZE).map((u) => u.id));
    });
  });

  describe('TC1526 – Paginación (navegación entre páginas)', () => {
    let page: Page;
    let list: UsersListPage;
    let total: number;
    const seeded: string[] = [];

    beforeAll(async () => {
      page = await adminPage();
      total = (await apiUsers(page)).total;
      // Precondición del caso: más usuarios activos de los que caben en una página (12 si se muestran 10).
      // Si no los hay, se crean usuarios temporales desde "Add User" (se borran en afterAll).
      for (let i = total; i < PAGE_SIZE + 2; i++) seeded.push((await createUserViaUi(page, `page${i}`)).id);
      total = (await apiUsers(page)).total;
      list = await goToUsers(page);
    });

    afterAll(async () => {
      for (const id of seeded) await api(page, 'DELETE', `/api/v1/users-data/${id}?force=true`);
    });

    it('la primera página muestra "1-N of X" con "<" deshabilitado', async () => {
      const firstLabel = `1-${Math.min(total, PAGE_SIZE)} of ${total}`;
      expect(await list.paginationLabelEventually(firstLabel)).toBe(firstLabel);
      expect(await list.isPageButtonDisabled('prev')).toBe(true);
      expect((await list.rows()).length).toBe(Math.min(total, PAGE_SIZE));
    });

    it('">" carga la segunda página y "<" vuelve a la primera', async () => {
      expect(total).toBeGreaterThan(PAGE_SIZE);
      const firstPage = (await list.rows()).map((r) => r.id);
      const page2 = (await apiUsers(page, { page: 2 })).users.map((u) => u.id);

      await page.evaluate('window.__reqs = []');
      await list.nextPage();
      const req = await waitForReq(page, 'GET', /\/api\/v1\/users\/\?.*page=2/);
      expect(req.status).toBe(200);
      await list.waitForPageChange(PAGE_SIZE + 1, page2[0]);
      const page2Label = `${PAGE_SIZE + 1}-${Math.min(total, 2 * PAGE_SIZE)} of ${total}`;
      expect(await list.paginationLabelEventually(page2Label)).toBe(page2Label);
      expect(await list.isPageButtonDisabled('prev')).toBe(false);
      expect((await list.rows(page2.length)).map((r) => r.id)).toEqual(page2);

      await list.prevPage();
      await list.waitForPageChange(1, firstPage[0]);
      const page1Label = `1-${PAGE_SIZE} of ${total}`;
      expect(await list.paginationLabelEventually(page1Label)).toBe(page1Label);
      expect(await list.isPageButtonDisabled('prev')).toBe(true);
      expect((await list.rows(firstPage.length)).map((r) => r.id)).toEqual(firstPage);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Ciclo de vida con usuarios temporales (se borran en afterAll)
  // ────────────────────────────────────────────────────────────────────────────────

  describe('Ciclo de vida de un usuario temporal', () => {
    let admin: Page;
    let list: UsersListPage;
    let userA: TempUser | undefined;
    let recordA: string | undefined;

    beforeAll(async () => {
      admin = await adminPage();
      list = new UsersListPage(admin);
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
      let form: UserFormPage;

      it('"Add User" abre una vista única con solo First name, Last name, Email y Password', async () => {
        await list.goto();
        form = await list.clickAddUser();

        const view = await form.view();
        expect(view.inputs).toEqual(['firstName', 'lastName', 'email', 'password']);
        expect(view.labels).toEqual(['First Name *', 'Last Name *', 'Email *', 'Password *']);
        expect(view.tabs).toBe(0); // sin wizard ni pestañas secundarias
        expect(view.buttons).toEqual(['Save', 'Cancel']);
      });

      it('al guardar se crea el usuario, se confirma con un mensaje y aparece en la lista', async () => {
        await resetTracking(admin);
        await form.fill(data);
        await form.save();

        await waitUntil(admin, `location.pathname === '${UsersListPage.PATH}'`, 20_000);
        const { users } = await apiUsers(admin, { limit: 1, filter: filterQuery('email', 'eq', data.email) });
        expect(users).toHaveLength(1);
        userA = { ...data, id: users[0].id };
        tempUsers.push(userA);
        expect(users[0]).toMatchObject({ firstName: data.firstName, lastName: data.lastName, active: true });

        await list.waitForLoaded();
        await applyFilter(admin, { field: 'Email', operator: 'Equals to', name: 'email', value: data.email });
        expect(await list.rows()).toEqual([
          { id: userA.id, firstName: data.firstName, lastName: data.lastName, email: data.email, inactive: false },
        ]);
        expect(await evalJson<string[]>(admin, 'window.__toasts')).toContain(T.en.created);
      });
    });

    describe('TC1524 – Vista de edición: campos requeridos y pestañas Roles / Domains', () => {
      let user: TempUser;
      let form: UserFormPage;

      beforeAll(async () => {
        user = await ensureUserA();
        await showOnlyUser(admin, user.email);
      });

      it('al hacer clic en el usuario se abre la edición con los datos precargados', async () => {
        form = await list.openEdit(user.id);
        const values = await form.values();
        expect(values).toMatchObject({ firstName: user.firstName, lastName: user.lastName, email: user.email });
        expect(values.password).toBeTruthy(); // valor enmascarado
        expect(await form.labels()).toEqual(['First Name *', 'Last Name *', 'Email *', 'New Password *']);
      });

      it('solo existen las pestañas Basic Information, Roles y Domains', async () => {
        expect(await form.tabNames()).toEqual(['Basic Information', 'Roles', 'Domains']);
      });

      it('Roles muestra los roles asignados y permite asignar y quitar roles', async () => {
        await form.openAssignmentTab('roles');
        const shown = await form.assignments('roles');
        expect(shown.filter((r) => r.checked).map((r) => r.itemId).sort()).toEqual(await assignedIds(admin, user.id, 'roles'));

        // Asignar y quitar "Default role" (sin permisos).
        await resetTracking(admin);
        const add = await setRoleOrDomain(admin, user.id, 'roles', 'Default role', true);
        expect(add.method).toBe('PUT');
        expect(add.url).toMatch(new RegExp(`/api/v1/roles/[0-9a-f-]+/users/${user.id}$`));
        expect(add.status).toBe(200);
        await new AppShell(admin).waitForToast(T.en.roleUpdated);
        expect(await assignedIds(admin, user.id, 'roles')).toContain(add.itemId);

        const remove = await setRoleOrDomain(admin, user.id, 'roles', 'Default role', false);
        expect(remove.status).toBeLessThan(300);
        expect(await assignedIds(admin, user.id, 'roles')).not.toContain(add.itemId);

        // Rol con permisos que se usa luego para crear un registro propio.
        await setRoleOrDomain(admin, user.id, 'roles', TEMP_ROLE, true);
      });

      it('Domains muestra los dominios asignados y permite asignarlos', async () => {
        await form.openAssignmentTab('domains');
        const shown = (await form.assignments('domains')).filter((d) => d.checked).map((d) => d.itemId);
        expect(shown.sort()).toEqual(await assignedIds(admin, user.id, 'domains'));

        const req = await setRoleOrDomain(admin, user.id, 'domains', TEMP_DOMAIN, true);
        expect(req.status).toBeLessThan(300);
        expect(await assignedIds(admin, user.id, 'domains')).toContain(req.itemId);
      });

      it('modificar un campo y guardar actualiza el usuario con mensaje de confirmación', async () => {
        const edit = await openEditFromList(admin, user.id);
        const lastName = `${user.lastName} edited`;
        await resetTracking(admin);
        await edit.fill({ lastName });
        await edit.save();
        const req = await waitForReq(admin, 'PUT', new RegExp(`/api/v1/users/${user.id}$`));
        expect(req.status).toBe(200);
        await new AppShell(admin).waitForToast(T.en.edited);
        expect((await apiUser(admin, user.id)).user?.lastName).toBe(lastName);
        user.lastName = lastName;
      });
    });

    describe('TC1453 – Edición de un usuario por otro usuario', () => {
      let user: TempUser;
      let since: number;

      beforeAll(async () => {
        user = await ensureUserA();
        // Precondición (idempotente): rol + dominio, normalmente asignados en TC1524. Sin dominio el
        // usuario no llega a /dashboard tras el login, y el caso falla si se ejecuta aislado (-t TC1453).
        await setRoleOrDomain(admin, user.id, 'roles', TEMP_ROLE, true);
        await setRoleOrDomain(admin, user.id, 'domains', TEMP_DOMAIN, true);
      });

      it('la edición carga desde la lista, se guarda con éxito y redirige a la lista', async () => {
        await showOnlyUser(admin, user.email);
        const form = await list.editFromMenu(user.id);

        // Reloj del servidor, no el local (ver serverNow): `createdAt` de la notificación lo fija QA2.
        since = await serverNow(admin);
        await resetTracking(admin);
        await form.fill({ firstName: 'QA2' });
        await form.save();
        await new AppShell(admin).waitForToast(T.en.edited);
        await waitUntil(admin, `location.pathname === '${UsersListPage.PATH}'`, 15_000);
        await list.waitForLoaded();
        expect((await apiUser(admin, user.id)).user).toMatchObject({ firstName: 'QA2', lastName: user.lastName, email: user.email });
        user.firstName = 'QA2';
        expect(await list.rows()).toContainEqual(expect.objectContaining({ id: user.id, firstName: 'QA2' }));
      });

      /**
       * La notificación se genera de forma asíncrona en QA2 y su latencia varía. Se sondea hasta 150 s con
       * backoff (3 s → 10 s), tolerando errores transitorios de la API; el timeout del test se amplía en
       * consecuencia. `since` está en hora del servidor (resolución 1 s), de ahí el margen de 2 s.
       */
      const NOTIFY_MAX_WAIT_MS = 150_000;
      it('el usuario editado conserva su contraseña y recibe una notificación', async () => {
        const page = await loggedInPage(user.email, user.password);
        const end = Date.now() + NOTIFY_MAX_WAIT_MS;
        let recent: { body: string; createdAt: string }[] = [];
        let attempts = 0;
        let delay = 3_000;
        while (Date.now() < end) {
          attempts++;
          const r = await api<{ data: { body: string; createdAt: string }[] }>(page, 'GET', '/api/v1/notifications?page=1&limit=20').catch(
            () => undefined,
          );
          recent = (r?.json?.data ?? []).filter((n) => Date.parse(n.createdAt) >= since - 2_000);
          if (recent.length) break;
          await page.wait(Math.min(delay, Math.max(0, end - Date.now())));
          delay = Math.min(delay * 1.5, 10_000);
        }
        expect(recent.length, `notificación al usuario editado (${attempts} consultas en ${NOTIFY_MAX_WAIT_MS / 1000}s)`).toBeGreaterThan(0);
      }, NOTIFY_MAX_WAIT_MS + 60_000);
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
        await showOnlyUser(admin, user.email);
        const modal = await (await list.openDeleteModal(user.id)).content();
        expect(modal.title).toBe(T.en.deleteTitle);
        expect(modal.message).toBe(`${T.en.deleteMessage} ${user.firstName}:`);
        expect(modal.bold).toBe(user.firstName);
        expect(modal.cards).toEqual([T.en.softTitle, T.en.hardTitle]);
        expect(modal.selected).toEqual([T.en.softTitle]);
        expect(modal.confirm).toBe('Delete');
      });

      it('al confirmar, el usuario pasa a inactivo con toast de éxito y sale de la lista de activos', async () => {
        const modal = new ConfirmModal(admin);
        await resetTracking(admin);
        await modal.confirm();
        const req = await waitForReq(admin, 'DELETE', new RegExp(`/api/v1/users-data/${user.id}\\?force=false$`));
        expect(req.status).toBeLessThan(300);
        await new AppShell(admin).waitForToast(T.en.softSuccess);
        await modal.waitForClosed();
        expect((await apiUser(admin, user.id)).user?.active).toBe(false);
        await list.waitForRowGone(user.id);
      });

      it('con el filtro Active = No, la fila aparece atenuada y el menú muestra Activate en lugar de Delete', async () => {
        await goToInactiveUsers(admin);
        expect(await list.hasRow(user.id)).toBe(true);
        const row = await list.rowStyle(user.id);
        expect(row.cls).toBe(true);
        expect(row.opacity).toBeLessThan(1);

        expect(await list.openRowMenu(user.id)).toEqual(['Edit', 'Activate']);
        expect(await list.hasMenuAction('delete')).toBe(false);
        expect(await list.hasMenuAction('activate')).toBe(true); // botón con contorno verde
        await list.closeRowMenu();
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
        await list.switchLanguage('es');
        // El cambio de idioma re-renderiza la tabla: esperar a que la fila inactiva vuelva a estar lista.
        await list.waitForLoaded();
        await resetTracking(admin);

        await list.waitForRowState(user.id, false); // deja el menú abierto con "Activar"
        const modal = await list.clickActivate('Activar');
        // Modal visible (fin del fade) y con el texto ya traducido.
        await modal.waitForVisible({ ready: ConfirmModal.SEL.success, bodyIncludes: T.es.activateMessage, timeout: 15_000 });
        const { body, bold } = await modal.bodyWithBold();
        const fullName = `${user.firstName} ${user.lastName}`;
        expect(body).toBe(`${T.es.activateMessage} ${fullName}?`);
        expect(bold).toBe(fullName);

        expect(await modal.buttonText('success')).toBe('Activar');
        await modal.press('success');
        const req = await waitForReq(admin, 'POST', new RegExp(`/api/v1/users-data/${user.id}/reactivate$`), 30_000);
        expect(req.status).toBe(200);
        await new AppShell(admin).waitForToast(T.es.activateSuccess, 30_000);
        await modal.waitForClosed(15_000);
        expect((await apiUser(admin, user.id)).user?.active).toBe(true);
      });

      it('en español, el modal de borrado también está traducido (se cierra con Cancelar)', async () => {
        await list.goto();
        await list.waitForTitle('Usuarios');
        // Cualquier usuario activo sirve: solo se abre el modal y se cancela.
        const [first] = await list.rows();
        const deleteModal = await list.openDeleteModal(first.id);
        const modal = await deleteModal.content();
        expect(modal.title).toBe(T.es.deleteTitle);
        expect(modal.message).toContain(T.es.deleteMessage);
        expect(modal.cards).toEqual([T.es.softTitle, T.es.hardTitle]);
        await deleteModal.cancel();
      });

      it('tras reactivar, la fila vuelve a opacidad completa y el menú muestra Delete', async () => {
        await applyPreferences(admin, BASELINE); // vuelve a inglés
        await showOnlyUser(admin, user.email);
        // Espera a que la fila deje de estar atenuada y el menú cambie de "Activate" a "Delete".
        const items = await list.waitForRowState(user.id, true);
        expect(items).toEqual(['Edit', 'Delete']);
        await list.closeRowMenu();
        expect(await list.rowStyle(user.id)).toEqual({ cls: false, opacity: 1 });
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

        await showOnlyUser(admin, user.email);
        const modal = await list.openDeleteModal(user.id);

        // Permanent Deletion se resalta (borde rojo) y despliega el selector de reasignación.
        await modal.choosePermanentDeletion();
        // El borde cambia con una transición CSS: esperar a que termine (rojo).
        await modal.waitForHardCardHighlighted();
        const hard = await modal.permanentDeletionState();
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
        await modal.pickReassignUser(meLabel);
        expect(await modal.reassignValue()).toBe(meLabel);

        await resetTracking(admin);
        await modal.confirm();
        const req = await waitForReq(admin, 'DELETE', new RegExp(`/api/v1/users-data/${user.id}\\?`), 30_000);
        expect(req.url).toContain('force=true');
        expect(req.url).toContain(me.id);
        expect(req.status).toBeLessThan(300);
        await new AppShell(admin).waitForToast(T.en.hardSuccess);
        await modal.waitForClosed();

        expect((await apiUser(admin, user.id)).status).toBe(404);
        await list.goto();
        expect((await list.rows()).map((x) => x.id)).not.toContain(user.id);
        await goToInactiveUsers(admin);
        expect((await list.rows()).map((x) => x.id)).not.toContain(user.id);

        expect(await recordOwner(admin, recordA!)).toBe(me.id);
        expect(await recordViewOwner(recordA!)).toBe(meLabel);
      });

      it('sin reasignación: el usuario se elimina y sus registros quedan sin Owner (NULL)', async () => {
        const { user, recordId } = await userWithRecord(admin, 'b');

        await showOnlyUser(admin, user.email);
        const modal = await list.openDeleteModal(user.id);
        await modal.choosePermanentDeletion();

        await resetTracking(admin);
        await modal.confirm();
        const req = await waitForReq(admin, 'DELETE', new RegExp(`/api/v1/users-data/${user.id}\\?`));
        expect(req.url).toContain('force=true');
        expect(req.status).toBeLessThan(300);
        await new AppShell(admin).waitForToast(T.en.hardSuccess);

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
