/**
 * Page Object de la pantalla de login (`/auth/login`).
 *
 * Unifica los selectores del formulario (antes `SEL.email`, `SEL.password`, `SEL.submit`) y los
 * helpers `login` (tests/support/datascend.ts) y `attemptLogin` (tests/users/users.spec.ts).
 */
import { BASE_URL, credentials, evalJson, waitUntil, type Page } from '../datascend';
import { AppShell } from './AppShell';

export const LOGIN_SEL = {
  email: 'input[name="email"]',
  password: 'input[name="password"]',
  submit: 'button[type="submit"]',
} as const;

export interface LoginAttempt {
  /** Ruta final tras el intento (sigue en `/auth/login` si se rechazó). */
  path: string;
  /** Toasts mostrados durante el intento (p. ej. el error de credenciales). */
  toasts: string[];
  /** ¿Se guardó un token de sesión? */
  token: boolean;
}

export class LoginPage {
  static readonly SEL = LOGIN_SEL;
  static readonly PATH = '/auth/login';
  static readonly URL = `${BASE_URL}${LoginPage.PATH}`;

  constructor(private readonly page: Page) {}

  /** Abre el login y espera al formulario. */
  async goto(): Promise<void> {
    await this.page.go(LoginPage.URL);
    await this.waitForForm();
  }

  async waitForForm(timeout?: number): Promise<void> {
    await waitUntil(this.page, `document.querySelector('${LOGIN_SEL.email}')`, timeout);
  }

  /** Espera a que i18n resuelva las claves (antes el botón muestra "login.sign-in"). */
  async waitForTranslations(): Promise<void> {
    await waitUntil(this.page, `!/^login\\./.test(document.querySelector('${LOGIN_SEL.submit}')?.innerText ?? 'login.')`);
  }

  /** ¿Está en la pantalla de login con el formulario visible? */
  async isShown(): Promise<boolean> {
    return this.page.evaluate<boolean>(
      `location.pathname === '${LoginPage.PATH}' && !!document.querySelector('${LOGIN_SEL.submit}')`,
    );
  }

  /** Texto del botón de envío ("Sign In" / "Iniciar Sesión"). */
  async submitText(): Promise<string> {
    return this.page.find(LOGIN_SEL.submit).text();
  }

  async fill(email: string, password: string): Promise<void> {
    await this.page.find(LOGIN_SEL.email).fill(email);
    await this.page.find(LOGIN_SEL.password).fill(password);
  }

  async submit(): Promise<void> {
    await this.page.find(LOGIN_SEL.submit).click();
  }

  /**
   * Inicia sesión (por defecto con la cuenta de QA del `.env`) y espera a salir de `/auth/login`.
   * No espera a que la app termine de redirigir ni a que haya dominio: para eso, `loggedInPage`
   * (tests/support/session.ts).
   */
  async login(email = credentials().email, password = credentials().password): Promise<void> {
    await this.goto();
    await this.fill(email, password);
    await this.submit();
    await waitUntil(this.page, `!location.pathname.startsWith('${LoginPage.PATH}')`, 20_000);
  }

  /**
   * Intenta iniciar sesión sin asumir que funcionará (credenciales inválidas, usuario inactivo…).
   * Registra los toasts aunque se cierren solos y devuelve dónde terminó y si quedó sesión.
   */
  async attempt(email: string, password: string): Promise<LoginAttempt> {
    await this.goto();
    // Sin traducciones, los errores se muestran como claves ("login.failed").
    await this.waitForTranslations();
    await new AppShell(this.page).trackToasts();
    await this.fill(email, password);
    await this.submit();
    await waitUntil(
      this.page,
      `(window.__toasts ?? []).length > 0 || !location.pathname.startsWith('${LoginPage.PATH}')`,
      20_000,
    );
    await this.page.wait(1000);
    return evalJson<LoginAttempt>(
      this.page,
      `{ path: location.pathname, toasts: window.__toasts, token: !!localStorage.getItem('token') }`,
    );
  }
}
