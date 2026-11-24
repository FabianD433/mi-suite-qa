/**
 * Page Object del listado Settings › Users (`/settings/users`): tabla, menú contextual ⋮ de cada
 * fila, paginación y el modal de borrado/inactivación de usuarios.
 *
 * Extraído de tests/users/users.spec.ts (`U.*`, `goToUsers`, `waitForList`, `renderedRows`,
 * `openRowMenu`, `closeRowMenu`, `waitForRowState`, `openDeleteModal`, `pickReassignUser`, helpers de
 * paginación). El drawer de filtros es FilterDrawer y el formulario de usuario, UserFormPage.
 *
 * Esperas de red: si la página registra sus peticiones en `window.__reqs` (`{ method, url, status }`,
 * status 0 mientras está pendiente; ver TRACK en users.spec.ts), las esperas de carga exigen además
 * que no quede ninguna petición de listado de usuarios pendiente. Sin ese registro se omite ese
 * criterio.
 */
import {
  evalJson,
  pollEvaluate,
  waitForOverlaysClosed,
  waitUntil,
  waitUntilClickable,
  type Page,
} from '../datascend';
import { navigate } from '../session';
import { AppShell, type Language } from './AppShell';
import { ConfirmModal, MODAL_SEL } from './ConfirmModal';
import { UserFormPage } from './UserFormPage';
import { TreeSelect } from './TreeSelect';

const MENU = '[data-testid="button-menu.menu"]';
const PAG_LABEL = '.custom-pagination__section:last-child .custom-pagination__label';

export const USERS_SEL = {
  subheader: '[data-testid="layout.main.subheader"]',
  addUser: '[data-testid="layout.main.subheader.actions"] button.btn-primary',
  content: '[data-testid="layout.main.content"]',
  row: '.rdt_TableRow',
  headerCol: '.rdt_TableCol',
  /** Botón ⋮ de una fila y menú que despliega. */
  rowMenuBtn: '[data-testid="button-menu"]',
  menu: MENU,
  menuItem: `${MENU} [role=menuitem]`,
  // Ítems del menú ⋮ por tipo (independiente del idioma)
  menuEdit: `${MENU} [role=menuitem] a[href*="/settings/users/edit/"]`,
  menuDelete: `${MENU} [role=menuitem] button.btn-outline-danger`,
  menuActivate: `${MENU} [role=menuitem] button.btn-outline-success`,
  pagSelect: '.custom-pagination__select',
  pagLabel: PAG_LABEL,
  prev: '.custom-pagination__btn[aria-label="Previous Page"]',
  next: '.custom-pagination__btn[aria-label="Next Page"]',
  sidebarLink: '[data-testid="sidebar"] a.nav-link.active[href="/settings/users"]',
  /** Fila de un usuario y el enlace de su nombre (abre la edición). */
  rowOf: (id: string) => `[id="row-${id}"]`,
  nameLink: (id: string) => `[id="row-${id}"] [id^="cell-first_name-"] a`,
} as const;

export interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  inactive: boolean;
}

/** Ninguna petición GET del listado de usuarios pendiente (si la página las registra). */
const NO_PENDING_LIST = `!(window.__reqs ?? []).some(r => r.method === 'GET' && r.url.includes('/api/v1/users/?') && r.status === 0)`;
/**
 * Texto del indicador de paginación ("1-10 of 12"). Al cambiar de página el indicador puede no existir
 * un instante: se devuelve '' en vez de fallar con `Cannot read properties of null`.
 */
const PAG_LABEL_TEXT = `document.querySelector('${PAG_LABEL}')?.innerText?.trim() ?? ''`;

export class UsersListPage {
  static readonly SEL = USERS_SEL;
  static readonly PATH = '/settings/users';

  constructor(private readonly page: Page) {}

  /** Carga el listado (con `query` opcional, p. ej. '?page=2') y espera a la tabla. */
  async goto(query = ''): Promise<void> {
    await navigate(this.page, `${UsersListPage.PATH}${query}`);
    await this.waitForLoaded();
  }

  /** Espera a que la tabla termine de cargar (paginación y filas, sin listado pendiente). */
  async waitForLoaded(): Promise<void> {
    await waitUntil(this.page, `document.querySelector('${PAG_LABEL}') && document.querySelector('${USERS_SEL.row}')`, 20_000);
    await waitUntil(this.page, NO_PENDING_LIST);
    await this.page.wait(500);
  }

  /** Primera línea del subheader ("Users" / "Usuarios"). */
  async title(): Promise<string> {
    return this.page.evaluate<string>(`document.querySelector('${USERS_SEL.subheader}')?.innerText.split('\\n')[0].trim() ?? ''`);
  }

  /** Espera a que el título del subheader empiece por `title` (p. ej. tras cambiar de idioma). */
  async waitForTitle(title: string, timeout?: number): Promise<void> {
    await waitUntil(this.page, `document.querySelector('${USERS_SEL.subheader}')?.innerText?.trim().startsWith(${JSON.stringify(title)})`, timeout);
  }

  /**
   * Cambia el idioma desde la cabecera y espera a que el listado esté traducido (se guarda en el
   * perfil del usuario: restaurar BASELINE al terminar).
   */
  async switchLanguage(lang: Language): Promise<void> {
    const title = lang === 'es' ? 'Usuarios' : 'Users';
    await new AppShell(this.page).switchLanguage(lang, {
      until: `document.querySelector('${USERS_SEL.subheader}')?.innerText.trim().startsWith('${title}')`,
    });
    await this.page.wait(500);
  }

  /** Pulsa "Add User" y espera al formulario de creación. */
  async clickAddUser(): Promise<UserFormPage> {
    await this.page.find(USERS_SEL.addUser).click();
    const form = new UserFormPage(this.page);
    await form.waitForCreate();
    return form;
  }

  // ── Tabla ──────────────────────────────────────────────────────────────────────

  /** Títulos de las columnas (sin los indicadores de orden ▲▼). */
  async columnHeaders(): Promise<string[]> {
    return evalJson<string[]>(this.page, `[...document.querySelectorAll('${USERS_SEL.headerCol}')].map(c => c.innerText.replace(/[▲▼]/g, '').trim())`);
  }

  /**
   * Filas visibles. Con `expectedCount`, espera a que la tabla tenga exactamente ese número de filas
   * (tras cambiar de página se re-renderiza y puede mostrar un estado intermedio).
   */
  async rows(expectedCount?: number): Promise<UserRow[]> {
    if (expectedCount !== undefined) {
      await waitUntil(this.page, `document.querySelectorAll('${USERS_SEL.row}').length === ${expectedCount}`);
    }
    return evalJson<UserRow[]>(
      this.page,
      `[...document.querySelectorAll('${USERS_SEL.row}')].map(r => ({
        id: r.id.replace(/^row-/, ''),
        firstName: r.querySelector('[id^="cell-first_name-"]')?.innerText.trim() ?? '',
        lastName: r.querySelector('[id^="cell-last_name-"]')?.innerText.trim() ?? '',
        email: r.querySelector('[id^="cell-email-"]')?.innerText.trim() ?? '',
        inactive: r.classList.contains('inactive-row'),
      }))`,
    );
  }

  async hasRow(userId: string): Promise<boolean> {
    return this.page.evaluate<boolean>(`!!document.querySelector('${USERS_SEL.rowOf(userId)}')`);
  }

  async waitForRowGone(userId: string, timeout?: number): Promise<void> {
    await waitUntil(this.page, `!document.querySelector('${USERS_SEL.rowOf(userId)}')`, timeout);
  }

  /** Estado visual de la fila: clase `inactive-row` y opacidad de la celda de email. */
  async rowStyle(userId: string): Promise<{ cls: boolean; opacity: number }> {
    const row = USERS_SEL.rowOf(userId);
    return evalJson(
      this.page,
      `{ cls: document.querySelector('${row}').classList.contains('inactive-row'),
         opacity: Number(getComputedStyle(document.querySelector('${row} [id^="cell-email-"]')).opacity) }`,
    );
  }

  /** Número de filas, cuántas tienen botón ⋮ y si todos esos botones caben en el viewport. */
  async rowActionsLayout(): Promise<{ rows: number; withMenu: number; inViewport: boolean }> {
    return evalJson(
      this.page,
      `(() => { const rows = [...document.querySelectorAll('${USERS_SEL.row}')];
        const btns = rows.map(r => r.querySelector('${USERS_SEL.rowMenuBtn}')).filter(Boolean);
        return { rows: rows.length, withMenu: btns.length,
          inViewport: btns.every(b => { const x = b.getBoundingClientRect(); return x.width > 0 && x.right <= innerWidth; }) }; })()`,
    );
  }

  /** Abre la edición haciendo clic en el nombre (navegación SPA, como el usuario). */
  async openEdit(userId: string): Promise<UserFormPage> {
    await this.page.find(USERS_SEL.nameLink(userId)).click();
    const form = new UserFormPage(this.page);
    await form.waitForEdit(userId);
    return form;
  }

  // ── Menú ⋮ ─────────────────────────────────────────────────────────────────────

  /** Abre el menú ⋮ de la fila y devuelve el texto de sus opciones. */
  async openRowMenu(userId: string): Promise<string[]> {
    const btn = `${USERS_SEL.rowOf(userId)} ${USERS_SEL.rowMenuBtn}`;
    // Un drawer/modal que aún se está cerrando tapa la columna de acciones (receivesEvents → obscured).
    await waitForOverlaysClosed(this.page);
    await waitUntilClickable(this.page, btn);
    await this.page.find(btn).click();
    await waitUntil(this.page, `document.querySelector('${USERS_SEL.menuItem}')`);
    return evalJson<string[]>(this.page, `[...document.querySelectorAll('${USERS_SEL.menuItem}')].map(e => e.innerText.trim())`);
  }

  async closeRowMenu(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await waitUntil(this.page, `!document.querySelector('${MENU}')`).catch(async () => {
      await this.page.find(USERS_SEL.content).click();
      await waitUntil(this.page, `!document.querySelector('${MENU}')`);
    });
  }

  /** ¿El menú abierto tiene esa acción? */
  async hasMenuAction(action: 'edit' | 'delete' | 'activate'): Promise<boolean> {
    return this.page.evaluate<boolean>(`!!document.querySelector('${this.menuAction(action)}')`);
  }

  menuAction(action: 'edit' | 'delete' | 'activate'): string {
    return { edit: USERS_SEL.menuEdit, delete: USERS_SEL.menuDelete, activate: USERS_SEL.menuActivate }[action];
  }

  /** `href` de "Edit" en el menú abierto. */
  async editHref(): Promise<string | null> {
    return this.page.find(USERS_SEL.menuEdit).attr('href');
  }

  /** Pulsa "Edit" en el menú ⋮ de la fila y espera al formulario de edición. */
  async editFromMenu(userId: string): Promise<UserFormPage> {
    await this.openRowMenu(userId);
    await this.page.find(USERS_SEL.menuEdit).click();
    const form = new UserFormPage(this.page);
    await form.waitForEdit(userId, 'firstName');
    return form;
  }

  /**
   * Espera a que la fila refleje el estado activo/inactivo (clase, opacidad y acción del menú ⋮).
   * Tras activar/inactivar, la tabla puede seguir mostrando el estado anterior hasta que termina de
   * recargar: se reabre el menú hasta que ofrezca la acción esperada (Delete si activo, Activate si no).
   * Devuelve los textos del menú, que queda abierto.
   */
  async waitForRowState(userId: string, active: boolean, timeout = 30_000): Promise<string[]> {
    const row = USERS_SEL.rowOf(userId);
    await waitUntil(
      this.page,
      `(() => { const r = document.querySelector('${row}'); if (!r) return false;
        const op = Number(getComputedStyle(r.querySelector('[id^="cell-email-"]')).opacity);
        return r.classList.contains('inactive-row') === ${!active} && (${active} ? op === 1 : op < 1); })()`,
      timeout,
    );
    const action = active ? 'delete' : 'activate';
    const end = Date.now() + timeout;
    for (;;) {
      const items = await this.openRowMenu(userId);
      if (await this.hasMenuAction(action)) return items;
      if (Date.now() > end) throw new Error(`El menú ⋮ de ${userId} no muestra la acción esperada: ${items.join(', ')}`);
      await this.closeRowMenu();
      await this.page.wait(1000);
    }
  }

  /** Abre el modal de borrado desde el menú ⋮ ("Delete") y espera a sus opciones. */
  async openDeleteModal(userId: string): Promise<DeleteUserModal> {
    await this.openRowMenu(userId);
    await this.page.find(USERS_SEL.menuDelete).click();
    const modal = new DeleteUserModal(this.page);
    await waitUntil(this.page, `document.querySelector('${DELETE_SEL.softCard}')`);
    return modal;
  }

  /**
   * Pulsa "Activate" en el menú ⋮ ya abierto (con el texto `label` si se indica, para esperar a que esté
   * traducido) y devuelve el modal de confirmación.
   */
  async clickActivate(label?: string): Promise<ConfirmModal> {
    if (label) {
      await waitUntil(this.page, `document.querySelector('${USERS_SEL.menuActivate}')?.innerText.trim() === ${JSON.stringify(label)}`);
    }
    await this.page.find(USERS_SEL.menuActivate).click();
    return new ConfirmModal(this.page);
  }

  // ── Paginación ─────────────────────────────────────────────────────────────────

  /** Opciones de "Rows per page". */
  async pageSizeOptions(): Promise<string[]> {
    return evalJson<string[]>(this.page, `[...document.querySelectorAll('${USERS_SEL.pagSelect} option')].map(o => o.value)`);
  }

  /** Texto del indicador de paginación ('' si aún no está renderizado). */
  async paginationLabel(): Promise<string> {
    return this.page.evaluate<string>(PAG_LABEL_TEXT);
  }

  /**
   * Espera a que el indicador cumpla `expected` (texto exacto o RegExp); si vence, devuelve el último
   * valor leído para que el `expect` muestre el real.
   */
  async paginationLabelEventually(expected: string | RegExp, timeout = 10_000): Promise<string> {
    const done = (v: string) => (typeof expected === 'string' ? v === expected : expected.test(v));
    return pollEvaluate<string>(this.page, PAG_LABEL_TEXT, done, timeout);
  }

  async nextPage(): Promise<void> {
    await this.page.find(USERS_SEL.next).click();
  }

  async prevPage(): Promise<void> {
    await this.page.find(USERS_SEL.prev).click();
  }

  /** ¿Está deshabilitado "<" / ">"? Espera a que la paginación se renderice antes de leerlo. */
  async isPageButtonDisabled(which: 'prev' | 'next'): Promise<boolean> {
    const sel = USERS_SEL[which];
    await waitUntil(this.page, `document.querySelector('${sel}') !== null`);
    return this.page.evaluate<boolean>(`document.querySelector('${sel}')?.disabled === true`);
  }

  /**
   * Espera a que termine un cambio de página: indicador con el rango que empieza en `from`, primera fila
   * igual a `firstRowId` y sin petición de listado pendiente.
   */
  async waitForPageChange(from: number, firstRowId: string): Promise<void> {
    await waitUntil(
      this.page,
      `(${PAG_LABEL_TEXT}).startsWith('${from}-') &&
       document.querySelector('${USERS_SEL.row}')?.id === ${JSON.stringify(`row-${firstRowId}`)} &&
       ${NO_PENDING_LIST}`,
      20_000,
    );
  }
}

// ── Modal de borrado de usuario ──────────────────────────────────────────────────

const REASSIGN = `${MODAL_SEL.root} .delete-user-reassign-container`;

export const DELETE_SEL = {
  container: `${MODAL_SEL.root} .delete-user-modal-container`,
  /** Opciones "Safe Inactivation" (por defecto) y "Permanent Deletion". */
  softCard: `${MODAL_SEL.root} .delete-mode-card:not(.hard-delete)`,
  hardCard: `${MODAL_SEL.root} .delete-mode-card.hard-delete`,
  cardTitle: `${MODAL_SEL.root} .delete-mode-card .card-title`,
  selectedCardTitle: `${MODAL_SEL.root} .delete-mode-card.selected .card-title`,
  /** Selector de usuario al que reasignar los registros (solo con "Permanent Deletion"). */
  reassign: REASSIGN,
  reassignLabel: `${REASSIGN} label`,
  reassignValue: `${REASSIGN} .p-treeselect-label`,
  reassignTrigger: `${REASSIGN} .p-treeselect-trigger`,
  reassignInfo: `${REASSIGN} .smallest`,
} as const;

export interface DeleteModalContent {
  title: string;
  message: string;
  /** Parte en negrita del mensaje (nombre del usuario). */
  bold: string;
  cards: string[];
  selected: string[];
  confirm: string;
}

/** Modal "Delete user?" con las opciones de inactivación segura y borrado permanente. */
export class DeleteUserModal extends ConfirmModal {
  static readonly DELETE_SEL = DELETE_SEL;

  /** Título, mensaje, opciones (y cuál está seleccionada) y texto del botón de acción. */
  async content(): Promise<DeleteModalContent> {
    return evalJson<DeleteModalContent>(
      this.page,
      `{ title: document.querySelector('${MODAL_SEL.title}').innerText.trim(),
         message: document.querySelector('${DELETE_SEL.container} p').innerText.trim(),
         bold: document.querySelector('${DELETE_SEL.container} p strong')?.innerText.trim() ?? '',
         cards: [...document.querySelectorAll('${DELETE_SEL.cardTitle}')].map(c => c.innerText.trim()),
         selected: [...document.querySelectorAll('${DELETE_SEL.selectedCardTitle}')].map(c => c.innerText.trim()),
         confirm: document.querySelector('${MODAL_SEL.danger}')?.innerText.trim() ?? '' }`,
    );
  }

  /** Elige "Permanent Deletion" y espera al selector de reasignación. */
  async choosePermanentDeletion(): Promise<void> {
    await this.page.find(DELETE_SEL.hardCard).click();
    await waitUntil(this.page, `document.querySelector('${REASSIGN}')`);
  }

  /** Espera a que termine la transición CSS del borde de "Permanent Deletion" (rojo). No falla si no llega. */
  async waitForHardCardHighlighted(timeout = 5_000): Promise<void> {
    await waitUntil(
      this.page,
      `(([r, g, b]) => r > 150 && g < 100 && b < 100)(getComputedStyle(document.querySelector('${DELETE_SEL.hardCard}')).borderTopColor.match(/\\d+/g).map(Number))`,
      timeout,
    ).catch(() => {});
  }

  /** Estado de "Permanent Deletion" y textos del bloque de reasignación. */
  async permanentDeletionState(): Promise<{ selected: boolean; border: string; label: string; placeholder: string; info: string; confirm: string }> {
    return evalJson(
      this.page,
      `(() => { const c = document.querySelector('${DELETE_SEL.hardCard}'); const s = getComputedStyle(c);
        return { selected: c.classList.contains('selected'), border: s.borderTopColor,
          label: document.querySelector('${DELETE_SEL.reassignLabel}').innerText.trim(),
          placeholder: document.querySelector('${DELETE_SEL.reassignValue}').innerText.trim(),
          info: document.querySelector('${DELETE_SEL.reassignInfo}').innerText.trim(),
          confirm: document.querySelector('${MODAL_SEL.danger}').innerText.trim() }; })()`,
    );
  }

  /** Usuario elegido en el selector de reasignación (o el placeholder). */
  async reassignValue(): Promise<string> {
    return this.page.find(DELETE_SEL.reassignValue).text();
  }

  /**
   * Selecciona `label` en el TreeSelect de reasignación. Las opciones se cargan de forma asíncrona
   * (GET /api/v1/users) al abrir el panel: se espera a que termine la carga y, si la opción no está
   * en la lista inicial, se busca con el filtro del panel. Reintenta hasta 3 veces.
   */
  async pickReassignUser(label: string): Promise<void> {
    const option = TreeSelect.option(label);
    const exists = (sel: string) => this.page.evaluate<boolean>(`!!document.querySelector('${sel}')`);
    for (let attempt = 1; ; attempt++) {
      if (!(await exists(TreeSelect.PANEL))) await this.page.find(DELETE_SEL.reassignTrigger).click();
      await waitUntil(this.page, `document.querySelector('${TreeSelect.PANEL}')`);
      // Carga terminada: hay opciones y no queda ninguna petición de usuarios pendiente.
      await waitUntil(this.page, `document.querySelectorAll('${TreeSelect.ITEM}').length > 0 && ${NO_PENDING_LIST}`, 20_000);
      if (!(await exists(option))) {
        await this.page.find(`${TreeSelect.PANEL} .p-treeselect-filter`).fill(label);
        await waitUntil(this.page, `document.querySelector('${option}')`, 10_000).catch(() => {});
      }
      if (await exists(option)) {
        await this.page.find(`${option} .p-treenode-content`).click();
        try {
          await waitUntil(this.page, `document.querySelector('${DELETE_SEL.reassignValue}')?.innerText.trim() === ${JSON.stringify(label)}`, 5_000);
          await waitUntil(this.page, `!document.querySelector('${TreeSelect.PANEL}')`, 3_000).catch(() => this.page.keyboard.press('Escape'));
          await this.page.wait(300);
          return;
        } catch {
          /* reintentar */
        }
      }
      if (attempt >= 3) {
        const shown = await evalJson<string[]>(this.page, `[...document.querySelectorAll('${TreeSelect.ITEM}')].map(li => li.getAttribute('aria-label'))`);
        throw new Error(`No se pudo seleccionar "${label}" para reasignar; opciones: ${shown.join(', ')}`);
      }
      await this.page.keyboard.press('Escape');
      await this.page.wait(1000);
    }
  }
}
