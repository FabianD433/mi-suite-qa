/**
 * DatAscend (qa2) – Dashboard › Logout
 * Casos de origen: tests/dashboard/TestCases_06-11-26-15_36_48.csv (módulo "Dashboard": TC1424).
 *
 * El caso usa app.datascend.net como ejemplo; aquí se ejecuta contra BASE_URL (qa2 por defecto).
 * El caso en español cambia el idioma de la sesión; su `afterAll` restaura BASELINE.
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

const USER_MENU = {
  trigger: '[data-testid="layout.main.header"] a.nav-link.search-toggle.py-0',
  menu: '.dropdown-menu.show',
  logout: '.dropdown-menu.show a.dropdown-item[role="button"]',
} as const;

const LOGIN_URL = `${BASE_URL}/auth/login`;
const PROTECTED_PATHS = ['/dashboard', '/dashboard/welcome', '/profile'];

let b: Browser;

beforeAll(async () => {
  b = await startBrowser();
});

afterAll(async () => {
  await b?.stop();
});

/** Página con sesión iniciada, situada en el dashboard de bienvenida. */
async function onWelcomeDashboard(initScript?: string): Promise<Page> {
  const { page } = await newIsolatedPage(b, initScript);
  await login(page);
  await page.go(`${BASE_URL}/dashboard/welcome`);
  await waitUntil(page, `document.querySelector('${USER_MENU.trigger}')`);
  return page;
}

async function openUserMenu(page: Page): Promise<void> {
  await page.find(USER_MENU.trigger).click();
  await waitUntil(page, `document.querySelector('${USER_MENU.menu}')`);
}

/** Registra las peticiones XHR (método, URL y status) para comprobar la llamada de logout. */
const TRACK_XHR = `(() => {
  window.__reqs = [];
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    const e = { method: m, url: String(u), status: 0 };
    window.__reqs.push(e);
    this.addEventListener('loadend', () => { e.status = this.status; });
    return open.call(this, m, u, ...r);
  };
})()`;

async function clickLogout(page: Page): Promise<void> {
  await openUserMenu(page);
  await page.find(USER_MENU.logout).click();
  await waitUntil(page, `location.pathname === '/auth/login' && document.querySelector('${SEL.submit}')`, 15_000);
  // Esperar a que i18n resuelva las claves (antes muestra "login.sign-in").
  await waitUntil(page, `!/^login\\./.test(document.querySelector('${SEL.submit}').innerText)`);
}

describe('Dashboard › Logout', () => {
  describe('TC1424 – Happy Path: flujo de cierre de sesión', () => {
    let page: Page;
    let tokenBeforeLogout: string;

    beforeAll(async () => {
      page = await onWelcomeDashboard();
      // Se conserva solo en memoria para comprobar que el backend lo invalida.
      tokenBeforeLogout = await page.evaluate<string>(`localStorage.getItem('token')`);
      expect(tokenBeforeLogout).toBeTruthy();
    });

    it('el menú de usuario (arriba a la derecha) muestra Profile, Settings, Change Password y Logout', async () => {
      await openUserMenu(page);
      const items = await evalJson<{ text: string; clickable: boolean }[]>(
        page,
        `[...document.querySelectorAll('${USER_MENU.menu} .dropdown-item')].map(e => ({
          text: e.innerText.trim(),
          clickable: e.tagName === 'A' || e.getAttribute('role') === 'button',
        }))`,
      );
      expect(items.map((i) => i.text)).toEqual(['Profile', 'Settings', 'Change Password', 'Logout']);
      expect(items.every((i) => i.clickable)).toBe(true);

      // El menú se despliega debajo del elemento de perfil.
      const pos = await evalJson<{ triggerBottom: number; menuTop: number }>(
        page,
        `{ triggerBottom: document.querySelector('${USER_MENU.trigger}').getBoundingClientRect().bottom,
           menuTop: document.querySelector('${USER_MENU.menu}').getBoundingClientRect().top }`,
      );
      expect(pos.menuTop).toBeGreaterThanOrEqual(pos.triggerBottom - 2);

      await page.keyboard.press('Escape');
      await waitUntil(page, `!document.querySelector('${USER_MENU.menu}')`);
    });

    it('Logout envía la petición al backend y redirige exactamente a la página de login', async () => {
      await page.evaluate(TRACK_XHR);
      await clickLogout(page);

      const reqs = await evalJson<{ method: string; url: string; status: number }[]>(page, 'window.__reqs ?? []');
      const logoutReq = reqs.find((r) => r.method === 'POST' && r.url.includes('/users/logout'));
      expect(logoutReq, 'POST /api/v1/users/logout').toBeDefined();
      expect(logoutReq!.status).toBeGreaterThanOrEqual(200);
      expect(logoutReq!.status).toBeLessThan(300);

      expect(await page.url()).toBe(LOGIN_URL);
      expect(await page.find(SEL.email).isVisible()).toBe(true);
      expect(await page.find(SEL.password).isVisible()).toBe(true);
      // La cuenta de QA está en inglés; el texto en español se valida en el caso siguiente.
      expect(await page.find(SEL.submit).text()).toMatch(/^(Sign In|Iniciar Sesión)$/i);
    });

    it('elimina token y refreshToken del almacenamiento del navegador', async () => {
      const keys = await evalJson<string[]>(page, 'Object.keys(localStorage)');
      expect(keys).not.toContain('token');
      expect(keys).not.toContain('refreshToken');
    });

    it('el backend invalida el token anterior (401)', async () => {
      const status = await page.evaluate<number>(
        `fetch('/api/v1/users/profile', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(tokenBeforeLogout)} } }).then(r => r.status)`,
      );
      expect(status).toBe(401);
    });

    it.each(PROTECTED_PATHS)('acceder directamente a %s redirige al login', async (path) => {
      await page.go(`${BASE_URL}${path}`);
      await waitUntil(page, `location.pathname === '/auth/login'`, 10_000);
      expect(await page.url()).toBe(LOGIN_URL);
    });

    it('el botón "Atrás" del navegador no devuelve al dashboard', async () => {
      await page.back();
      await page.wait(1500);
      expect(await page.url()).toBe(LOGIN_URL);
    });
  });

  describe('TC1424 – sesión en español', () => {
    // El login tras el logout conserva el idioma de la sesión que se cerró (no el del navegador),
    // así que para validar el literal "Iniciar Sesión" la sesión debe estar en español.
    afterAll(async () => {
      const { page } = await newIsolatedPage(b);
      await login(page);
      await applyPreferences(page, BASELINE);
    });

    it('tras el logout se muestra el formulario "Iniciar Sesión"', async () => {
      const page = await onWelcomeDashboard();
      await page.find('a.search-toggle.nav-link:has(img)').click();
      await page.find('[id="public-docs.lang-es"]').click();
      await waitUntil(page, `document.body.innerText.includes('Usuarios')`);

      await openUserMenu(page);
      expect(await page.find(USER_MENU.logout).text()).toMatch(/Cerrar Sesión|Logout/i);
      await page.keyboard.press('Escape');

      await clickLogout(page);
      expect(await page.url()).toBe(LOGIN_URL);
      expect(await page.find(SEL.submit).text()).toMatch(/^Iniciar Sesión$/i);
    });
  });
});
