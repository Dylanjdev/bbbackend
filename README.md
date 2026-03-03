# BB Backend

Express backend for checkout + admin menu management synced with Square.

## 1) Install

```bash
npm install
```

## 2) Configure env

Copy `.env.example` to `.env` and fill every required value.

```bash
cp .env.example .env
```

Required values:

- `SQUARE_ACCESS_TOKEN`
- `SQUARE_ENVIRONMENT` (`sandbox` or `production`)
- `SQUARE_LOCATION_ID`
- `FRONTEND_ORIGIN` (comma-separated list, e.g. `http://localhost:5173,https://yourdomain.com`)
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_JWT_SECRET` (long random string)

Optional tax values:

- `STATE_TAX_PERCENT`
- `TOWN_TAX_PERCENT`
- `SALES_TAX_PERCENT`

## 3) Run

```bash
npm start
```

Server default: `http://localhost:3001`

## 4) API endpoints

### Public

- `POST /create-checkout`
- `GET /menu`

### Admin auth

- `POST /admin/login`
	- body: `{ "username": "...", "password": "..." }`
	- returns: `{ "token": "..." }`

### Admin menu (Bearer token required)

- `GET /admin/items`
- `POST /admin/items`
	- body:
		```json
		{
			"name": "Blueberry Muffin",
			"description": "Fresh baked",
			"categoryId": null,
			"variations": [
				{ "name": "Regular", "priceAmount": 450, "currency": "USD" }
			]
		}
		```
- `PATCH /admin/items/:itemId`
	- same body shape as create
- `DELETE /admin/items/:itemId`

## 5) Frontend wiring

- Set frontend env `VITE_API_URL=http://localhost:3001`
- Build admin UI login form calling `POST /admin/login`
- Store token (memory/sessionStorage), send `Authorization: Bearer <token>` on `/admin/*` routes
- Use `GET /menu` for your public storefront menu source
