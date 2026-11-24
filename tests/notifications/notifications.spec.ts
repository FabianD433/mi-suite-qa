/**
 * DatAscend (qa2) – Notifications
 * Casos de origen: tests/notifications/TestCases_06-11-26-16_23_03.csv (módulo "Notifications").
 *
 * Modo por defecto (seguro): las acciones que modifican notificaciones (Dismiss, Delete, Dismiss All,
 * Delete All) se interceptan en el navegador y reciben un 200 simulado. Se valida la petición
 * (método/URL), los modales, los toasts y el cambio de UI, sin tocar los datos de la cuenta de QA.
 *
 * NOTIFICATIONS_DESTRUCTIVE=true: las mismas acciones se envían al backend real y además se valida
 * la persistencia vía API/recarga. ¡Delete All borra TODAS las notificaciones de la cuenta!
 *
 * TC1353 y TC1431 (flujo con dos usuarios) requieren DATASCEND_USER_B_EMAIL / _PASSWORD.
 * La suscripción push nunca se envía al backend: se intercepta siempre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE_URL,
  evalJson,
  newIsolatedPage,
  startBrowser,
  pollEvaluate,
  waitUntil,
  type Browser,
  type Page,
} from '../support/datascend';
import { AppShell, SHELL_SEL } from '../support/pages/AppShell';
import { LoginPage } from '../support/pages/LoginPage';
import { NOTIF_SEL as N, NotificationsDrawer, type LayoutState } from '../support/pages/NotificationsDrawer';
import { api } from '../support/session';

const DESTRUCTIVE = process.env.NOTIFICATIONS_DESTRUCTIVE === 'true';
const USER_B = {
  email: process.env.DATASCEND_USER_B_EMAIL,
  password: process.env.DATASCEND_USER_B_PASSWORD,
};
/** Entidad con "List As" usada en TC1353 (Sprint en qa2; List As = name). */
const NOTIF_ENTITY_ID = process.env.DATASCEND_NOTIF_ENTITY_ID ?? 'a1d50794-eeea-4e55-9b94-e25f9ed5b3ee';
const NOTIF_ENTITY_LIST_AS = process.env.DATASCEND_NOTIF_ENTITY_LIST_AS ?? 'name';
/** Entidad con campo de texto enriquecido usada en TC1431 (Ticket en qa2; campo description). */
const RICH_ENTITY_ID = process.env.DATASCEND_RICHTEXT_ENTITY_ID ?? 'ca6ab3e8-baaa-4194-9bdb-ce55c972975d';
const RICH_FIELD = process.env.DATASCEND_RICHTEXT_FIELD ?? 'description';

/** Textos de /locales/en/translation.json → notifications.* */
const T = {
  title: 'Notifications',
  enablePush: 'Enable Push Notifications',
  dismiss: 'Dismiss',
  dismissAll: 'Dismiss All',
  deleteAll: 'Delete All',
  deleteTitle: 'Delete Notification',
  deleteConfirmation: 'Are you sure you want to delete this notification?',
  deletedMessage: 'Notification deleted successfully',
  deleteAllTitle: 'Delete all notifications?',
  deleteAllConfirmation:
    'Are you sure you want to permanently delete all notifications? This action cannot be undone.',
  deleteAllConfirmButton: 'Delete all',
  empty: NotificationsDrawer.EMPTY_TEXT,
  types: { system: 'System', workflow: 'Workflows', record: 'Records', default: 'Alert' } as Record<string, string>,
};

const RAW_HTML = /<\/?[a-z][a-z0-9]*(\s[^>]*)?>|&(lt|gt|amp|nbsp|quot|apos|#\d+|#x[0-9a-f]+);/i;

interface ApiNotification {
  id: string;
  type: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}
interface Mutation {
  method: string;
  url: string;
  body: string | null;
  status: number;
  mocked: boolean;
}

/**
 * Registra las peticiones que modifican notificaciones o suscripciones push.
 * Con `mock` (o siempre para push) no llegan al servidor: se responde 200 simulado.
 */
const TRACK_MUTATIONS = (mock: boolean) => `(() => {
  if (window.__notifTrack) return;
  window.__notifTrack = true;
  window.__mutations = [];
  const MOCK = ${mock};
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    this.__m = String(m).toUpperCase(); this.__u = String(u);
    return open.call(this, m, u, ...r);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const notif = /\\/api\\/v1\\/notifications/.test(this.__u) && this.__m !== 'GET';
    const push = /\\/push-subscriptions/.test(this.__u) && this.__m !== 'GET';
    if (!notif && !push) return send.call(this, body);
    const rec = { method: this.__m, url: this.__u.replace(location.origin, ''), body: body == null ? null : String(body), status: 0, mocked: push || MOCK };
    window.__mutations.push(rec);
    if (!rec.mocked) {
      this.addEventListener('loadend', () => { rec.status = this.status; });
      return send.call(this, body);
    }
    const payload = JSON.stringify({ error: false, status: 200, message: 'mocked by qa suite', data: {} });
    setTimeout(() => {
      const def = (k, v) => Object.defineProperty(this, k, { configurable: true, get: () => v });
      def('readyState', 4); def('status', 200); def('statusText', 'OK');
      def('responseURL', location.origin + rec.url);
      def('responseText', payload);
      def('response', this.responseType === 'json' ? JSON.parse(payload) : payload);
      this.getAllResponseHeaders = () => 'content-type: application/json\\r\\n';
      this.getResponseHeader = (h) => (/content-type/i.test(h) ? 'application/json' : null);
      rec.status = 200;
      for (const t of ['readystatechange', 'load', 'loadend']) this.dispatchEvent(new Event(t));
    }, 30);
  };
})();`;

/**
 * Simula la API Notification (ausente en Chrome headless) y PushManager.
 * `answer` es lo que "elige" el usuario en el prompt nativo.
 */
const PUSH_STUB = (answer: 'granted' | 'denied') => `(() => {
  window.__push = { asked: 0, swRegistered: [], subscribeOptions: null };
  class FakeNotification {
    static permission = 'default';
    static async requestPermission() {
      window.__push.asked++;
      FakeNotification.permission = '${answer}';
      return '${answer}';
    }
  }
  Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
  const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
  navigator.serviceWorker.register = (...a) => { window.__push.swRegistered.push(String(a[0])); return register(...a); };
  Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
    configurable: true,
    get() {
      return {
        getSubscription: async () => null,
        subscribe: async (opts) => {
          window.__push.subscribeOptions = { userVisibleOnly: opts.userVisibleOnly, keyBytes: opts.applicationServerKey?.byteLength ?? 0 };
          return { toJSON: () => ({ endpoint: 'https://push.invalid/qa-suite', expirationTime: null, keys: { p256dh: 'qa', auth: 'qa' } }) };
        },
      };
    },
  });
})();`;

let b: Browser;

beforeAll(async () => {
  b = await startBrowser();
});

afterAll(async () => {
  await b?.stop();
});

/** Página aislada, con sesión iniciada y en el dashboard de bienvenida. */
async function onDashboard(opts: { extraInit?: string; email?: string; password?: string } = {}): Promise<Page> {
  const { page } = await newIsolatedPage(b, TRACK_MUTATIONS(!DESTRUCTIVE) + (opts.extraInit ?? ''));
  await new LoginPage(page).login(opts.email, opts.password);
  await page.go(`${BASE_URL}/dashboard/welcome`);
  await waitUntil(page, `document.querySelector('${N.bell}') && localStorage.getItem('selectedDomain')`);
  // El sidebar se anima y desplaza la cabecera al cargar: esperar a que la campana deje de moverse.
  await new AppShell(page).waitForStableHeader();
  return page;
}

async function apiNotifications(page: Page, limit = 20): Promise<ApiNotification[]> {
  const r = await api<{ data: ApiNotification[] }>(page, 'GET', `/api/v1/notifications?page=1&limit=${limit}`);
  expect(r.status).toBe(200);
  return r.json.data;
}

async function unreadCount(page: Page): Promise<number> {
  const r = await api<{ data: { unreadCount: number } }>(page, 'GET', '/api/v1/notifications/unread-count');
  return r.json.data.unreadCount;
}

const mutations = (page: Page) => evalJson<Mutation[]>(page, 'window.__mutations ?? []');

async function waitForMutation(page: Page, method: string, url: RegExp): Promise<Mutation> {
  await waitUntil(page, `(window.__mutations ?? []).some(m => m.method === '${method}' && ${url}.test(m.url) && m.status > 0)`);
  return (await mutations(page)).find((m) => m.method === method && url.test(m.url))!;
}

// ────────────────────────────────────────────────────────────────────────────────
// Casos de solo lectura
// ────────────────────────────────────────────────────────────────────────────────

describe('Notifications', () => {
  describe('TC1186 – Icono de notificaciones visible', () => {
    let page: Page;

    beforeAll(async () => {
      page = await onDashboard();
    });

    it('tras el login se muestra la página de inicio', async () => {
      expect(await page.url()).toBe(`${BASE_URL}/dashboard/welcome`);
      expect(await page.evaluate<string>('document.body.innerText')).toMatch(/Welcome to DatAscend/);
    });

    it('la campana aparece en la cabecera, es accesible y clicable', async () => {
      const bell = await evalJson<{ inHeader: boolean; role: string | null; label: string | null; svg: boolean; visible: boolean; cursor: string }>(
        page,
        `(() => { const e = document.querySelector('${N.bell}'); const r = e.getBoundingClientRect();
          return { inHeader: !!e.closest('${SHELL_SEL.header}'), role: e.getAttribute('role'),
            label: e.getAttribute('aria-label'), svg: !!e.querySelector('svg'),
            visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.right <= innerWidth,
            cursor: getComputedStyle(e).cursor }; })()`,
      );
      expect(bell).toMatchObject({ inHeader: true, role: 'button', label: 'Notifications', svg: true, visible: true });

      await new NotificationsDrawer(page).clickBell();
    });
  });

  describe('TC1187 / TC1188 – Drawer: apertura, carga vía API y cierre', () => {
    let page: Page;
    let drawer: NotificationsDrawer;
    let before: LayoutState;
    let fromApi: ApiNotification[];

    beforeAll(async () => {
      page = await onDashboard();
      drawer = new NotificationsDrawer(page);
      before = await drawer.layoutState();
      fromApi = await apiNotifications(page);
      await drawer.open();
    });

    it('TC1187 – el drawer se abre con el título y los controles de acción', async () => {
      const close = await page.evaluate<string | null>(`document.querySelector('${N.close}')?.getAttribute('aria-label')`);
      expect(await drawer.title()).toBe(T.title);
      expect(close).toBe('Close');
      expect(await drawer.has('deleteAll')).toBe(fromApi.length > 0);
      expect(await drawer.has('dismissAll')).toBe(fromApi.some((n) => !n.readAt));

      const items = await drawer.items();
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.hasDelete)).toBe(true);
      expect(items.filter((i) => i.unread).every((i) => i.hasDismiss)).toBe(true);
    });

    it('TC1188 – los ítems coinciden con GET /api/v1/notifications (orden, texto, tipo y estado)', async () => {
      const items = await drawer.items();
      const firstPage = items.slice(0, fromApi.length);
      expect(firstPage.map((i) => i.id)).toEqual(fromApi.map((n) => n.id));
      for (const [i, n] of fromApi.entries()) {
        expect(firstPage[i].body, `body de ${n.id}`).toBe(n.body.trim());
        expect(firstPage[i].sender).toBe(T.types[n.type] ?? T.types.default);
        expect(firstPage[i].unread).toBe(n.readAt === null);
        expect(firstPage[i].date).toMatch(/\d{4} – \d{1,2}:\d{2}\s[AP]M/);
      }
    });

    it('TC1187 – se cierra con la X y la UI vuelve a su estado normal', async () => {
      await drawer.closeWithX();
      expect(await drawer.layoutState()).toEqual(before);
    });

    it('TC1187 – también se cierra al pulsar de nuevo la campana', async () => {
      await drawer.open();
      await drawer.closeWithBell();
      expect(await drawer.layoutState()).toEqual(before);
    });
  });

  describe('TC1191 – Scroll del drawer con muchas notificaciones', () => {
    let page: Page;
    let drawer: NotificationsDrawer;
    let total: number;

    beforeAll(async () => {
      page = await onDashboard();
      drawer = new NotificationsDrawer(page);
      total = (await apiNotifications(page, 100)).length;
      await drawer.open();
    });

    it('el drawer muestra el título "Notifications" y la X en la esquina superior derecha', async () => {
      const pos = await evalJson<{ drawer: number[]; close: number[] }>(
        page,
        `(() => { const d = document.querySelector('${N.drawer}').getBoundingClientRect();
          const c = document.querySelector('${N.close}').getBoundingClientRect();
          return { drawer: [d.top, d.right, d.width], close: [c.top, c.right] }; })()`,
      );
      expect(await drawer.title()).toBe(T.title);
      expect(pos.drawer[1] - pos.close[1]).toBeLessThan(40); // pegada al borde derecho
      expect(pos.close[0] - pos.drawer[0]).toBeLessThan(60); // en la franja superior
    });

    it('cada notificación muestra mensaje y fecha', async () => {
      const items = await drawer.items();
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.body.length > 0 && i.date.length > 0)).toBe(true);
    });

    it('el contenido supera la altura del drawer y permite hacer scroll (con carga de más páginas)', async (ctx) => {
      if (total <= 20) ctx.skip(); // precondición: más notificaciones de las que caben
      const box = await evalJson<{ scrollHeight: number; clientHeight: number; overflowY: string }>(
        page,
        `(() => { const b = document.querySelector('${N.body}');
          return { scrollHeight: b.scrollHeight, clientHeight: b.clientHeight, overflowY: getComputedStyle(b).overflowY }; })()`,
      );
      expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
      expect(['auto', 'scroll']).toContain(box.overflowY);

      const countBefore = await drawer.itemCount();
      await drawer.scrollToBottom();
      await drawer.waitForMoreItemsThan(countBefore);
      expect(await drawer.itemCount()).toBeGreaterThan(countBefore);
    });

    it('se cierra con la X sin dejar artefactos', async () => {
      await drawer.closeWithX();
      const state = await drawer.layoutState();
      expect(state).toMatchObject({ drawerOpen: false, backdrops: 0, bodyOverflow: '' });
    });
  });

  describe('TC1431 – Mensajes legibles, sin HTML crudo', () => {
    let page: Page;
    let drawer: NotificationsDrawer;

    beforeAll(async () => {
      page = await onDashboard();
      drawer = new NotificationsDrawer(page);
      await drawer.open();
    });

    it('ninguna notificación visible muestra etiquetas HTML ni entidades codificadas', async () => {
      const items = await drawer.items();
      expect(items.length).toBeGreaterThan(0);
      expect(items.filter((i) => RAW_HTML.test(i.body)).map((i) => i.body)).toEqual([]);
    });

    it('los mensajes largos se truncan con elipsis y el texto completo está en el tooltip', async () => {
      const bodies = await evalJson<{ text: string; title: string | null; ellipsis: boolean }[]>(
        page,
        `[...document.querySelectorAll('${N.itemBody}')].map(p => {
          const s = getComputedStyle(p);
          return { text: p.innerText.trim(), title: p.getAttribute('title'),
            ellipsis: s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none' };
        })`,
      );
      expect(bodies.every((x) => x.ellipsis)).toBe(true);
      expect(bodies.every((x) => (x.title ?? '').trim() === x.text)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Notificaciones push (API Notification simulada: no existe en Chrome headless)
  // ────────────────────────────────────────────────────────────────────────────────

  describe('TC1494 – Solicitud de permiso nativo de notificaciones', () => {
    it('con permiso sin decidir, el drawer ofrece "Enable Push Notifications" y pide permiso al navegador', async () => {
      const page = await onDashboard({ extraInit: PUSH_STUB('denied') });
      const drawer = new NotificationsDrawer(page);
      expect(await page.evaluate<number>('window.__push.asked')).toBe(0); // no se pide al cargar ni al hacer login
      await drawer.open();
      expect(await page.evaluate<number>('window.__push.asked')).toBe(0); // tampoco al abrir el drawer

      expect(await drawer.enablePushTooltip()).toBe(T.enablePush);
      await drawer.enablePush();
      await waitUntil(page, 'window.__push.asked === 1');

      // Al denegar, la app no registra el Service Worker ni crea suscripción.
      await page.wait(1500);
      expect(await page.evaluate<number>('window.__push.swRegistered.length')).toBe(0);
      expect((await mutations(page)).filter((m) => /push-subscriptions/.test(m.url))).toEqual([]);
    });

    // El diálogo nativo (Allow/Block) pertenece al navegador y no es automatizable con WebDriver BiDi.
    it.todo('el navegador muestra el prompt nativo con las opciones Permitir / Bloquear (verificación manual)');
  });

  describe('TC1495 – Activar notificaciones push', () => {
    let page: Page;

    beforeAll(async () => {
      page = await onDashboard({ extraInit: PUSH_STUB('granted') });
      const drawer = new NotificationsDrawer(page);
      await drawer.open();
      await drawer.enablePush();
      await waitUntil(page, 'window.__push.asked === 1');
    });

    it('al permitir, la app obtiene la clave VAPID y registra el Service Worker /sw.js', async () => {
      await waitUntil(page, `window.__push.swRegistered.includes('/sw.js')`);
      // El registro real del SW termina después de la llamada interceptada: reintentar hasta 10s.
      const swUrl = `${BASE_URL}/sw.js`;
      const reg = await pollEvaluate<string>(
        page,
        `navigator.serviceWorker.getRegistration().then(r => (r?.active || r?.installing || r?.waiting)?.scriptURL ?? '')`,
        (url) => url === swUrl,
        10_000,
      );
      expect(reg).toBe(swUrl);
      expect((await api(page, 'GET', '/api/v1/users/push-subscriptions/vapid-public-key')).status).toBe(200);
    });

    it('se suscribe a PushManager con la clave VAPID y envía la suscripción al backend', async () => {
      await waitUntil(page, 'window.__push.subscribeOptions');
      expect(await evalJson(page, 'window.__push.subscribeOptions')).toEqual({ userVisibleOnly: true, keyBytes: 65 });

      const sub = await waitForMutation(page, 'POST', /push-subscriptions/);
      expect(sub.mocked).toBe(true); // nunca se guarda una suscripción falsa en el servidor
      expect(JSON.parse(sub.body ?? '{}')).toMatchObject({ endpoint: 'https://push.invalid/qa-suite', keys: { p256dh: 'qa', auth: 'qa' } });
    });

    // Requiere un servicio push real (no disponible en headless) y un evento de backend.
    it.todo('una notificación nueva llega como notificación push del sistema operativo');
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Acciones que modifican notificaciones (interceptadas salvo NOTIFICATIONS_DESTRUCTIVE=true)
  // ────────────────────────────────────────────────────────────────────────────────

  describe(`Acciones sobre notificaciones (${DESTRUCTIVE ? 'backend REAL' : 'peticiones interceptadas'})`, () => {
    describe('TC1189 – Marcar una notificación como leída (Dismiss)', () => {
      it('Dismiss envía PUT /notifications/{id}/read y el ítem pasa de no leído a leído', async (ctx) => {
        const page = await onDashboard();
        const drawer = new NotificationsDrawer(page);
        await drawer.open();
        const target = (await drawer.items()).find((i) => i.unread);
        if (!target) ctx.skip(); // precondición: al menos una notificación no leída
        const { id } = target!;
        const style = () =>
          evalJson<{ cls: string; bg: string; weight: string }>(
            page,
            `(() => { const e = document.querySelector('${N.itemOf(id)}'); const s = getComputedStyle(e);
              const b = getComputedStyle(e.querySelector('.notification-body'));
              return { cls: e.className, bg: s.backgroundColor, weight: b.fontWeight + '|' + b.color }; })()`,
          );
        const before = await style();

        await drawer.dismiss(id);
        const req = await waitForMutation(page, 'PUT', new RegExp(`/api/v1/notifications/${id}/read$`));
        expect(req.status).toBe(200);
        await drawer.waitForRead(id);

        const after = await style();
        expect(after.cls).not.toContain('unread');
        expect(after.bg + after.weight).not.toBe(before.bg + before.weight); // el estilo cambia
        expect(await drawer.hasDismissButton(id)).toBe(false);

        if (DESTRUCTIVE) {
          const n = (await apiNotifications(page, 100)).find((x) => x.id === id);
          expect(n?.readAt).not.toBeNull();
        }

        await drawer.closeWithX();
        expect(await drawer.layoutState()).toMatchObject({ drawerOpen: false, backdrops: 0 });
      });
    });

    describe('TC1190 – Eliminar una notificación', () => {
      it('la papelera pide confirmación, envía DELETE y muestra "Notification deleted successfully"', async () => {
        const page = await onDashboard();
        const drawer = new NotificationsDrawer(page);
        await drawer.open();
        const [target] = await drawer.items();
        expect(target, 'precondición: al menos una notificación').toBeDefined();

        const modal = await drawer.delete(target.id);
        expect(await modal.title()).toBe(T.deleteTitle);
        expect(await modal.body()).toBe(T.deleteConfirmation);

        await modal.confirm();
        const req = await waitForMutation(page, 'DELETE', new RegExp(`/api/v1/notifications/${target.id}$`));
        expect(req.status).toBe(200);
        await drawer.waitForItemGone(target.id);
        await waitUntil(page, `document.querySelector('${SHELL_SEL.toast}')`);
        expect((await new AppShell(page).visibleToasts()).join(' ')).toContain(T.deletedMessage);

        if (DESTRUCTIVE) {
          expect((await apiNotifications(page, 100)).map((n) => n.id)).not.toContain(target.id);
        }

        await drawer.closeWithX();
        expect(await drawer.layoutState()).toMatchObject({ drawerOpen: false, backdrops: 0 });
      });
    });

    describe('TC1192 – Dismiss All', () => {
      it('"Dismiss All" envía PUT /notifications/read-all y todas pasan a leídas', async (ctx) => {
        const page = await onDashboard();
        const drawer = new NotificationsDrawer(page);
        await drawer.open();
        if (!(await drawer.items()).some((i) => i.unread)) ctx.skip(); // precondición: hay no leídas
        expect(await drawer.dismissAllText()).toBe(T.dismissAll);
        expect(await drawer.has('headerBadge')).toBe(true);

        await drawer.dismissAll();
        const req = await waitForMutation(page, 'PUT', /\/api\/v1\/notifications\/read-all$/);
        expect(req.status).toBe(200);
        await waitUntil(page, `!document.querySelector('${N.item}.unread')`);

        const items = await drawer.items();
        expect(items.every((i) => !i.unread && !i.hasDismiss)).toBe(true);
        // Sin no leídas: desaparece el botón "Dismiss All" y el contador.
        await waitUntil(page, `!document.querySelector('${N.dismissAll}')`);
        expect(await drawer.has('drawerBadge')).toBe(false);

        if (DESTRUCTIVE) expect(await unreadCount(page)).toBe(0);

        // Cierre con la campana (alternativa a la X indicada en el caso).
        await drawer.closeWithBell();
        expect(await drawer.layoutState()).toMatchObject({ drawerOpen: false, backdrops: 0 });
      });
    });

    describe('TC1365 – Delete All (borrado masivo)', () => {
      let page: Page;
      let drawer: NotificationsDrawer;

      beforeAll(async () => {
        page = await onDashboard();
        drawer = new NotificationsDrawer(page);
        await drawer.open();
      });

      it('"Delete All" está junto a "Dismiss All", con estilo de peligro y las mismas proporciones', async (ctx) => {
        if (!(await drawer.has('dismissAll'))) ctx.skip();
        const g = await evalJson<{ dismiss: number[]; del: number[]; danger: boolean; text: string }>(
          page,
          `(() => { const r = (s) => { const x = document.querySelector(s).getBoundingClientRect(); return [x.left, x.right, x.top, x.height].map(Math.round); };
            const d = document.querySelector('${N.deleteAll}');
            return { dismiss: r('${N.dismissAll}'), del: r('${N.deleteAll}'), danger: d.classList.contains('btn-danger'), text: d.innerText.trim() }; })()`,
        );
        expect(g.text).toBe(T.deleteAll);
        expect(g.danger).toBe(true);
        expect(g.del[3]).toBe(g.dismiss[3]); // misma altura
        expect(g.del[2]).toBe(g.dismiss[2]); // misma fila
        expect(g.del[0] - g.dismiss[1]).toBeGreaterThanOrEqual(0); // a la derecha de "Dismiss All"
        expect(g.del[0] - g.dismiss[1]).toBeLessThan(24); // adyacente
      });

      it('muestra el modal de confirmación y "Cancel" no borra nada', async () => {
        const countBefore = await drawer.itemCount();
        expect(countBefore).toBeGreaterThan(0);
        const modal = await drawer.deleteAll();
        expect(await modal.title()).toBe(T.deleteAllTitle);
        expect(await modal.body()).toBe(T.deleteAllConfirmation);

        await modal.cancel();
        expect((await mutations(page)).filter((m) => m.method === 'DELETE')).toEqual([]);
        expect(await drawer.itemCount()).toBe(countBefore);
      });

      it('al confirmar, envía DELETE /notifications y el drawer queda vacío', async () => {
        const modal = await drawer.deleteAll();
        expect(await modal.buttonText('danger')).toBe(T.deleteAllConfirmButton);
        await modal.confirm();

        const req = await waitForMutation(page, 'DELETE', /\/api\/v1\/notifications$/);
        expect(req.status).toBe(200);
        await waitUntil(page, `!document.querySelector('${N.item}')`);
        expect(await drawer.bodyText()).toBe(T.empty);
        expect(await drawer.has('deleteAll')).toBe(false);
      });

      it('el contador de la campana desaparece', async () => {
        await drawer.waitForHeaderBadgeCleared();
      });

      // Defecto/diferencia con el caso: el estado vacío es solo el texto "No notifications", sin ilustración.
      it.fails('[defecto conocido] el estado vacío muestra una ilustración', async () => {
        expect(await page.evaluate<boolean>(`!!document.querySelector('${N.body}').querySelector('img, svg')`)).toBe(true);
      });

      it.runIf(DESTRUCTIVE)('tras recargar, el drawer sigue vacío (borrado permanente)', async () => {
        await page.reload();
        await drawer.waitForBell();
        await drawer.open();
        expect(await drawer.bodyText()).toBe(T.empty);
        expect(await apiNotifications(page)).toEqual([]);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────
  // Flujos con dos usuarios (requieren DATASCEND_USER_B_EMAIL / _PASSWORD)
  // ────────────────────────────────────────────────────────────────────────────────

  describe.skipIf(!USER_B.email || !USER_B.password)('Flujos con dos usuarios (User A / User B)', () => {
    const created: { entity: string; id: string }[] = [];

    afterAll(async () => {
      // Limpieza: elimina los registros que User B no haya borrado.
      if (!created.length) return;
      const page = await onDashboard();
      for (const r of created) await api(page, 'DELETE', `/api/v1/entities/${r.entity}/${r.id}`);
    });

    async function createRecord(page: Page, entity: string, data: Record<string, unknown>): Promise<string> {
      const r = await api<{ data: { id: string }[] }>(page, 'POST', `/api/v1/entities/${entity}`, data);
      expect(r.status).toBe(201);
      const id = r.json.data[0].id;
      created.push({ entity, id });
      return id;
    }

    async function userDisplayName(page: Page): Promise<string> {
      const r = await api<Record<string, unknown>>(page, 'GET', '/api/v1/users/profile');
      const flat = JSON.stringify(r.json);
      const first = flat.match(/"first_?[nN]ame":"([^"]*)"/)?.[1] ?? '';
      const last = flat.match(/"last_?[nN]ame":"([^"]*)"/)?.[1] ?? '';
      return `${first} ${last}`.trim();
    }

    /** Espera (vía API) la notificación cuyo cuerpo contiene `marker`, creada después de `since`. */
    async function waitForNotification(page: Page, marker: string, since: number): Promise<ApiNotification> {
      const end = Date.now() + 60_000;
      for (;;) {
        const hit = (await apiNotifications(page, 50)).find(
          (n) => n.body.includes(marker) && Date.parse(n.createdAt) >= since - 5_000,
        );
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`No llegó la notificación con "${marker}"`);
        await page.wait(2000);
      }
    }

    it('TC1353 – la notificación muestra entidad, valor "List As" del registro y el usuario que actuó', async () => {
      const since = Date.now();
      const listAs = `qa-notif-${since}`;

      const pageA = await onDashboard();
      const id = await createRecord(pageA, NOTIF_ENTITY_ID, { [NOTIF_ENTITY_LIST_AS]: listAs });
      const entityLabel = (await api<{ data: { objectLabel: string } }>(pageA, 'GET', `/api/v1/entities/${NOTIF_ENTITY_ID}`)).json
        .data.objectLabel;

      const pageB = await onDashboard({ email: USER_B.email, password: USER_B.password });
      expect((await api(pageB, 'GET', `/api/v1/entities/${NOTIF_ENTITY_ID}/${id}`)).status).toBe(200);
      const userB = await userDisplayName(pageB);
      expect((await api(pageB, 'DELETE', `/api/v1/entities/${NOTIF_ENTITY_ID}/${id}`)).status).toBe(200);
      created.splice(created.findIndex((r) => r.id === id), 1);

      const pageA2 = await onDashboard();
      const n = await waitForNotification(pageA2, listAs, since);
      const drawerA = new NotificationsDrawer(pageA2);
      await drawerA.open();
      const body = await drawerA.itemBody(n.id);
      expect(body).toContain(entityLabel);
      expect(body).toContain(listAs);
      expect(body).toContain(userB);
      expect(body).not.toMatch(RAW_HTML);
    });

    it('TC1431 – un cambio en texto enriquecido hecho por User B no muestra HTML crudo a User A', async () => {
      const since = Date.now();
      const marker = `qa-rich-${since}`;

      const pageA = await onDashboard();
      const id = await createRecord(pageA, RICH_ENTITY_ID, { title: marker, number: since % 100000 });

      const pageB = await onDashboard({ email: USER_B.email, password: USER_B.password });
      const html = `<p><strong>${marker}</strong> &amp; detalle con&nbsp;formato <em>enriquecido</em> ${'texto largo '.repeat(20)}</p>`;
      const patch = await api(
        pageB,
        'PATCH',
        `/api/v1/entities/${RICH_ENTITY_ID}?filter%5Bid%5D=${id}&version=active`,
        { [RICH_FIELD]: html },
      );
      expect(patch.status).toBeLessThan(300);

      const pageA2 = await onDashboard();
      const n = await waitForNotification(pageA2, marker, since);
      await new NotificationsDrawer(pageA2).open();
      const p = await evalJson<{ text: string; title: string | null; overflow: boolean }>(
        pageA2,
        `(() => { const e = document.querySelector('${N.itemOf(n.id)} .notification-body');
          return { text: e.innerText.trim(), title: e.getAttribute('title'), overflow: e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight }; })()`,
      );
      expect(p.text).not.toMatch(RAW_HTML);
      expect(p.title ?? '').not.toMatch(RAW_HTML);
      if (p.overflow) expect((p.title ?? '').length).toBeGreaterThan(0); // texto completo en el tooltip
    });
  });
});
