/**
 * Sesión E2E compartida: página con sesión iniciada y cliente HTTP que usa el token de esa sesión.
 *
 * Consolida las copias que estaban duplicadas en los specs:
 * - `api()` — users.spec.ts y notifications.spec.ts (idénticas).
 * - `loggedInPage()` — settings.spec.ts y users.spec.ts.
 */
import { newIsolatedPage, waitUntil, type Browser, type Page } from './datascend';
import { LoginPage } from './pages/LoginPage';

export interface ApiResponse<T> {
  status: number;
  json: T;
}

/**
 * Petición a la API desde el navegador, con el token y el dominio de la sesión (el token no sale
 * del navegador). Devuelve el status y el cuerpo (JSON si se puede parsear; si no, el texto).
 */
export async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
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
  return JSON.parse(raw) as ApiResponse<T>;
}

/** Espera a que `location.pathname` no cambie durante ~1 s (fin de redirecciones de la app). */
export async function waitForStablePath(page: Page, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout;
  let last = await page.evaluate<string>('location.pathname');
  for (;;) {
    await page.wait(1000);
    const now = await page.evaluate<string>('location.pathname');
    if (now === last || Date.now() > end) return;
    last = now;
  }
}

export interface LoggedInPageOptions {
  /** Credenciales (por defecto, la cuenta de QA del `.env`). */
  email?: string;
  password?: string;
  /** Script que se inyecta en cada documento del contexto (p. ej. registro de peticiones/toasts). */
  initScript?: string;
}

/**
 * Página en un contexto aislado (cookies/localStorage propios) con sesión iniciada y la app lista:
 * en `/dashboard`, con dominio seleccionado y sin redirecciones pendientes. Tras el login la app
 * redirige de forma asíncrona y, con qa2 lento, puede tardar; navegar antes puede perderse.
 */
export async function loggedInPage(b: Browser, opts: LoggedInPageOptions = {}): Promise<Page> {
  const { page } = await newIsolatedPage(b, opts.initScript);
  await new LoginPage(page).login(opts.email, opts.password);
  await waitUntil(page, `location.pathname.startsWith('/dashboard') && localStorage.getItem('selectedDomain')`, 45_000);
  await waitForStablePath(page);
  return page;
}
