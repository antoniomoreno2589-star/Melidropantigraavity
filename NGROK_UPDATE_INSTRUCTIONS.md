# 🔧 Actualizar Ngrok - Instrucciones

## ✅ Ngrok Reiniciado Exitosamente

### Nueva URL Pública:
```
https://armigeral-doltishly-laurinda.ngrok-free.dev
```

---

## 📝 Pasos para Actualizar MercadoLibre

### 1. **Ir a MercadoLibre Developers**
- Abre: https://developers.mercadolibre.com.mx/
- Inicia sesión con tu cuenta

### 2. **Seleccionar tu Aplicación**
- Ve a "Mis Aplicaciones"
- Click en tu aplicación (probablemente se llama "MeliDrop" o similar)

### 3. **Actualizar Redirect URI**
- Busca la sección **"Redirect URI"** o **"URL de redirección"**
- Reemplaza la URL antigua con la nueva:
  ```
  https://armigeral-doltishly-laurinda.ngrok-free.dev/auth/callback
  ```
- **Guarda los cambios**

### 4. **Actualizar Notification URL (Opcional)**
Si tienes configurada una URL de notificaciones, actualízala también:
```
https://armigeral-doltishly-laurinda.ngrok-free.dev/api/notifications
```

---

## 🔄 Reconectar MercadoLibre en la App

### Opción A: Desde la Configuración
1. Ve a `http://localhost:3000/configuracion`
2. En la sección "MercadoLibre"
3. Click en **"Desconectar"** (si está conectado)
4. Click en **"Conectar con MercadoLibre"**
5. Autoriza la aplicación nuevamente

### Opción B: Limpiar Credenciales y Reconectar
1. Abre la consola del navegador (F12)
2. Ve a la pestaña **"Application"** o **"Almacenamiento"**
3. En **"Local Storage"** → `http://localhost:3000`
4. Elimina la clave `melidrop_meli_credentials`
5. Recarga la página
6. Inicia sesión nuevamente

---

## ⚠️ Importante

### Ngrok Gratuito - Limitaciones:
- ✅ El túnel está activo ahora
- ⚠️ Se desconectará si cierras la terminal
- ⚠️ La URL cambiará si reinicias ngrok
- ⚠️ Tiene límite de 40 conexiones/minuto

### Para Mantener Ngrok Activo:
- **NO cierres** la ventana de PowerShell donde está corriendo ngrok
- Si necesitas cerrarla, tendrás que repetir este proceso

### Alternativa - Ngrok Permanente:
Si quieres una URL fija que no cambie:
1. Crea una cuenta en https://ngrok.com
2. Obtén tu authtoken
3. Ejecuta: `.\ngrok.exe config add-authtoken TU_TOKEN`
4. Usa un dominio reservado (requiere plan de pago)

---

## 🚀 Verificar que Todo Funciona

### 1. Verificar Ngrok
- Abre: http://localhost:4040
- Deberías ver el dashboard de ngrok
- Verifica que las peticiones aparezcan aquí

### 2. Probar la Conexión
1. Ve a `http://localhost:3000`
2. Intenta conectar con MercadoLibre
3. Deberías ser redirigido correctamente

### 3. Verificar Mensajería
1. Una vez conectado, ve a `/mensajeria`
2. Verifica que:
   - ✅ Las imágenes de productos aparezcan
   - ✅ Las ventas estén ordenadas por más recientes
   - ✅ No haya errores en consola

---

## 🐛 Solución de Problemas

### Si el error persiste:
1. **Verifica que ngrok esté corriendo:**
   ```powershell
   # En otra terminal
   curl http://localhost:4040/api/tunnels
   ```

2. **Verifica que el servidor de desarrollo esté corriendo:**
   - Debe estar en `http://localhost:3000`
   - Verifica en la terminal donde ejecutaste `npm run dev`

3. **Limpia caché del navegador:**
   - Ctrl + Shift + Delete
   - Elimina caché y cookies
   - Recarga la página

### Si ngrok se cierra:
1. Vuelve a ejecutar:
   ```powershell
   cd c:\Users\huawei\Downloads\melidrop
   .\ngrok.exe http 3000
   ```
2. Obtén la nueva URL
3. Actualiza en MercadoLibre Developers

---

## 📊 Estado Actual

- ✅ Ngrok corriendo
- ✅ URL pública: `https://armigeral-doltishly-laurinda.ngrok-free.dev`
- ✅ Servidor dev corriendo en `http://localhost:3000`
- ⏳ Pendiente: Actualizar Redirect URI en MercadoLibre
- ⏳ Pendiente: Reconectar cuenta de MercadoLibre

---

## 🎯 Siguiente Paso

**Actualiza la Redirect URI en MercadoLibre Developers ahora:**
1. https://developers.mercadolibre.com.mx/
2. Mis Aplicaciones → Tu App
3. Redirect URI: `https://armigeral-doltishly-laurinda.ngrok-free.dev/auth/callback`
4. Guardar

Después de eso, podrás reconectar tu cuenta y verificar las imágenes y el ordenamiento en la mensajería.
