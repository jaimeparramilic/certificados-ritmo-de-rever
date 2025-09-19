# Generador de Certificados PDF para Shopify

Esta es una aplicación independiente de Node.js y Express diseñada para conectarse a una tienda de Shopify y generar Certificados de Autenticidad en formato PDF para los productos de una orden específica.

---

## Características

* **Interfaz Sencilla**: Una página principal para generar certificados a partir de un número de orden y el nombre del titular.
* **Endpoint para Links Directos**: Una ruta (`/order-pdf`) que permite generar PDFs a través de una URL, ideal para integraciones (ej. enviar el link por correo).
* **Autenticación Automática**: Maneja el flujo de autenticación OAuth de Shopify para obtener y guardar un token de acceso offline de forma segura en una base de datos SQLite.
* **Generación Dinámica de PDF**:
    * Crea un certificado por cada unidad de producto en la orden.
    * Genera un código de autenticidad único y determinístico para cada certificado.
    * Incluye la imagen del producto.
    * Añade un código QR que enlaza a una URL de verificación.

---

## Requisitos

* Node.js (versión 18 o superior)
* Una tienda de Shopify y credenciales de una App privada o custom.

---

## Configuración

Antes de arrancar la aplicación, es necesario configurar las variables de entorno.

1.  Crea un archivo llamado `.env` en la raíz del proyecto.
2.  Copia y pega el siguiente contenido, reemplazando los valores de ejemplo con tus datos reales.

    ```ini
    # ============== Credenciales de Shopify ==============
    # Obtenidas desde el panel de partners de Shopify para tu app
    SHOPIFY_API_KEY=tu_api_key_de_shopify
    SHOPIFY_API_SECRET=tu_api_secret_de_shopify
    SHOPIFY_SCOPES=read_products,read_orders
    DEFAULT_SHOP=tu-tienda.myshopify.com

    # ============== Configuración de la Aplicación ==============
    # URL pública para que Shopify pueda comunicarse (ej. ngrok, o tu URL de producción)
    SHOPIFY_APP_HOST=[https://tu-url-publica.com](https://tu-url-publica.com)

    # Puerto para correr el servidor localmente
    PORT=3001

    # Ruta para la base de datos de sesiones de Shopify
    SESSION_DB_PATH=./tmp/shopify_sessions.sqlite

    # ============== Personalización de Certificados ==============
    BRAND_NAME="Nombre de tu Marca"
    VERIFY_BASE=[https://tu-dominio.com/verificacion](https://tu-dominio.com/verificacion)
    ```

---

## Instalación

1.  Clona el repositorio.
2.  Instala las dependencias:
    ```bash
    npm install
    ```

---

## Uso

1.  **Iniciar el servidor local**:
    ```bash
    npm start
    ```
    La aplicación estará disponible en `http://localhost:3001`.

2.  **Generar desde la Interfaz**:
    * Abre `http://localhost:3001` en tu navegador.
    * Si es la primera vez, la aplicación te redirigirá a Shopify para que autorices la conexión.
    * Una vez autorizado, ingresa un número de orden (ej. `#1001`) y un nombre de titular para descargar el PDF.

3.  **Generar desde un Link Directo**:
    Puedes construir una URL para generar el PDF directamente. Esto es útil para enviar por correo o usar en otras integraciones.

    * **Por número de orden**:
        `/order-pdf?order_name=%231001&titular=Nombre%20Apellido`
    * **Por ID de orden**:
        `/order-pdf?order_id=1234567890&titular=Nombre%20Apellido`