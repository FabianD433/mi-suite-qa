/**
 * Page Object del componente TreeSelect de PrimeReact (`.p-treeselect`).
 *
 * Unifica la lógica que antes estaba duplicada en `selectTreeOption` (tests/support/datascend.ts) y
 * `pickTreeOption` (tests/users/users.spec.ts). Garantiza que, tras elegir una opción, el panel
 * desplegable quede cerrado: si el panel sigue abierto se superpone a otros controles (p. ej. el
 * botón "Apply Filters" del drawer de filtros) y Vibium falla con
 * `receivesEvents check failed — element is obscured`.
 */
import { evalJson, waitEnabled, waitUntil, type Page } from '../datascend';

export interface TreeSelectOptions {
  /**
   * Elemento "neutro" (sin acción propia) sobre el que hacer clic para cerrar el panel cuando no se
   * cierra solo, p. ej. el título de un drawer. Un clic fuera cierra el overlay de PrimeReact sin
   * cerrar el drawer/modal contenedor. Si no se indica, se usa la tecla Escape.
   */
  dismissTarget?: string;
}

export class TreeSelect {
  /** Panel desplegable (se monta en `body`, fuera del componente). */
  static readonly PANEL = '.p-treeselect-panel';
  /** Opciones del panel. */
  static readonly ITEM = `${TreeSelect.PANEL} li[role=treeitem]`;

  /** Selector de la opción con ese `aria-label` (PrimeReact lo rellena con el texto de la opción). */
  static option(label: string): string {
    return `${TreeSelect.PANEL} li[aria-label="${label}"]`;
  }

  /**
   * @param root Selector del contenedor `.p-treeselect` (o de un elemento que lo contenga).
   */
  constructor(
    private readonly page: Page,
    readonly root: string,
    private readonly options: TreeSelectOptions = {},
  ) {}

  get trigger(): string {
    return `${this.root} .p-treeselect-trigger`;
  }

  get labelSelector(): string {
    return `${this.root} .p-treeselect-label`;
  }

  /** ¿Hay algún panel de TreeSelect abierto? (solo puede haber uno a la vez). */
  async isOpen(): Promise<boolean> {
    return this.page.evaluate<boolean>(`!!document.querySelector('${TreeSelect.PANEL}')`);
  }

  /** Texto mostrado en el control (opción seleccionada o placeholder). */
  async label(): Promise<string> {
    return this.page.evaluate<string>(`document.querySelector('${this.labelSelector}')?.innerText.trim() ?? ''`);
  }

  /** Espera a que el control esté habilitado y abre su panel (no hace nada si ya está abierto). */
  async open(): Promise<void> {
    await waitEnabled(this.page, this.root);
    if (!(await this.isOpen())) await this.page.find(this.trigger).click();
    await waitUntil(this.page, `document.querySelector('${TreeSelect.ITEM}')`);
  }

  /** Abre el panel y devuelve las opciones visibles (sus `aria-label`). */
  async getOptions(): Promise<string[]> {
    await this.open();
    return evalJson<string[]>(this.page, `[...document.querySelectorAll('${TreeSelect.ITEM}')].map(li => li.getAttribute('aria-label'))`);
  }

  /**
   * Elige la opción `label` (por `aria-label` o, en su defecto, por texto exacto), espera a que el
   * control la muestre y cierra el panel. Si ya está seleccionada no hace clic: PrimeReact
   * deselecciona al pulsar la opción activa.
   */
  async select(label: string): Promise<void> {
    if ((await this.label()) === label) {
      await this.close();
      return;
    }
    await this.open();
    const byAria = `${TreeSelect.option(label)} .p-treenode-content`;
    const byText = {
      xpath: `//div[contains(@class,'p-treeselect-panel')]//*[contains(@class,'p-treenode-content')][normalize-space(.)='${label}']`,
    };
    const textMatch = `[...document.querySelectorAll('${TreeSelect.PANEL} .p-treenode-content')].some(e => e.innerText.trim() === ${JSON.stringify(label)})`;
    await waitUntil(this.page, `document.querySelector('${byAria}') || ${textMatch}`);
    if (await this.page.evaluate<boolean>(`!!document.querySelector('${byAria}')`)) {
      await this.page.find(byAria).click();
    } else {
      await this.page.find(byText).click();
    }
    await waitUntil(this.page, `document.querySelector('${this.labelSelector}')?.innerText.includes(${JSON.stringify(label)})`);
    await this.close();
  }

  /**
   * Cierra el panel si sigue abierto. Primero da margen a que se cierre solo (lo normal tras
   * seleccionar); si no, hace clic en `dismissTarget` o pulsa Escape, y espera a que se desmonte.
   */
  async close(): Promise<void> {
    if (!(await this.isOpen())) return;
    const closed = `!document.querySelector('${TreeSelect.PANEL}')`;
    try {
      await waitUntil(this.page, closed, 1_500);
      return;
    } catch {
      /* sigue abierto: cerrarlo explícitamente */
    }
    if (this.options.dismissTarget) {
      await this.page.find(this.options.dismissTarget).click();
    } else {
      await this.page.keyboard.press('Escape');
    }
    await waitUntil(this.page, closed, 5_000);
    await this.page.wait(300); // animación de salida del overlay
  }
}
