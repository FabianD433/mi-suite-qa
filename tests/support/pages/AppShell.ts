/**
 * Page Object de los controles transversales de la app autenticada: cabecera (menú de usuario,
 * logout, idioma, tema) y feedback global (toasts).
 *
 * Centraliza lo que antes estaba repartido entre dashboard.spec.ts (`openUserMenu`, `clickLogout`),
 * users.spec.ts (`switchLanguage`, `waitForToast`, selectores del menú) y settings.spec.ts
 * (cambio de tema e idioma de TC1586).
 */
import { SEL, clickUnobscured, evalJson, waitUntil, type Page } from '../datascend';

const HEADER = '[data-testid="layout.main.header"]';
/**
 * Menú de usuario abierto. Se identifica por su opción de logout (`role="button"`): el selector de
 * idioma también es un `.dropdown-menu` y puede seguir con `.show` tras elegir idioma, así que un
 * `.dropdown-menu.show` genérico confundiría ambos menús.
 */
const USER_MENU = '.dropdown-menu.show:has(a.dropdown-item[role="button"])';

export const SHELL_SEL = {
  header: HEADER,
  /** Avatar/nombre del usuario (arriba a la derecha) que despliega el menú de usuario. */
  userMenuTrigger: `${HEADER} a.nav-link.search-toggle.py-0`,
  userMenu: USER_MENU,
  userMenuItem: `${USER_MENU} .dropdown-item`,
  logout: `${USER_MENU} a.dropdown-item[role="button"]`,
  /** Campana de notificaciones (abre el drawer de notificaciones). */
  notificationsBell: '[data-testid="notifications.bell"]',
  /** Bandera del idioma actual, que despliega el selector de idioma. */
  langToggle: 'a.search-toggle.nav-link:has(img)',
  langOption: (lang: Language) => `[id="public-docs.lang-${lang}"]`,
  themeToggle: 'button.theme-toggle',
  toast: SEL.toast,
} as const;

export type Language = 'en' | 'es';

export interface UserMenuItem {
  text: string;
  /** Es un enlace o tiene `role="button"`. */
  clickable: boolean;
}

/**
 * Registra en `window.__toasts` el texto de todos los toasts que aparecen, aunque se cierren solos
 * antes de que el test los lea. Idempotente y compatible con un init script que ya los registre.
 */
const TRACK_TOASTS = `(() => {
  if (Array.isArray(window.__toasts)) return;
  window.__toasts = [];
  new MutationObserver(() => {
    for (const t of document.querySelectorAll('${SEL.toast}')) {
      const text = t.innerText.trim();
      if (text && t.__seen !== text) { t.__seen = text; window.__toasts.push(text); }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
})()`;

export class AppShell {
  static readonly SEL = SHELL_SEL;

  constructor(private readonly page: Page) {}

  /** Espera a que la cabecera de la app (con el menú de usuario) esté renderizada. */
  async waitForHeader(timeout?: number): Promise<void> {
    await waitUntil(this.page, `document.querySelector('${SHELL_SEL.userMenuTrigger}')`, timeout);
  }

  /**
   * Espera a que la cabecera deje de moverse. Al cargar, el sidebar se anima y desplaza la cabecera,
   * y el selector "Domains" aparece dentro de ella empujando los iconos: un clic en ese momento puede
   * caer en otro control (p. ej. la campana → avatar). Se comparan las posiciones de la cabecera y de
   * sus controles hasta obtener tres lecturas iguales seguidas (≈600 ms sin cambios).
   */
  async waitForStableHeader(timeout = 10_000): Promise<void> {
    await this.waitForHeader();
    const controls = [HEADER, SHELL_SEL.notificationsBell, SHELL_SEL.userMenuTrigger, SHELL_SEL.langToggle];
    const rects = `JSON.stringify(${JSON.stringify(controls)}.map(s => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return r ? [r.x, r.y, r.width, r.height].map(Math.round) : null;
    }))`;
    const end = Date.now() + timeout;
    let last = '';
    let stable = 0;
    while (Date.now() < end) {
      const now = await this.page.evaluate<string>(rects);
      stable = now === last ? stable + 1 : 0;
      if (stable >= 2) return;
      last = now;
      await this.page.wait(300);
    }
  }

  // ── Menú de usuario ────────────────────────────────────────────────────────────

  async openUserMenu(): Promise<void> {
    await this.waitForHeader();
    if (await this.page.evaluate<boolean>(`!!document.querySelector('${USER_MENU}')`)) return;
    await this.page.find(SHELL_SEL.userMenuTrigger).click();
    await waitUntil(this.page, `document.querySelector('${USER_MENU}')`);
  }

  async closeUserMenu(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await waitUntil(this.page, `!document.querySelector('${USER_MENU}')`);
  }

  /** Opciones del menú de usuario (lo abre si hace falta). */
  async userMenuItems(): Promise<UserMenuItem[]> {
    await this.openUserMenu();
    return evalJson<UserMenuItem[]>(
      this.page,
      `[...document.querySelectorAll('${SHELL_SEL.userMenuItem}')].map(e => ({
        text: e.innerText.trim(),
        clickable: e.tagName === 'A' || e.getAttribute('role') === 'button',
      }))`,
    );
  }

  /** Pulsa la opción del menú de usuario con ese texto exacto (p. ej. "Settings"). */
  async clickUserMenuItem(text: string): Promise<void> {
    await this.openUserMenu();
    const found = await this.page.evaluate<boolean>(
      `(() => { const e = [...document.querySelectorAll('${SHELL_SEL.userMenuItem}')].find(e => e.innerText.trim() === ${JSON.stringify(text)});
        if (e) e.click(); return !!e; })()`,
    );
    if (!found) throw new Error(`El menú de usuario no tiene la opción "${text}"`);
  }

  /** Texto de la opción de logout ("Logout" / "Cerrar Sesión"). Abre el menú. */
  async logoutText(): Promise<string> {
    await this.openUserMenu();
    return this.page.find(SHELL_SEL.logout).text();
  }

  /**
   * Cierra la sesión desde el menú de usuario y espera al formulario de login ya traducido
   * (antes de resolver i18n el botón muestra "login.sign-in").
   */
  async logout(): Promise<void> {
    await this.openUserMenu();
    await this.page.find(SHELL_SEL.logout).click();
    await waitUntil(this.page, `location.pathname === '/auth/login' && document.querySelector('button[type="submit"]')`, 15_000);
    await waitUntil(this.page, `!/^login\\./.test(document.querySelector('button[type="submit"]').innerText)`);
  }

  // ── Idioma y tema ──────────────────────────────────────────────────────────────

  /**
   * Cambia el idioma desde la bandera de la cabecera (se guarda en el perfil del usuario).
   * La app no expone el idioma en `html[lang]` ni en `localStorage`, así que la espera depende de la
   * pantalla: `until` es una expresión JS que se cumple cuando la UI ya está traducida (p. ej. un
   * título concreto). Si no se indica, se espera a que cambie la bandera de la cabecera.
   */
  async switchLanguage(lang: Language, opts: { until?: string; timeout?: number } = {}): Promise<void> {
    const flag = `document.querySelector('${SHELL_SEL.langToggle} img')?.getAttribute('src')`;
    const before = await this.page.evaluate<string | null>(flag);
    await clickUnobscured(this.page, SHELL_SEL.langToggle);
    await clickUnobscured(this.page, SHELL_SEL.langOption(lang));
    await waitUntil(this.page, opts.until ?? `${flag} !== ${JSON.stringify(before)}`, opts.timeout);
  }

  /** Tema actual (`data-bs-theme` del documento: 'light' | 'dark'). */
  async theme(): Promise<string> {
    return this.page.evaluate<string>(`document.documentElement.dataset.bsTheme ?? ''`);
  }

  /** Alterna el tema con el botón de la cabecera y espera a que cambie. Devuelve el tema nuevo. */
  async toggleTheme(): Promise<string> {
    const before = await this.theme();
    await clickUnobscured(this.page, SHELL_SEL.themeToggle);
    await waitUntil(this.page, `document.documentElement.dataset.bsTheme !== ${JSON.stringify(before)}`);
    return this.theme();
  }

  // ── Toasts ────────────────────────────────────────────────────────────────────

  /** Empieza a registrar los toasts de la página actual (no hace falta si un init script ya lo hace). */
  async trackToasts(): Promise<void> {
    await this.page.evaluate(TRACK_TOASTS);
  }

  /** Textos de los toasts visibles ahora mismo. */
  async visibleToasts(): Promise<string[]> {
    return evalJson<string[]>(this.page, `[...document.querySelectorAll('${SEL.toast}')].map(t => t.innerText.trim())`);
  }

  /**
   * Espera un toast que contenga `text`: visible ahora o ya registrado (si la página registra toasts,
   * vale aunque ya se haya cerrado). Devuelve todos los toasts vistos; si vence, el error los lista.
   */
  async waitForToast(text: string, timeout = 15_000): Promise<string[]> {
    const seen = `[...(window.__toasts ?? []), ...[...document.querySelectorAll('${SEL.toast}')].map(t => t.innerText.trim())]`;
    try {
      await waitUntil(this.page, `${seen}.some(t => t.includes(${JSON.stringify(text)}))`, timeout);
    } catch {
      const all = await evalJson<string[]>(this.page, seen).catch(() => []);
      throw new Error(`No apareció un toast con "${text}" en ${timeout} ms; toasts vistos: ${JSON.stringify(all)}`);
    }
    return evalJson<string[]>(this.page, `[...new Set(${seen})]`);
  }
}
