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
  applyPreferences,
  evalJson,
  newIsolatedPage,
  startBrowser,
  waitUntil,
  type Browser,
  type Page,
} from '../support/datascend';
import { AppShell, SHELL_SEL } from '../support/pages/AppShell';
import { LOGIN_SEL, LoginPage } from '../support/pages/LoginPage';

const LOGIN_URL = LoginPage.URL;
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
  await new LoginPage(page).login();
  await page.go(`${BASE_URL}/dashboard/welcome`);
  await new AppShell(page).waitForHeader();
  return page;
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

describe('Dashboard › Logout', () => {
  describe('TC1424 – Happy Path: flujo de cierre de sesión', () => {
    let page: Page;
    let shell: AppShell;
    let tokenBeforeLogout: string;

    beforeAll(async () => {
      page = await onWelcomeDashboard();
      shell = new AppShell(page);
      // Se conserva solo en memoria para comprobar que el backend lo invalida.
      tokenBeforeLogout = await page.evaluate<string>(`localStorage.getItem('token')`);
      expect(tokenBeforeLogout).toBeTruthy();
    });

    it('el menú de usuario (arriba a la derecha) muestra Profile, Settings, Change Password y Logout', async () => {
      const items = await shell.userMenuItems();
      expect(items.map((i) => i.text)).toEqual(['Profile', 'Settings', 'Change Password', 'Logout']);
      expect(items.every((i) => i.clickable)).toBe(true);

      // El menú se despliega debajo del elemento de perfil.
      const pos = await evalJson<{ triggerBottom: number; menuTop: number }>(
        page,
        `{ triggerBottom: document.querySelector('${SHELL_SEL.userMenuTrigger}').getBoundingClientRect().bottom,
           menuTop: document.querySelector('${SHELL_SEL.userMenu}').getBoundingClientRect().top }`,
      );
      expect(pos.menuTop).toBeGreaterThanOrEqual(pos.triggerBottom - 2);

      await shell.closeUserMenu();
    });

    it('Logout envía la petición al backend y redirige exactamente a la página de login', async () => {
      await page.evaluate(TRACK_XHR);
      await shell.logout();

      const reqs = await evalJson<{ method: string; url: string; status: number }[]>(page, 'window.__reqs ?? []');
      const logoutReq = reqs.find((r) => r.method === 'POST' && r.url.includes('/users/logout'));
      expect(logoutReq, 'POST /api/v1/users/logout').toBeDefined();
      expect(logoutReq!.status).toBeGreaterThanOrEqual(200);
      expect(logoutReq!.status).toBeLessThan(300);

      expect(await page.url()).toBe(LOGIN_URL);
      expect(await page.find(LOGIN_SEL.email).isVisible()).toBe(true);
      expect(await page.find(LOGIN_SEL.password).isVisible()).toBe(true);
      // La cuenta de QA está en inglés; el texto en español se valida en el caso siguiente.
      expect(await new LoginPage(page).submitText()).toMatch(/^(Sign In|Iniciar Sesión)$/i);
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
      await new LoginPage(page).login();
      await applyPreferences(page, BASELINE);
    });

    it('tras el logout se muestra el formulario "Iniciar Sesión"', async () => {
      const page = await onWelcomeDashboard();
      const shell = new AppShell(page);
      await shell.switchLanguage('es', { until: `document.body.innerText.includes('Usuarios')` });

      expect(await shell.logoutText()).toMatch(/Cerrar Sesión|Logout/i);
      await shell.closeUserMenu();

      await shell.logout();
      expect(await page.url()).toBe(LOGIN_URL);
      expect(await new LoginPage(page).submitText()).toMatch(/^Iniciar Sesión$/i);
    });
  });
});
