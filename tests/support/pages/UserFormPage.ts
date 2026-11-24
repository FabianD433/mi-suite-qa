/**
 * Page Object del formulario de usuario: creación (`/settings/users/create`) y edición
 * (`/settings/users/edit/{id}`, con las pestañas Basic Information / Roles / Domains).
 *
 * Extraído de tests/users/users.spec.ts (`U.form`, `U.tab` y la parte de UI de `setRoleOrDomain`).
 * Los formularios hacen `history.back()` al guardar: hay que llegar a ellos con clics desde el
 * listado (UsersListPage), no con `page.go`.
 */
import { evalJson, waitUntil, type Page } from '../datascend';

const CONTENT = '[data-testid="layout.main.content"]';
const FORM = `${CONTENT} form`;

export type UserField = 'firstName' | 'lastName' | 'email' | 'password';
export type UserTab = 'details' | 'roles' | 'domains';
export type AssignmentKind = 'roles' | 'domains';

export const USER_FORM_SEL = {
  form: FORM,
  firstName: 'input[name="firstName"]',
  lastName: 'input[name="lastName"]',
  email: 'input[name="email"]',
  password: 'input[name="password"]',
  save: 'form button[type="submit"]',
  cancel: 'form button.btn-light',
  tabs: `${CONTENT} [role=tab]`,
  tab: (key: UserTab) => `[role=tab][data-rr-ui-event-key="${key}"]`,
  /** Checkboxes de asignación de la pestaña Roles (`role_{id}`) o Domains (`domain_{id}`). */
  assignmentInput: (kind: AssignmentKind) => `input[id^="${ASSIGNMENT_PREFIX[kind]}"]`,
} as const;

const ASSIGNMENT_PREFIX: Record<AssignmentKind, string> = { roles: 'role_', domains: 'domain_' };

export interface UserFormView {
  /** `name` de los campos del formulario. */
  inputs: string[];
  labels: string[];
  /** Número de pestañas de la vista (0 en la creación). */
  tabs: number;
  /** Botones visibles del formulario (sin los internos con `tabindex=-1`). */
  buttons: string[];
}

export interface Assignment {
  /** `id` del checkbox (p. ej. `role_<uuid>`). */
  inputId: string;
  /** Id del rol o dominio. */
  itemId: string;
  checked: boolean;
}

export class UserFormPage {
  static readonly SEL = USER_FORM_SEL;

  constructor(private readonly page: Page) {}

  /** Espera a la vista de creación (`/settings/users/create`). */
  async waitForCreate(): Promise<void> {
    await waitUntil(this.page, `location.pathname === '/settings/users/create' && document.querySelector('${USER_FORM_SEL.firstName}')`);
  }

  /** Espera a la vista de edición del usuario con `field` ya precargado. */
  async waitForEdit(userId: string, field: UserField = 'email'): Promise<void> {
    await waitUntil(
      this.page,
      `location.pathname === '/settings/users/edit/${userId}' && document.querySelector('${USER_FORM_SEL[field]}')?.value`,
      20_000,
    );
    await this.page.wait(500);
  }

  /** ¿Está en la edición de ese usuario? */
  async isEditing(userId: string): Promise<boolean> {
    return (await this.page.url()).includes(`/settings/users/edit/${userId}`);
  }

  /** Campos, etiquetas, pestañas y botones de la vista. */
  async view(): Promise<UserFormView> {
    return evalJson<UserFormView>(
      this.page,
      `(() => { const f = document.querySelector('${FORM}');
        return { inputs: [...f.querySelectorAll('input, select, textarea')].map(i => i.name),
          labels: [...f.querySelectorAll('label')].map(l => l.innerText.trim()),
          tabs: document.querySelectorAll('${USER_FORM_SEL.tabs}').length,
          buttons: [...f.querySelectorAll('button:not([tabindex="-1"])')].map(b => b.innerText.trim()) }; })()`,
    );
  }

  /** Valores actuales de los inputs del formulario, por `name`. */
  async values(): Promise<Record<string, string>> {
    return evalJson<Record<string, string>>(this.page, `Object.fromEntries([...document.querySelectorAll('${FORM} input')].map(i => [i.name, i.value]))`);
  }

  async labels(): Promise<string[]> {
    return evalJson<string[]>(this.page, `[...document.querySelectorAll('${FORM} label')].map(l => l.innerText.trim())`);
  }

  /** Rellena los campos indicados (en el orden del formulario). */
  async fill(data: Partial<Record<UserField, string>>): Promise<void> {
    for (const field of ['firstName', 'lastName', 'email', 'password'] as const) {
      if (data[field] !== undefined) await this.page.find(USER_FORM_SEL[field]).fill(data[field]!);
    }
  }

  /** Pulsa "Save" (no espera: según el caso se espera la petición, el toast o la vuelta a la lista). */
  async save(): Promise<void> {
    await this.page.find(USER_FORM_SEL.save).click();
  }

  async cancel(): Promise<void> {
    await this.page.find(USER_FORM_SEL.cancel).click();
  }

  // ── Pestañas ───────────────────────────────────────────────────────────────────

  async tabNames(): Promise<string[]> {
    return evalJson<string[]>(this.page, `[...document.querySelectorAll('${USER_FORM_SEL.tabs}')].map(t => t.innerText.trim())`);
  }

  /** Abre la pestaña Roles o Domains y espera a que cargue su tabla de checkboxes. */
  async openAssignmentTab(kind: AssignmentKind): Promise<void> {
    await this.page.find(USER_FORM_SEL.tab(kind)).click();
    await waitUntil(this.page, `document.querySelector('${USER_FORM_SEL.assignmentInput(kind)}')`, 20_000);
    await this.page.wait(500);
  }

  /** Todos los roles/dominios de la pestaña abierta con su estado. */
  async assignments(kind: AssignmentKind): Promise<Assignment[]> {
    const prefix = ASSIGNMENT_PREFIX[kind];
    return evalJson<Assignment[]>(
      this.page,
      `[...document.querySelectorAll('${USER_FORM_SEL.assignmentInput(kind)}')].map(i => ({ inputId: i.id, itemId: i.id.slice(${prefix.length}), checked: i.checked }))`,
    );
  }

  /** El rol/dominio cuya fila se llama `name` en la pestaña abierta (undefined si no está). */
  async findAssignment(kind: AssignmentKind, name: string): Promise<Assignment | undefined> {
    const inputId = await this.page.evaluate<string>(
      `[...document.querySelectorAll('${USER_FORM_SEL.assignmentInput(kind)}')].find(i => i.closest('[role=row]').querySelector('[role=cell]').innerText.trim() === ${JSON.stringify(name)})?.id ?? ''`,
    );
    if (!inputId) return undefined;
    const checked = await this.page.evaluate<boolean>(`document.getElementById('${inputId}').checked`);
    return { inputId, itemId: inputId.slice(ASSIGNMENT_PREFIX[kind].length), checked };
  }

  /** Pulsa el checkbox (la app guarda el cambio al momento). No espera al resultado. */
  async toggleAssignment(a: Assignment): Promise<void> {
    await this.page.find(`[id="${a.inputId}"]`).click();
  }

  /** Espera a que el checkbox quede marcado/desmarcado. */
  async waitForAssignment(a: Assignment, checked: boolean): Promise<void> {
    await waitUntil(this.page, `document.getElementById('${a.inputId}').checked === ${checked}`);
  }
}
