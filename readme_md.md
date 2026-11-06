# 🚀 QA Automation Suite - DatAscend (`mi-suite-qa`)

Suite de pruebas automatizadas End-to-End (E2E) para la plataforma **DatAscend** (`qa2.datascend.net`), desarrollada en **TypeScript**, **Vitest** y **Vibium** (WebDriver BiDi).

---

## 🛠️ Tecnologías y Arquitectura

- **Lenguaje:** TypeScript
- **Test Runner:** Vitest
- **Navegación / Browser Automation:** Vibium (WebDriver BiDi sobre Chromium)
- **Patrón de diseño:** Modular por funciones (`tests/modules/`) con helpers compartidos (`tests/support/`)
- **Control de Versiones:** Git & GitHub

---

## 📋 Requisitos Previos

Asegúrate de contar con lo siguiente instalado en tu entorno local:

1. **Node.js** (Versión 18 o superior)
2. **npm** (Viene incluido con Node.js)
3. **Git**
4. Navegador **Google Chrome** o Chromium instalado.

---

## 🚀 Instalación y Configuración Inicial

### 1. Clonar el Repositorio
```powershell
git clone https://github.com/FabianD433/mi-suite-qa.git
cd mi-suite-qa
```

### 2. Instalar Dependencias
```powershell
npm install
```

### 3. Configurar Variables de Entorno (`.env`)
Crea un archivo `.env` en la raíz del proyecto (al mismo nivel que `package.json`) y agrega las credenciales de acceso a QA:

```env
DATASCEND_URL=https://qa2.datascend.net
DATASCEND_USER=tu_usuario@dominio.com
DATASCEND_PASS=tu_contraseña
# NOTIFICATIONS_DESTRUCTIVE=false # Cambiar a true solo para pruebas destructivas reales
```

---

## 🧪 Ejecución de Pruebas

### 🟢 Ejecutar Toda la Suite de Pruebas
Ejecuta todos los módulos automatizados (`auth`, `settings`, `dashboard`, `notifications`, `users`):

```powershell
npx vitest run
```

---

### 🔍 Ejecutar un Módulo Específico
Si deseas validar únicamente una sección del sistema:

- **Módulo de Usuarios:**
  ```powershell
  npx vitest run tests/users/users.spec.ts
  ```
- **Módulo de Settings:**
  ```powershell
  npx vitest run tests/settings/settings.spec.ts
  ```
- **Módulo de Notifications:**
  ```powershell
  npx vitest run tests/notifications/notifications.spec.ts
  ```
- **Módulo de Dashboard:**
  ```powershell
  npx vitest run tests/dashboard/dashboard.spec.ts
  ```
- **Módulo de Login / Auth:**
  ```powershell
  npx vitest run tests/login.spec.ts
  ```

---

### 🖥️ Modo Interfaz Gráfica (Vitest UI)
Abre un dashboard interactivo en el navegador para ver los tiempos de ejecución, logs y correr pruebas bajo demanda:

```powershell
npx vitest --ui
```
*Nota: Si solicita autenticación en el navegador, copia la URL con el token que se despliega en la consola (ej. `http://localhost:51204/__vitest__/?token=...`).*

---

## 📂 Estructura del Proyecto

```text
mi-suite-qa/
├── tests/
│   ├── auth/           # Pruebas de autenticación y sesiones
│   ├── dashboard/      # Pruebas de widgets y navegación principal
│   ├── notifications/  # Pruebas de drawer, permisos y peticiones API
│   ├── settings/       # Pruebas de perfil, i18n, dark mode y zonas horarias
│   ├── users/          # Pruebas del ciclo de vida de usuarios (CRUD, inactivación)
│   └── support/        # Helpers compartidos (datascend.ts, auth, selecciones DOM)
├── .env                # Variables de entorno local (credenciales/URLs)
├── package.json        # Dependencias y scripts del proyecto
└── vitest.config.ts    # Configuración principal de Vitest y Vibium
```

---

## 🌐 Flujo de Trabajo Git (Paso a Paso)

Para registrar y actualizar los cambios en el repositorio remoto:

1. **Revisar estado de cambios:**
   ```powershell
   git status
   ```

2. **Preparar todos los archivos nuevos/modificados:**
   ```powershell
   git add .
   ```

3. **Crear el commit con mensaje descriptivo:**
   ```powershell
   git commit -m "feat: agregar nuevas pruebas automatizadas del módulo X"
   ```

4. **Enviar los cambios a GitHub:**
   ```powershell
   git push origin main
   ```