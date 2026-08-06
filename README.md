# Köra Skin — Backend

API REST construida con **Node.js**, **Express** y **MySQL** para la gestión integral de un centro de estética/masoterapia: clientas, personal, productos, servicios, atenciones (agenda), ventas y pagos.

Proyecto de título — Técnico en Analista Programador, IPLACEX.

![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql&logoColor=white)
![JWT](https://img.shields.io/badge/Auth-JWT-black?logo=jsonwebtokens&logoColor=white)

## Tabla de contenidos

- [Funcionalidades](#funcionalidades)
- [Tecnologías](#tecnologías)
- [Requisitos previos](#requisitos-previos)
- [Instalación](#instalación)
- [Base de datos](#base-de-datos)
- [Variables de entorno](#variables-de-entorno)
- [Ejecución](#ejecución)
- [Autenticación y roles](#autenticación-y-roles)
- [Documentación de la API](#documentación-de-la-api)
- [Estructura del proyecto](#estructura-del-proyecto)

## Funcionalidades

- **Autenticación** con JWT y contraseñas hasheadas con bcrypt; flujo de "clave temporal + cambio obligatorio" para personal nuevo.
- **Control de acceso por rol**: `administradora`, `vendedora`, `masoterapeuta`, cada endpoint restringido a los roles que corresponden.
- **Clientas**: alta, edición, activar/desactivar.
- **Personal**: alta con clave temporal autogenerada, asignación de roles, activar/desactivar.
- **Productos**: stock, stock mínimo, alerta de stock bajo.
- **Servicios**: catálogo con duración y precio base.
- **Atenciones (agenda)**: registro de hora de inicio/fin calculada según duración de los servicios + tiempo de traslado, con **detección automática de conflictos de horario** por masoterapeuta.
- **Ventas**: descuento de stock transaccional, con reversión de stock si se edita una venta.
- **Pagos** (de venta y de atención): registro de abonos parciales, con cálculo de saldo y estado (`pendiente` / `parcial` / `pagado`).

## Tecnologías

- [Node.js](https://nodejs.org/) + [Express 5](https://expressjs.com/)
- [MySQL 8](https://www.mysql.com/) vía [`mysql2`](https://www.npmjs.com/package/mysql2) (pool de conexiones, queries parametrizadas, transacciones)
- [jsonwebtoken](https://www.npmjs.com/package/jsonwebtoken) + [bcrypt](https://www.npmjs.com/package/bcrypt)
- [dotenv](https://www.npmjs.com/package/dotenv)

## Requisitos previos

- Node.js 18 o superior
- MySQL 8 (local o remoto)

## Instalación

```bash
git clone https://github.com/evillarreals/proyecto_titulo_backend.git
cd proyecto_titulo_backend
npm install
```

## Base de datos

El esquema completo está en [`database/schema.sql`](database/schema.sql). Para crearlo:

```bash
mysql -u root -p -e "CREATE DATABASE kora_skin;"
mysql -u root -p kora_skin < database/schema.sql
```

El script solo crea la estructura de tablas (clientas, personal, productos, servicios, atenciones, ventas, pagos, roles), sin datos. Como mínimo necesitas insertar los roles y un usuario administrador para poder iniciar sesión, por ejemplo:

```sql
INSERT INTO rol (nombre) VALUES ('administradora'), ('vendedora'), ('masoterapeuta');

-- password_hash generado con bcrypt (10 rounds) para la clave "Test1234@"
INSERT INTO personal (nombre, apellido, rut, telefono, email, activo, password_hash, must_change_password)
VALUES ('Admin', 'Prueba', '11111111-1', '+56900000000', 'admin@test.local', 1,
  '$2b$10$sTB8N/8TDl3I69yjxUtELeW0a7JpjJz0q3WQcOVwTs29W.Y/9CgFi', 0);

INSERT INTO rol_personal (id_personal, id_rol)
SELECT p.id_personal, r.id_rol FROM personal p, rol r
WHERE p.email = 'admin@test.local' AND r.nombre IN ('administradora','vendedora','masoterapeuta');
```

Con esto puedes iniciar sesión con `admin@test.local` / `Test1234@`.

## Variables de entorno

Crea un archivo `.env` en la raíz del proyecto:

```env
PORT=3000

DB_HOST=localhost
DB_USER=root
DB_PASSWORD=tu_password
DB_NAME=kora_skin
DB_PORT=3306

JWT_SECRET=una_clave_secreta_larga_y_aleatoria
JWT_EXPIRES_IN=8h
```

| Variable          | Descripción                                             |
| ----------------- | -------------------------------------------------------- |
| `PORT`            | Puerto del servidor (por defecto 3000)                   |
| `DB_HOST`         | Host de MySQL                                             |
| `DB_USER`         | Usuario de MySQL                                           |
| `DB_PASSWORD`     | Password de MySQL                                          |
| `DB_NAME`         | Nombre de la base de datos                                 |
| `DB_PORT`         | Puerto de MySQL (por defecto 3306)                         |
| `JWT_SECRET`      | Clave usada para firmar los tokens JWT                     |
| `JWT_EXPIRES_IN`  | Expiración del token (ej. `8h`)                             |

## Ejecución

```bash
npm run dev    # con nodemon (recarga automática)
npm start      # sin recarga
```

El servidor queda disponible en `http://localhost:3000`. Puedes verificar que todo está conectado con:

```bash
curl http://localhost:3000/health
```

## Autenticación y roles

Todas las rutas (excepto `POST /auth/login`) requieren el header:

```
Authorization: Bearer <token>
```

El token se obtiene en `POST /auth/login` y contiene los roles del usuario. Cada recurso exige uno o más roles:

| Recurso                     | Roles permitidos                              |
| ---------------------------- | ------------------------------------------------ |
| Clientas                     | `masoterapeuta`, `administradora`, `vendedora`    |
| Productos                    | `vendedora`, `administradora`                     |
| Servicios                    | `masoterapeuta`, `administradora`                 |
| Atenciones                   | `masoterapeuta`, `administradora`                 |
| Ventas / Pagos de venta      | `vendedora`, `administradora`                     |
| Pagos de atención            | `masoterapeuta`, `administradora`                 |
| Personal / Roles             | `administradora`                                  |

## Documentación de la API

URL base local: `http://localhost:3000`

### Auth

| Método | Endpoint                | Descripción                          |
| ------ | ------------------------- | -------------------------------------- |
| POST   | `/auth/login`              | Login con `email` + `password`, retorna JWT |
| POST   | `/auth/change-password`    | Cambia la contraseña (requiere token)  |

### Clientas

| Método | Endpoint             | Descripción                        |
| ------ | ---------------------- | ------------------------------------ |
| GET    | `/clientas`             | Lista clientas (`?activo=0\|1` opcional) |
| GET    | `/clientas/:id`         | Obtiene una clienta                  |
| POST   | `/clientas`             | Crea una clienta                     |
| PUT    | `/clientas/:id`         | Actualiza una clienta                |
| PUT    | `/clientas/:id/activo`  | Activa/desactiva una clienta         |

### Productos

| Método | Endpoint                     | Descripción                    |
| ------ | ------------------------------ | --------------------------------- |
| GET    | `/productos`                    | Lista productos                   |
| GET    | `/productos/stock-bajo`         | Productos con stock ≤ stock mínimo |
| GET    | `/productos/:id`                | Obtiene un producto                |
| POST   | `/productos`                    | Crea un producto                   |
| PUT    | `/productos/:id`                | Actualiza un producto              |
| PUT    | `/productos/:id/sumar-stock`    | Suma stock (reposición)            |
| PUT    | `/productos/:id/activar`        | Reactiva un producto               |
| DELETE | `/productos/:id`                | Desactiva (soft-delete) un producto |

### Servicios

| Método | Endpoint                | Descripción             |
| ------ | -------------------------| -------------------------- |
| GET    | `/servicios`              | Lista servicios activos primero |
| GET    | `/servicios/todos`        | Lista todos los servicios |
| GET    | `/servicios/:id`          | Obtiene un servicio        |
| POST   | `/servicios`              | Crea un servicio           |
| PUT    | `/servicios/:id`          | Actualiza un servicio      |
| PUT    | `/servicios/:id/activar`  | Reactiva un servicio       |
| DELETE | `/servicios/:id`          | Desactiva un servicio      |

### Atenciones

| Método | Endpoint                    | Descripción                                          |
| ------ | ------------------------------| --------------------------------------------------------|
| GET    | `/atenciones`                  | Lista todas las atenciones                              |
| GET    | `/atenciones/:id`               | Detalle (servicios aplicados + pagos + saldo)            |
| POST   | `/atenciones`                   | Crea una atención (valida conflicto de horario)          |
| PUT    | `/atenciones/:id`                | Actualiza una atención (revalida conflicto de horario)   |
| PATCH  | `/atenciones/:id/estado`         | Cambia estado: `pendiente` / `realizada` / `cancelada`   |

```http
POST /atenciones
Content-Type: application/json
Authorization: Bearer <token>

{
  "id_clienta": 6,
  "id_personal": 13,
  "fecha_inicio": "2026-08-10 10:00:00",
  "traslado_min": 10,
  "servicios": [{ "id_servicio": 6, "precio_aplicado": 30000 }]
}
```

Si el masoterapeuta ya tiene otra atención que se cruza con el bloque de horario (incluyendo el traslado), responde `409 Conflict`.

### Ventas

| Método | Endpoint          | Descripción                                     |
| ------ | ------------------- | -------------------------------------------------- |
| GET    | `/ventas`             | Lista ventas                                       |
| GET    | `/ventas/:id`          | Detalle (items + pagos + saldo)                     |
| POST   | `/ventas`              | Crea una venta (descuenta stock, valida vendedora)  |
| PUT    | `/ventas/:id`           | Actualiza una venta (revierte y reaplica stock)      |

### Pagos

| Método | Endpoint                       | Descripción                  |
| ------ | --------------------------------| -------------------------------|
| POST   | `/pagos-venta`                   | Registra un abono a una venta   |
| GET    | `/pagos-venta/:id_venta`          | Lista pagos de una venta        |
| POST   | `/pagos-atencion`                 | Registra un abono a una atención|
| GET    | `/pagos-atencion/:id_atencion`     | Lista pagos de una atención     |

### Personal y Roles

| Método | Endpoint                | Descripción                                        |
| ------ | -------------------------| ------------------------------------------------------|
| GET    | `/personal`                | Lista personal con sus roles                          |
| GET    | `/personal/:id`             | Obtiene un miembro del personal                        |
| POST   | `/personal`                  | Crea personal + roles, genera clave temporal            |
| PUT    | `/personal/:id`               | Actualiza datos                                         |
| PUT    | `/personal/:id/roles`          | Reemplaza los roles asignados                            |
| PUT    | `/personal/:id/activar`         | Reactiva                                                 |
| DELETE | `/personal/:id`                  | Desactiva                                                |
| GET    | `/roles`                          | Lista roles                                              |
| POST   | `/roles`                           | Crea un rol                                              |
| PUT    | `/roles/:id`                        | Actualiza un rol                                         |

## Estructura del proyecto

```
backend/
├── app.js                     # Punto de entrada: Express, middlewares, rutas
├── config/
│   └── db.js                  # Pool de conexión MySQL (mysql2)
├── middlewares/
│   └── auth.js                # Middleware de JWT y control por rol
├── database/
│   └── schema.sql              # Esquema de la base de datos
└── routes/
    ├── auth.js
    ├── clientas.js
    ├── productos.js
    ├── servicios.js
    ├── atenciones.js
    ├── ventas.js
    ├── pagosVenta.js
    ├── pagosAtencion.js
    ├── personal.js
    ├── roles.js
    └── health.js
```

---

Desarrollado por **Esteban Villarreal** como Proyecto de Título — IPLACEX.
