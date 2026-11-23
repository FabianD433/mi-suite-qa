import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach } from 'vitest';
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
  // Los selectores del drawer de filtros viven en tests/support/pages/FilterDrawer.ts (FILTER_SEL).
} as const;

/** Navegadores vivos del archivo de test actual (para capturar pantallas al fallar). */
const liveBrowsers = new Set<Browser>();

/**
 * Flags de Chrome para contenedores/CI Linux (GitHub Actions `ubuntu-latest`), donde Chrome se cae al
 * arrancar (`BrowserCrashedError: Chrome instance exited`): sin sandbox de usuario y sin depender del
 * `/dev/shm` reducido de los runners.
 */
const CONTAINER_CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

/**
 * `browser.start()` de Vibium no acepta `args` (StartOptions: engine, channel, headless, headers,
 * executablePath). El binario de Vibium sí lee `VIBIUM_CHROME_ARGS` (flags separados por espacios;
 * verificado empíricamente) y hereda nuestro entorno, así que se agregan ahí sin pisar valores previos.
 * Solo aplica en CI o Linux: en Windows/macOS local no cambia nada.
 */
function applyContainerChromeArgs(): void {
  if (process.env.CI !== 'true' && process.platform !== 'linux') return;
  const current = (process.env.VIBIUM_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
  const merged = [...current, ...CONTAINER_CHROME_ARGS.filter((a) => !current.includes(a))];
  process.env.VIBIUM_CHROME_ARGS = merged.join(' ');
}

export async function startBrowser(): Promise<Browser> {
  applyContainerChromeArgs();
  const b = await browser.start({ headless: process.env.HEADLESS !== 'false' });
  liveBrowsers.add(b);
  const stop = b.stop.bind(b);
  b.stop = async () => {
    liveBrowsers.delete(b);
    await stop();
  };
  return b;
}

export const SCREENSHOTS_DIR = resolve(process.cwd(), 'reports', 'screenshots');

/** `archivo__suite › test` → nombre de archivo seguro y acotado. */
function screenshotBaseName(file: string, fullName: string): string {
  const raw = `${file.replace(/^tests[\\/]/, '').replace(/\.spec\.ts$/, '')}__${fullName}`;
  return raw.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/_+/g, '_').slice(0, 150);
}

/** Rechaza si la promesa no se resuelve en `ms` (una página colgada no debe bloquear el hook). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Cuando un test E2E falla, guarda un PNG de cada página abierta en `reports/screenshots/`.
 * Se registra al importar este módulo, por lo que aplica a todo archivo de test que lo use.
 * Nunca hace fallar el test por sí mismo: los errores de captura solo se registran en consola.
 */
afterEach(async (ctx) => {
  // `it.fails` (defectos conocidos) falla a propósito: no se captura.
  if (ctx.task.fails || ctx.task.result?.state !== 'fail' || liveBrowsers.size === 0) return;
  const names: string[] = [];
  for (let s = ctx.task.suite; s?.name; s = s.suite) names.unshift(s.name);
  const base = screenshotBaseName(ctx.task.file?.name ?? 'unknown', [...names, ctx.task.name].join(' › '));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  let n = 0;
  for (const b of liveBrowsers) {
    const pages = await withTimeout(b.pages(), 5_000).catch(() => [] as Page[]);
    for (const page of pages) {
      try {
        const png = await withTimeout(page.screenshot(), 10_000);
        const file = resolve(SCREENSHOTS_DIR, `${base}__${stamp}__p${++n}.png`);
        writeFileSync(file, png);
        console.warn(`[screenshot] ${file}`);
      } catch (e) {
        console.warn(`[screenshot] no se pudo capturar una página: ${(e as Error).message}`);
      }
    }
  }
});

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

/**
 * Reevalúa `expression` (puede devolver una Promise) hasta que su valor cumpla `done`
 * o venza el timeout; devuelve el último valor leído para que el `expect` muestre el real.
 */
export async function pollEvaluate<T>(
  page: Page,
  expression: string,
  done: (value: T) => boolean,
  timeout = 10_000,
): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate<T>(expression).catch(() => undefined as T);
    if (done(value) || Date.now() > end) return value;
    await page.wait(250);
  }
}

/** Drawers, modales, backdrops y paneles flotantes que pueden tapar la página. */
const OVERLAYS = '.offcanvas, .offcanvas-backdrop, .modal, .modal-backdrop, .p-treeselect-panel, .p-component-overlay';

/**
 * Espera a que no quede ningún overlay visible. Ojo: el offcanvas pierde `.show` en cuanto empieza
 * a cerrarse, pero sigue en el DOM (`offcanvas-toggling`) deslizándose ~400ms por encima del
 * contenido; por eso no basta con esperar a que desaparezca `.show`.
 */
export async function waitForOverlaysClosed(page: Page, timeout = 10_000): Promise<void> {
  await waitUntil(
    page,
    `![...document.querySelectorAll('${OVERLAYS}')].some(e => {
      const s = getComputedStyle(e);
      return s.display !== 'none' && s.visibility !== 'hidden';
    })`,
    timeout,
  );
}

/**
 * Espera a que el elemento reciba el clic: lo centra en el viewport y comprueba con
 * `elementFromPoint` que nada lo tape (mismo criterio que el check `receivesEvents` de Vibium).
 */
export async function waitUntilClickable(page: Page, selector: string, timeout = 10_000): Promise<void> {
  await waitUntil(
    page,
    `(() => {
      const el = document.querySelector('${selector}');
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && (top === el || el.contains(top));
    })()`,
    timeout,
  );
}

/**
 * Clic estable para evitar `receivesEvents check failed — element is obscured`:
 * 1. espera a que desaparezcan los toasts (p. ej. el de `applyPreferences`, que tapa la cabecera);
 *    si alguno queda colgado, lo retira del DOM;
 * 2. con `overlays: true`, espera además a que drawers/modales/backdrops terminen de cerrarse
 *    (no usarlo cuando un drawer debe seguir abierto a propósito);
 * 3. centra el elemento en el viewport y comprueba con `elementFromPoint` que nada lo tape.
 * Los paneles de TreeSelect que queden abiertos los cierran los Page Objects (TreeSelect/FilterDrawer).
 */
export async function clickUnobscured(page: Page, selector: string, { overlays = false } = {}): Promise<void> {
  await waitUntil(page, `!document.querySelector('${SEL.toast}')`, 15_000).catch(() =>
    page.evaluate(`document.querySelectorAll('${SEL.toast}').forEach(t => t.remove())`),
  );
  if (overlays) await waitForOverlaysClosed(page);
  await waitUntilClickable(page, selector);
  await page.find(selector).click();
}

/**
 * Espera a que el control deje de estar deshabilitado: sin atributo `disabled`
 * (en él o en su input interno, p. ej. TreeSelect de PrimeReact) y sin clase `p-disabled`.
 */
export async function waitEnabled(page: Page, selector: string, timeout = 15_000): Promise<void> {
  await waitUntil(
    page,
    `(() => {
      const el = document.querySelector('${selector}');
      if (!el || el.disabled || el.hasAttribute('disabled') || el.classList.contains('p-disabled')) return false;
      const inner = el.querySelector('input');
      return !(inner && inner.disabled);
    })()`,
    timeout,
  ).catch(() => {
    throw new Error(`Timeout esperando a que se habilite: ${selector}`);
  });
}

/**
 * Abre un TreeSelect de PrimeReact y elige la opción con ese texto, dejando el panel cerrado.
 * @deprecated Usar `new TreeSelect(page, root).select(label)` (tests/support/pages/TreeSelect.ts).
 * Se mantiene por retrocompatibilidad y delega en el Page Object (import dinámico para no crear un
 * ciclo de imports: TreeSelect.ts importa utilidades de este módulo).
 */
export async function selectTreeOption(page: Page, rootSelector: string, label: string): Promise<void> {
  const { TreeSelect } = await import('./pages/TreeSelect');
  await new TreeSelect(page, rootSelector).select(label);
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
  // PrimeReact TreeSelect deselecciona si se hace clic en la opción ya seleccionada.
  const current = await page.evaluate<string>(`document.querySelector('${SEL.tzLabel}').innerText`);
  if (current.startsWith(`${ianaId} (`)) return;
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
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue; // fuera de pantalla
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
