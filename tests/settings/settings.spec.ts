/**
 * DatAscend (qa2) – Settings › Profile Preferences
 * Casos de origen: tests/settings/TestCases_06-11-26-14_58_56.csv (TC1580–TC1586).
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
} from '../support/datascend';

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
      // El tema llega con el perfil (async) tras el login: debe aplicarse sin intervención del usuario.
      await waitUntil(page, `document.documentElement.dataset.bsTheme === 'dark'`, 10_000);
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

    /** Atributos accesibles (aria-label/title/placeholder) que siguen en inglés con la UI en Español. */
    const ENGLISH_A11Y = /^(Switch to (light|dark) mode|Toggle navigation|First Page|Previous Page|Next Page|Last Page)$/i;
    /** Comportamiento actual de qa2 (2026-11-06): estas etiquetas no están traducidas. */
    const KNOWN_UNTRANSLATED = [
      'Switch to dark mode',
      'Switch to Dark Mode',
      'Toggle navigation',
      'First Page',
      'Previous Page',
      'Next Page',
      'Last Page',
    ];

    async function englishA11yLabels(): Promise<string[]> {
      await page.go(`${BASE_URL}${REPORT_ENTITY_PATH}`);
      await waitUntil(page, `document.querySelector('.custom-pagination__btn') && document.querySelector('button.theme-toggle')`);
      return evalJson<string[]>(
        page,
        `[...new Set([...document.querySelectorAll('[aria-label],[title],[placeholder]')]
          .flatMap(e => ['aria-label', 'title', 'placeholder'].map(a => e.getAttribute(a)).filter(Boolean)))]
          .filter(l => ${ENGLISH_A11Y}.test(l))`,
      );
    }

    it('regresión: no aparecen etiquetas accesibles en inglés aparte de las ya conocidas', async () => {
      const english = await englishA11yLabels();
      expect(english.filter((l) => !KNOWN_UNTRANSLATED.includes(l))).toEqual([]);
    });

    // Defecto abierto: TC1582 exige que "todos los elementos de UI" pasen a Español, pero las
    // etiquetas de KNOWN_UNTRANSLATED (tema, menú y paginador) siguen en inglés.
    // `it.fails` mantiene la suite en verde mientras el defecto exista y avisa cuando se corrija.
    it.fails('[defecto conocido] ninguna etiqueta accesible queda en inglés', async () => {
      expect(await englishA11yLabels()).toEqual([]);
    });

    afterAll(async () => {
      await applyPreferences(page, BASELINE);
    });
  });

  describe('TC1583 – Zona horaria: display del SO vs lógica programada del backend', () => {
    // Render observado en qa2 (vía Vibium, 2026-11-06), idéntico con perfil en Costa_Rica o Asia/Tokyo:
    //   <p class="notification-date">October, Wednesday 28, 2026 – 11:51 AM CST</p>
    // La hora admite 12h o 24h, segundos opcionales y sufijo AM/PM con variantes
    // ("AM", "am", "a.m.", "a. m.") separado por espacio, NBSP o U+202F (Chrome/ICU).
    const TIME = /\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:[\s  ]*[AaPp]\.?[\s  ]?[Mm]\.?)?/;
    const DATE_SELECTOR = '[data-testid="notifications.item"] .notification-date';

    async function notificationTimestamps(page: Page): Promise<string[]> {
      await page.go(`${BASE_URL}/dashboard/welcome`);
      await waitUntil(page, `document.querySelector('[data-testid="notifications.bell"]')`);
      await page.find('[data-testid="notifications.bell"]').click();
      const time = `new RegExp(${JSON.stringify(TIME.source)})`;
      await waitUntil(
        page,
        `[...document.querySelectorAll('${DATE_SELECTOR}')].some(e => ${time}.test(e.textContent))`,
        30_000,
      );
      const dates = await evalJson<string[]>(page, `[...document.querySelectorAll('${DATE_SELECTOR}')].map(e => e.textContent)`);
      // Normalizar espacios especiales para que la comparación antes/después sea estable.
      return dates
        .map((d) => d.replace(/[\s  ]+/g, ' ').trim())
        .filter((d) => TIME.test(d))
        .slice(0, 5);
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
      // Zona del dispositivo (GMT-6): abreviatura "CST" o el offset "GMT-6"/"UTC-06:00".
      expect(after.every((t) => /(?:CST|(?:GMT|UTC)-0?6(?::00)?)$/.test(t))).toBe(true);
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

    // Comportamiento actual de qa2: la búsqueda es una coincidencia parcial, sin distinguir
    // mayúsculas, sobre el identificador IANA y el offset (no sobre nombres legibles).
    it.each([
      ['Costa', 'America/Costa_Rica (UTC-06:00)'],
      ['costa', 'America/Costa_Rica (UTC-06:00)'],
      ['Costa_Rica', 'America/Costa_Rica (UTC-06:00)'],
      ['America/Costa', 'America/Costa_Rica (UTC-06:00)'],
      ['UTC-06', 'America/Costa_Rica (UTC-06:00)'],
      ['-06:00', 'America/Costa_Rica (UTC-06:00)'],
      ['Tokyo', 'Asia/Tokyo (UTC+09:00)'],
      ['tokyo', 'Asia/Tokyo (UTC+09:00)'],
      ['UTC+09', 'Asia/Tokyo (UTC+09:00)'],
    ])('buscar "%s" incluye %s', async (query, expected) => {
      const results = await searchTimeZones(page, query);
      expect(results).toContain(expected);
      expect(results.every((l) => LABEL_FORMAT.test(l))).toBe(true);
    });

    // Defecto abierto: TC1584 pide buscar "Costa Rica" (nombre legible, con espacio), pero qa2
    // responde "No available options" porque el identificador usa guion bajo (Costa_Rica).
    it.fails.each([
      ['Costa Rica', 'America/Costa_Rica (UTC-06:00)'],
      ['New York', 'America/New_York (UTC-05:00)'],
    ])('[defecto conocido] buscar el nombre legible "%s" incluye %s', async (query, expected) => {
      const results = await searchTimeZones(page, query);
      expect(results.map((l) => l.replace(/ \(UTC.*$/, ''))).toContain(expected.replace(/ \(UTC.*$/, ''));
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
      await page.wait(1000); // transiciones CSS del sidebar
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
    /** Campo que el drawer propone por defecto (p. ej. last_name); se lee en tiempo de ejecución. */
    let field: string;

    beforeAll(async () => {
      page = await loggedInPage();
      await applyPreferences(page, BASELINE);
      await page.go(`${BASE_URL}${REPORT_ENTITY_PATH}`);
      await waitUntil(page, `document.querySelector('${SEL.filterToggle}')`);

      // Filtro activo: <campo por defecto> = F
      const valueInput = `${SEL.filterDrawer} input[type=text]:not([readonly])`;
      await page.find(SEL.filterToggle).click();
      await waitUntil(page, `document.querySelector('${valueInput}')?.name`);
      field = await page.evaluate<string>(`document.querySelector('${valueInput}').name`);
      await page.find(valueInput).fill('F');
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
      expect(after.filters).toMatch(new RegExp(`${field}.*: F`));
    });

    it('cambiar el idioma desde la cabecera traduce la UI y mantiene el filtro sin recargar', async () => {
      const before = await state();
      await page.find('a.search-toggle.nav-link:has(img)').click();
      await page.find('[id="public-docs.lang-es"]').click();
      await waitUntil(page, `document.querySelector('${SEL.filterToggle}').title === 'Filtros'`);

      const after = await state();
      expect(after).toMatchObject({ noReload: true, search: before.search });
      expect(after.filters).toContain(`${field} Igual a: F`);
    });

    afterAll(async () => {
      await applyPreferences(page, BASELINE);
    });
  });
});
