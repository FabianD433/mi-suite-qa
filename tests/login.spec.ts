/**
 * DatAscend (qa2) – Login + Settings › Profile Preferences
 * Casos de origen: TestCases_05-11-26-22_17_57.csv (TC1580–TC1586).
 *
 * Los casos modifican las preferencias de la cuenta de QA: se ejecutan en serie
 * y `afterAll` restaura BASELINE (English, America/Costa_Rica, dark mode off).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASELINE,
  BASE_URL,
  REPORT_ENTITY_PATH,
  SEL,
  SPANISH_DARK_OS_INIT,
  applyPreferences,
  evalJson,
  findLightPanels,
  login,
  newIsolatedPage,
  openProfile,
  readServerPreferences,
  readUiPreferences,
  saveProfile,
  searchTimeZones,
  selectTimeZone,
  setDarkMode,
  startBrowser,
  waitUntil,
  type Browser,
  type Page,
} from './support/datascend';

let b: Browser;

beforeAll(async () => {
  b = await startBrowser();
});

afterAll(async () => {
  if (!b) return;
  try {
    const { page } = await newIsolatedPage(b);
    await login(page);
    await applyPreferences(page, BASELINE);
  } finally {
    await b.stop();
  }
});

/** Página nueva, aislada y con sesión iniciada. */
async function loggedInPage(): Promise<Page> {
  const { page } = await newIsolatedPage(b);
  await login(page);
  return page;
}

describe('Login', () => {
  it('inicia sesión con credenciales válidas y redirige al dashboard', async () => {
    const { page } = await newIsolatedPage(b);
    await login(page);
    expect(await page.url()).toContain('/dashboard');
    expect(await page.evaluate<boolean>(`!!localStorage.getItem('token')`)).toBe(true);
  });

  it('rechaza un usuario inexistente y permanece en /auth/login', async () => {
    const { page } = await newIsolatedPage(b);
    await waitUntil(page, `document.querySelector('${SEL.email}')`);
    await page.evaluate(`(() => {
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (...a) {
        this.addEventListener('load', () => { if (this.responseURL.includes('/users/login')) window.__loginStatus = this.status; });
        return send.apply(this, a);
      };
    })()`);
    // Usuario inexistente a propósito: no suma intentos fallidos a la cuenta real.
    await page.find(SEL.email).fill(`no-existe-${Date.now()}@example.com`);
    await page.find(SEL.password).fill('Incorrecta123!');
    await page.find(SEL.submit).click();
    await waitUntil(page, 'window.__loginStatus');
    const status = await page.evaluate<number>('window.__loginStatus');

    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(await page.url()).toContain('/auth/login');
    expect(await page.evaluate<string | null>(`localStorage.getItem('token')`)).toBeFalsy();
  });

  it('usuario inexistente y contraseña incorrecta devuelven la misma respuesta (sin enumeración de usuarios)', async () => {
    // Hallazgo: qa2 responde 404 para un email inexistente y 401 "login.mismatch" para contraseña
    // incorrecta, lo que permite saber qué emails están registrados. Se compara solo por API y
    // con un email inexistente para no sumar intentos fallidos a la cuenta real.
    const { page } = await newIsolatedPage(b);
    const status = await page.evaluate<number>(`fetch('/api/v1/users/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'no-existe-${Date.now()}@example.com', password: 'Incorrecta123!' }),
    }).then(r => r.status)`);
    expect(status).toBe(401);
  });
});

describe('Settings › Profile Preferences', () => {
  describe('TC1580 – Inicialización de UI y valores por defecto', () => {
    it('antes del login, la app sigue el idioma del navegador (es) y el tema del SO (dark)', async () => {
      const { page } = await newIsolatedPage(b, SPANISH_DARK_OS_INIT);
      await page.clock.setTimezone('America/Costa_Rica');
      await page.go(`${BASE_URL}/auth/login`);
      // Esperar a que i18n resuelva las claves (antes muestra "login.sign-in").
      await waitUntil(page, `!/^login\\./.test(document.querySelector('${SEL.submit}')?.innerText ?? 'login.')`);
      await waitUntil(page, `document.documentElement.dataset.bsTheme === 'dark'`);

      expect(await page.find(SEL.submit).text()).toMatch(/Iniciar Sesión/i);
      expect(await page.evaluate<string>('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe('America/Costa_Rica');
    });

    // Requiere una cuenta SIN preferencias guardadas (DATASCEND_NEW_USER_EMAIL / _PASSWORD).
    it.skipIf(!process.env.DATASCEND_NEW_USER_EMAIL)(
      'usuario nuevo: Español, America/Costa_Rica (UTC-06:00) y Dark mode activado por defecto',
      async () => {
        const { page } = await newIsolatedPage(b, SPANISH_DARK_OS_INIT);
        await page.clock.setTimezone('America/Costa_Rica');
        await login(page, process.env.DATASCEND_NEW_USER_EMAIL, process.env.DATASCEND_NEW_USER_PASSWORD);
        await openProfile(page);

        expect(await readUiPreferences(page)).toMatchObject({
          language: 'es',
          timeZone: 'America/Costa_Rica',
          darkMode: true,
        });
      },
    );
  });

  describe('TC1581 – Persistencia en servidor y sincronización entre dispositivos', () => {
    const target = { language: 'en', timeZone: 'Europe/London', darkMode: true } as const;

    it('guarda English, Europe/London y Dark Mode con toast de confirmación', async () => {
      const page = await loggedInPage();
      await openProfile(page);
      await page.find(SEL.language).selectOption(target.language);
      await selectTimeZone(page, target.timeZone);
      await setDarkMode(page, target.darkMode);

      const toasts = await saveProfile(page);
      expect(toasts.join(' ')).toMatch(/successfully updated/i);
      expect(await readServerPreferences(page)).toMatchObject(target);
    });

    it('persisten tras borrar cookies y localStorage y volver a iniciar sesión', async () => {
      const { ctx, page } = await newIsolatedPage(b);
      await login(page);
      await ctx.clearCookies();
      await page.evaluate('localStorage.clear(); sessionStorage.clear()');
      await page.reload();
      await login(page);
      await openProfile(page);

      expect(await readUiPreferences(page)).toMatchObject({ ...target, theme: 'dark' });
    });

    it('persisten en otro navegador/sesión limpia (equivalente a incógnito)', async () => {
      const { page } = await newIsolatedPage(b);
      expect(await page.evaluate<string | null>(`localStorage.getItem('token')`)).toBeNull();
      await login(page);
      expect(await page.evaluate<string>('document.documentElement.dataset.bsTheme')).toBe('dark');
      await openProfile(page);

      expect(await readUiPreferences(page)).toMatchObject({ ...target, theme: 'dark' });
    });
  });

  describe('TC1582 – Cambio de idioma aplicado en toda la app sin recargar', () => {
    let page: Page;

    beforeAll(async () => {
      page = await loggedInPage();
      await applyPreferences(page, { ...BASELINE });
      await openProfile(page);
      await page.evaluate(`window.__noReload = true`);
      await page.find(SEL.language).selectOption('es');
    });

    it('el toast de confirmación aparece en español, sin recargar la página', async () => {
      const toasts = await saveProfile(page);
      expect(toasts.join(' ')).toMatch(/El perfil se ha actualizado correctamente/i);
      expect(await page.evaluate<boolean>('window.__noReload === true')).toBe(true);
      expect(
        await evalJson<string[]>(page, `[...document.querySelectorAll('h4.card-title')].map(h => h.innerText)`),
      ).toEqual(expect.arrayContaining(['Notificaciones', 'Información General', 'Preferencias']));
    });

    it('menú de usuario, módulos y tabla de reportes se muestran en español', async () => {
      await page.go(`${BASE_URL}/dashboard/welcome`);
      await waitUntil(page, `document.body.innerText.includes('Usuarios')`);
      const buttons = await evalJson<string[]>(page, `[...document.querySelectorAll('button')].map(b => b.innerText.trim())`);
      expect(buttons).toEqual(expect.arrayContaining(['Usuarios', 'Dominios', 'Categorías', 'Reportes']));

      await page.go(`${BASE_URL}${REPORT_ENTITY_PATH}`);
      await waitUntil(page, `document.querySelector('${SEL.filterToggle}')`);
      expect(await page.find(SEL.filterToggle).attr('title')).toBe('Filtros');
      expect(await page.evaluate<string>('document.body.innerText')).toMatch(/Mostrar Columnas|Filtros Guardados/);
    });

    it('no quedan etiquetas accesibles (aria-label) en inglés en la cabecera ni en el paginador', async () => {
      // Defecto encontrado en la ejecución manual: "Switch to light/dark mode", "First Page",
      // "Previous Page", "Next Page", "Last Page" siguen en inglés con el idioma en Español.
      const english = await evalJson<string[]>(
        page,
        `[...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label'))
          .filter(l => /^(Switch to (light|dark) mode|First Page|Previous Page|Next Page|Last Page)$/.test(l))`,
      );
      expect(english).toEqual([]);
    });

    afterAll(async () => {
      await applyPreferences(page, BASELINE);
    });
  });

  describe('TC1583 – Zona horaria: display del SO vs lógica programada del backend', () => {
    const TIMESTAMP = /[A-Z][a-z]+, [A-Z][a-z]+ \d{1,2}, \d{4} – \d{1,2}:\d{2} [AP]M [A-Z]+/g;

    async function notificationTimestamps(page: Page): Promise<string[]> {
      await page.go(`${BASE_URL}/dashboard/welcome`);
      await waitUntil(page, `[...document.querySelectorAll('div')].some(d => d.innerText?.trim() === 'Notifications')`);
      await page.find({ text: 'Notifications' }).click();
      await waitUntil(page, `/\\d{1,2}:\\d{2} [AP]M/.test(document.body.innerText)`);
      return (await page.evaluate<string>('document.body.innerText')).match(TIMESTAMP)?.slice(0, 5) ?? [];
    }

    it('con perfil en Asia/Tokyo, los timestamps siguen mostrándose en la zona del dispositivo (GMT-6)', async () => {
      const page = await loggedInPage();
      await page.clock.setTimezone('America/Costa_Rica');
      await applyPreferences(page, { ...BASELINE, timeZone: 'America/Costa_Rica' });
      const before = await notificationTimestamps(page);
      expect(before.length).toBeGreaterThan(0);

      await openProfile(page);
      await selectTimeZone(page, 'Asia/Tokyo');
      await saveProfile(page);
      expect((await readServerPreferences(page)).timeZone).toBe('Asia/Tokyo');

      const after = await notificationTimestamps(page);
      expect(after).toEqual(before);
      expect(after.every((t) => t.endsWith('CST'))).toBe(true);
    });

    // Requiere crear un ítem/temporizador programado y esperar a su ejecución en backend.
    it.todo('el backend dispara el ítem programado usando la zona Asia/Tokyo guardada');

    afterAll(async () => {
      const page = await loggedInPage();
      await applyPreferences(page, BASELINE);
    });
  });

  describe('TC1584 – Selector de zona horaria con búsqueda y formato', () => {
    let page: Page;
    const LABEL_FORMAT = /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)* \(UTC[+-]\d{2}:\d{2}\)$/;

    beforeAll(async () => {
      page = await loggedInPage();
      await openProfile(page);
    });

    it('todas las entradas muestran "IANA/Zona (UTC±HH:MM)"', async () => {
      const all = await searchTimeZones(page, '');
      expect(all.length).toBeGreaterThan(300);
      expect(all.filter((l) => !LABEL_FORMAT.test(l))).toEqual([]);
      expect(all).toContain('America/Costa_Rica (UTC-06:00)');
    });

    it.each([
      ['Costa Rica', 'America/Costa_Rica (UTC-06:00)'],
      ['UTC-06', 'America/Costa_Rica (UTC-06:00)'],
      ['Tokyo', 'Asia/Tokyo (UTC+09:00)'],
      ['UTC+09', 'Asia/Tokyo (UTC+09:00)'],
    ])('buscar "%s" incluye %s', async (query, expected) => {
      // Defecto encontrado: "Costa Rica" (con espacio, nombre legible/país) → "No available options".
      const results = await searchTimeZones(page, query);
      expect(results).toContain(expected);
      expect(results.every((l) => LABEL_FORMAT.test(l))).toBe(true);
    });

    it('los resultados de "UTC-06" solo contienen zonas UTC-06:00', async () => {
      const results = await searchTimeZones(page, 'UTC-06');
      expect(results.length).toBeGreaterThan(1);
      expect(results.every((l) => l.endsWith('(UTC-06:00)'))).toBe(true);
    });
  });

  describe('TC1585 – Dark Mode en toda la UI', () => {
    let page: Page;

    beforeAll(async () => {
      page = await loggedInPage();
      await applyPreferences(page, BASELINE);
      await openProfile(page);
      expect(await page.evaluate<string>('document.documentElement.dataset.bsTheme')).toBe('light');
    });

    it('al activar Dark Mode y guardar, el tema cambia sin recargar', async () => {
      await page.evaluate(`window.__noReload = true`);
      await setDarkMode(page, true);
      await saveProfile(page);
      await waitUntil(page, `document.documentElement.dataset.bsTheme === 'dark'`, 5_000);
      expect(await page.evaluate<boolean>('window.__noReload === true')).toBe(true);
      expect(await findLightPanels(page)).toEqual([]);
    });

    it.each([
      ['dashboard', '/dashboard/welcome'],
      ['tabla de reporte', REPORT_ENTITY_PATH],
      ['formulario', `${REPORT_ENTITY_PATH}/create`],
      ['settings / usuarios', '/settings/users'],
    ])('%s no tiene paneles en modo claro', async (_name, path) => {
      await page.go(`${BASE_URL}${path}`);
      await waitUntil(page, `document.documentElement.dataset.bsTheme === 'dark'`);
      await page.wait(1500);
      expect(await findLightPanels(page)).toEqual([]);
    });

    it('dropdowns y drawers abiertos también son oscuros', async () => {
      await page.go(`${BASE_URL}${REPORT_ENTITY_PATH}`);
      await waitUntil(page, `document.querySelector('${SEL.filterToggle}')`);
      await page.find('button[title="Show Columns"]').click();
      await waitUntil(page, `document.querySelector('.dropdown-menu.show')`);
      expect(await findLightPanels(page)).toEqual([]);

      await page.keyboard.press('Escape');
      await page.find(SEL.filterToggle).click();
      await waitUntil(page, `document.querySelector('${SEL.filterDrawer}')`);
      expect(await findLightPanels(page)).toEqual([]);
    });

    afterAll(async () => {
      await applyPreferences(page, BASELINE);
    });
  });

  describe('TC1586 – Actualización dinámica sin recarga manual', () => {
    let page: Page;

    beforeAll(async () => {
      page = await loggedInPage();
      await applyPreferences(page, BASELINE);
      await page.go(`${BASE_URL}${REPORT_ENTITY_PATH}`);
      await waitUntil(page, `document.querySelector('${SEL.filterToggle}')`);

      // Filtro activo: gender = F
      await page.find(SEL.filterToggle).click();
      await waitUntil(page, `document.querySelector('${SEL.filterDrawer}')`);
      await page.find(`${SEL.filterDrawer} input[type=text]:not([readonly])`).fill('F');
      await page.find(SEL.filterApply).click();
      await waitUntil(page, `document.querySelector('${SEL.activeFilters}').innerText.includes('F')`);
      await page.evaluate(`window.__noReload = true`);
    });

    const state = () =>
      evalJson<{ noReload: boolean; theme: string; filters: string; search: string; drawerOpen: boolean }>(
        page,
        `{ noReload: window.__noReload === true,
           theme: document.documentElement.dataset.bsTheme,
           filters: document.querySelector('${SEL.activeFilters}').innerText,
           search: location.search,
           drawerOpen: !!document.querySelector('${SEL.filterDrawer}') }`,
      );

    it('cambiar el tema mantiene el filtro activo y el drawer abierto sin recargar', async () => {
      await page.find(SEL.filterToggle).click();
      await waitUntil(page, `document.querySelector('${SEL.filterDrawer}')`);
      const before = await state();

      await page.find('button.theme-toggle').click();
      await waitUntil(page, `document.documentElement.dataset.bsTheme === 'dark'`);

      const after = await state();
      expect(after).toMatchObject({ noReload: true, theme: 'dark', drawerOpen: true, search: before.search });
      expect(after.filters).toMatch(/gender.*F/);
    });

    it('cambiar el idioma desde la cabecera traduce la UI y mantiene el filtro sin recargar', async () => {
      const before = await state();
      await page.find('a.search-toggle.nav-link:has(img)').click();
      await page.find('[id="public-docs.lang-es"]').click();
      await waitUntil(page, `document.querySelector('${SEL.filterToggle}').title === 'Filtros'`);

      const after = await state();
      expect(after).toMatchObject({ noReload: true, search: before.search });
      expect(after.filters).toMatch(/gender Igual a: F/);
    });

    afterAll(async () => {
      await applyPreferences(page, BASELINE);
    });
  });
});
