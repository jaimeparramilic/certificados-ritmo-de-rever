# ---------------------------------------------------
# --- Dockerfile para una aplicación Node.js en Cloud Run ---
# ---------------------------------------------------

# Paso 1: Usa una imagen base oficial de Node.js que sea ligera y segura.
FROM node:18-slim

# Paso 2: Establece el directorio de trabajo dentro del contenedor.
WORKDIR /app

# Paso 3: Copia los archivos de dependencias.
# Se copian primero para aprovechar el cache de Docker y acelerar futuras compilaciones.
COPY package*.json ./

# Paso 4: Instala SOLAMENTE las dependencias de producción.
RUN npm install --only=production

# Paso 5: Copia el resto de los archivos de tu aplicación (server.js, la carpeta assets, etc.).
COPY . .

# Paso 6: El comando para iniciar tu aplicación cuando el contenedor arranque.
CMD ["node", "server.js"]