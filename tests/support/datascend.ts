import { browser } from 'vibium';
import { loadEnv, requireEnv } from './env';

loadEnv();

export type Browser = Awaited<ReturnType<typeof browser.start>>;
export type Page = Awaited<ReturnType<Browser['newPage']>>;
export type Context = Awaited<ReturnType<Browser['newContext']>>;

export const BASE_URL = (process.env.DATASCEND_BASE_URL ?? 'https://qa2.datascend.net').replace(/\/$/, '');
export const credentials = () => ({
  email: requireEnv('DATASCEND_EMAIL'),
  password: requireEnv('DATASCEND_PASSWORD'),
});

/** Entidad con tabla y filtros usada en TC1585/TC1586 (Employees en qa2). */
export const REPORT_ENTITY_PATH =
  process.env.DATASCEND_REPORT_PATH ?? '/dashboard/entity/bca60f26-322d-4fb8-8bbb-8c05fbad033a';

export interface Preferences {
  language: 'en' | 'es';
  timeZone: string;
  darkMode: boolean;
}

/** Estado original de la cuenta de QA; se restaura al terminar la suite. */
export const BASELINE: Preferences = { language: 'en', timeZone: 'America/Costa_Rica', darkMode: false };

export const SEL = {
  email: 'input[name="email"]',
  password: 'input[name="password"]',
  submit: 'button[type="submit"]',
  language: '#preferences-language',
  darkMode: '#preferences-dark-mode',
  tzTrigger: '.p-treeselect:has(#preferences-timezone-input) .p-treeselect-trigger',
  tzLabel: '.p-treeselect:has(#preferences-timezone-input) .p-treeselect-label',
  tzFilter: '.p-treeselect-panel input.p-treeselect-filter',
  toast: '.Toastify__toast',
  filterToggle: '#filter\\.toggle',
  filterDrawer: '.filter-offcanvas.show',
  filterApply: '#filter\\.drawer\\.apply',
  activeFilters: '#filter\\.activeFilters',
} as const;

export async function startBrowser(): Promise<Browser> {
  return browser.start({ headless: process.env.HEADLESS !== 'false' });
}

/** Contexto aislado (cookies/localStorage propios), equivalente a una ventana incógnita. */
export async function newIsolatedPage(b: Browser, initScript?: string): Promise<{ ctx: Context; page: Page }> {
  const ctx = await b.newContext();
  if (initScript) await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  // El viewport headless por defecto (~762x484) hace que header y toasts tapen controles.
  await page.setViewport({ width: 1366, height: 900 });
  await page.go(`${BASE_URL}/auth/login`); // about:blank no permite leer localStorage
  return { ctx, page };
}

export async function evalJson<T>(page: Page, expression: string): Promise<T> {
  return JSON.parse(await page.evaluate<string>(`JSON.stringify(${expression})`)) as T;
}

/** Espera hasta que la expresión JS sea truthy en la página. */
export async function waitUntil(page: Page, expression: string, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate<boolean>(`!!(${expression})`).catch(() => false)) return;
    if (Date.now() > end) throw new Error(`Timeout esperando: ${expression}`);
    await page.wait(250);
  }
}

export async function login(page: Page, email = credentials().email, password = credentials().password) {
  await page.go(`${BASE_URL}/auth/login`);
  await waitUntil(page, `document.querySelector('${SEL.email}')`);
  await page.find(SEL.email).fill(email);
  await page.find(SEL.password).fill(password);
  await page.find(SEL.submit).click();
  await waitUntil(page, `!location.pathname.startsWith('/auth/login')`, 20_000);
}

export async function openProfile(page: Page) {
  await page.go(`${BASE_URL}/profile`);
  // El perfil se carga async: esperar a que el label de zona horaria tenga un valor real
  // (antes muestra el placeholder "Time zone") y a que el formulario se estabilice.
  await waitUntil(
    page,
    `document.querySelector('${SEL.language}') && /\\(UTC[+-]/.test(document.querySelector('${SEL.tzLabel}')?.innerText ?? '')`,
    20_000,
  );
  await page.wait(1000);
}

export async function readUiPreferences(page: Page): Promise<Preferences & { theme: string }> {
  return evalJson(page, `{
    language: document.querySelector('${SEL.language}').value,
    timeZone: document.querySelector('${SEL.tzLabel}').innerText.replace(/ \\(UTC.*$/, ''),
    darkMode: document.querySelector('${SEL.darkMode}').checked,
    theme: document.documentElement.dataset.bsTheme,
  }`);
}

/** Preferencias guardadas en el servidor (GET /api/v1/users/profile). */
export async function readServerPreferences(page: Page): Promise<Preferences> {
  const raw = await page.evaluate<string>(`(async () => {
    const r = await fetch('/api/v1/users/profile', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    return JSON.stringify(await r.json());
  })()`);
  const find = (o: unknown): Preferences | undefined => {
    if (!o || typeof o !== 'object') return undefined;
    const rec = o as Record<string, unknown>;
    if (rec.preferences && typeof rec.preferences === 'object') return rec.preferences as Preferences;
    for (const v of Object.values(rec)) {
      const hit = find(v);
      if (hit) return hit;
    }
    return undefined;
  };
  const prefs = find(JSON.parse(raw));
  if (!prefs) throw new Error('La respuesta de /users/profile no contiene "preferences"');
  return prefs;
}

/** Abre el selector de zona horaria y devuelve las opciones visibles tras filtrar. */
export async function searchTimeZones(page: Page, query: string): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    const open = await page.evaluate<boolean>(`!!document.querySelector('${SEL.tzFilter}')`);
    if (!open) {
      await page.find(SEL.tzTrigger).click();
      await waitUntil(page, `document.querySelector('${SEL.tzFilter}')`);
    }
    if (query) {
      await page.find(SEL.tzFilter).fill(query);
    } else {
      await page.find(SEL.tzFilter).clear();
    }
    await page.wait(600);
    // null = el panel se cerró (re-render); se reabre y se reintenta.
    const items = await evalJson<string[] | null>(
      page,
      `(() => {
        const panel = document.querySelector('${SEL.tzFilter}')?.closest('.p-treeselect-panel');
        return panel ? [...panel.querySelectorAll('li[role=treeitem]')].map(li => li.getAttribute('aria-label')).filter(Boolean) : null;
      })()`,
    );
    if (items) return items;
    if (attempt >= 3) throw new Error('El panel de zonas horarias se cerró al filtrar');
  }
}

export async function selectTimeZone(page: Page, ianaId: string) {
  const options = await searchTimeZones(page, ianaId);
  const label = options.find((o) => o.startsWith(`${ianaId} (`));
  if (!label) throw new Error(`Zona horaria ${ianaId} no encontrada; opciones: ${options.join(', ')}`);
  await page.find(`.p-treeselect-panel li[aria-label="${label}"] .p-treenode-content`).click();
  await waitUntil(page, `document.querySelector('${SEL.tzLabel}').innerText.startsWith('${ianaId} (')`);
}

export async function setDarkMode(page: Page, on: boolean) {
  const checked = await page.evaluate<boolean>(`document.querySelector('${SEL.darkMode}').checked`);
  if (checked !== on) await page.find(SEL.darkMode).click();
}

/** Pulsa "Save" del perfil y devuelve los textos de los toasts mostrados. */
export async function saveProfile(page: Page): Promise<string[]> {
  await page.evaluate(`document.querySelectorAll('${SEL.toast}').forEach(t => t.remove())`);
  await page.find(SEL.submit).click();
  await waitUntil(page, `document.querySelector('${SEL.toast}')`);
  return evalJson<string[]>(page, `[...document.querySelectorAll('${SEL.toast}')].map(t => t.innerText.trim())`);
}

export async function applyPreferences(page: Page, prefs: Preferences): Promise<string[]> {
  await openProfile(page);
  await page.find(SEL.language).selectOption(prefs.language);
  await selectTimeZone(page, prefs.timeZone);
  await setDarkMode(page, prefs.darkMode);
  const saveEnabled = await page.evaluate<boolean>(`!document.querySelector('${SEL.submit}').disabled`);
  return saveEnabled ? saveProfile(page) : [];
}

/** Elementos grandes y visibles con fondo claro (luminancia > 0.85): no deberían existir en modo oscuro. */
export async function findLightPanels(page: Page): Promise<string[]> {
  return evalJson<string[]>(page, `(() => {
    const lum = (c) => { const m = c.match(/[\\d.]+/g); if (!m) return 0; const [r, g, b, a = 1] = m.map(Number);
      return a === 0 ? -1 : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    const out = [];
    for (const e of document.querySelectorAll('body *')) {
      const r = e.getBoundingClientRect();
      if (r.width < 120 || r.height < 40) continue;
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      if (lum(s.backgroundColor) > 0.85) out.push(e.tagName + '.' + String(e.className).slice(0, 50) + ' ' + s.backgroundColor);
    }
    return out;
  })()`);
}

/** Script de inicio que simula un navegador en español y un SO en modo oscuro. */
export const SPANISH_DARK_OS_INIT = `(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'es-CR' });
  Object.defineProperty(navigator, 'languages', { get: () => ['es-CR', 'es'] });
  const original = window.matchMedia.bind(window);
  window.matchMedia = (q) => q.includes('prefers-color-scheme') && q.includes('dark')
    ? { matches: true, media: q, onchange: null, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }
    : original(q);
})();`;
