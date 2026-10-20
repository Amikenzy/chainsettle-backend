# API Keys — Machine-to-Machine Authentication

API keys give automated integrations (CI pipelines, backend services, monitoring scripts) a stable credential that does not require a Stellar wallet or interactive login. Each key is scoped to a single user account and carries either read-only or full read/write access.

---

## Table of Contents

- [Concepts](#concepts)
- [Managing Keys (JWT Required)](#managing-keys-jwt-required)
  - [Create a Key](#create-a-key)
  - [List Keys](#list-keys)
  - [Rotate a Key](#rotate-a-key)
  - [Revoke a Key](#revoke-a-key)
  - [Get Usage Stats](#get-usage-stats)
- [Using a Key in Requests](#using-a-key-in-requests)
- [Scopes](#scopes)
- [Storage and Key Format](#storage-and-key-format)
- [Expiry and lastUsedAt Tracking](#expiry-and-lastusedAt-tracking)
- [Which Endpoints Accept API Key Auth](#which-endpoints-accept-api-key-auth)
- [Security Best Practices](#security-best-practices)
- [Error Reference](#error-reference)

---

## Concepts

| Concept | Detail |
|---------|--------|
| **Header** | `X-Api-Key: <key>` |
| **Key format** | 40 lowercase hex characters (`randomBytes(20).toString('hex')`) |
| **Storage** | SHA-256 digest only — the raw key is never persisted |
| **Plaintext shown** | Once, in the create (or rotate) response — not retrievable again |
| **Scopes** | `read` (GET/HEAD) and/or `write` (POST/PUT/PATCH/DELETE) |
| **Management auth** | JWT only — API keys cannot create or manage other API keys |

---

## Managing Keys (JWT Required)

All key-management routes live under `/api/v1/auth/api-keys` and require an `Authorization: Bearer <JWT>` header. You cannot use an API key to manage API keys.

### Create a Key

```
POST /api/v1/auth/api-keys
```

**Request fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Human-readable label, max 64 chars |
| `scopes` | `string[]` | No | `["read"]` or `["read","write"]`; defaults to `["read","write"]` |
| `expiresAt` | ISO 8601 string | No | Must be in the future and at most 1 year out; omit for a non-expiring key |

**Example — read/write key for a CI pipeline:**

```bash
curl -s -X POST https://api.example.com/api/v1/auth/api-keys \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI Pipeline"}'
```

**Example — read-only key with an expiry:**

```bash
curl -s -X POST https://api.example.com/api/v1/auth/api-keys \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Monitoring Dashboard",
    "scopes": ["read"],
    "expiresAt": "2027-09-25T00:00:00.000Z"
  }'
```

**Response (HTTP 201):**

```json
{
  "success": true,
  "data": {
    "id": "3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f",
    "name": "CI Pipeline",
    "scopes": ["read", "write"],
    "expiresAt": null,
    "createdAt": "2026-09-29T10:00:00.000Z",
    "key": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
  },
  "timestamp": "2026-09-29T10:00:00.000Z"
}
```

> **The `key` field is only present in this response.** It is never stored and will not be returned again. Copy it to your secrets manager before closing this response.

---

### List Keys

Returns all active (non-revoked) keys for the authenticated user. The raw key value is never included.

```
GET /api/v1/auth/api-keys
```

```bash
curl -s https://api.example.com/api/v1/auth/api-keys \
  -H "Authorization: Bearer $JWT"
```

**Response (HTTP 200):**

```json
{
  "success": true,
  "data": [
    {
      "id": "3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f",
      "name": "CI Pipeline",
      "scopes": ["read", "write"],
      "lastUsedAt": "2026-09-29T11:30:00.000Z",
      "expiresAt": null,
      "createdAt": "2026-09-29T10:00:00.000Z"
    }
  ],
  "timestamp": "2026-09-29T12:00:00.000Z"
}
```

---

### Rotate a Key

Atomically revokes the specified key and issues a replacement with the same name and scopes. Use this for regular key rotation or when a key may have been exposed. The `expiresAt` from the old key is intentionally **not** inherited — re-specify it explicitly if needed.

```
POST /api/v1/auth/api-keys/:id/rotate
```

**Request fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `gracePeriodSeconds` | integer | No | Seconds the **old** key stays valid after rotation (0–86400). Defaults to `0` (immediate revocation). |

Use `gracePeriodSeconds` to perform a zero-downtime swap: deploy the new key while the old one still works, then remove the old key reference.

**Example — immediate rotation:**

```bash
curl -s -X POST https://api.example.com/api/v1/auth/api-keys/3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f/rotate \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Example — 5-minute grace period for zero-downtime swap:**

```bash
curl -s -X POST https://api.example.com/api/v1/auth/api-keys/3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f/rotate \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"gracePeriodSeconds": 300}'
```

**Response (HTTP 201):**

```json
{
  "success": true,
  "data": {
    "id": "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d",
    "name": "CI Pipeline",
    "scopes": ["read", "write"],
    "expiresAt": null,
    "createdAt": "2026-09-29T14:00:00.000Z",
    "rotatedFromId": "3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f",
    "gracePeriodEndsAt": "2026-09-29T14:05:00.000Z",
    "key": "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5"
  },
  "timestamp": "2026-09-29T14:00:00.000Z"
}
```

> The `key` in the rotation response is the **new** key's plaintext — shown once only. Save it immediately.

---

### Revoke a Key

Immediately marks a key as revoked. Revoked keys return `401` on all subsequent requests and do not appear in the list endpoint.

```
DELETE /api/v1/auth/api-keys/:id
```

```bash
curl -s -X DELETE https://api.example.com/api/v1/auth/api-keys/3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f \
  -H "Authorization: Bearer $JWT"
```

**Response (HTTP 200):**

```json
{
  "success": true,
  "data": {
    "message": "API key revoked successfully"
  },
  "timestamp": "2026-09-29T15:00:00.000Z"
}
```

---

### Get Usage Stats

Retrieve daily request counts for the last 30 days along with `lastUsedAt`. This allows key owners to audit usage activity, identify idle keys, and detect leaked keys. Owner-only.

```
GET /api/v1/auth/api-keys/:id/usage
```

**Example:**

```bash
curl -s https://api.example.com/api/v1/auth/api-keys/3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f/usage \
  -H "Authorization: Bearer $JWT"
```

**Response (HTTP 200):**

```json
{
  "id": "3f2a1c9d-4e5b-6c7d-8e9f-0a1b2c3d4e5f",
  "name": "CI Deployment Key",
  "lastUsedAt": "2026-10-19T10:15:30.000Z",
  "totalRequests30d": 128,
  "dailyUsage": [
    { "date": "2026-09-20", "count": 0 },
    { "date": "2026-10-18", "count": 42 },
    { "date": "2026-10-19", "count": 86 }
  ]
}
```

---

## Using a Key in Requests

Pass the key in the `X-Api-Key` header on any request to an endpoint that accepts API key authentication:

```bash
curl -s https://api.example.com/api/v1/shipments \
  -H "X-Api-Key: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
```

```bash
# POST example (requires "write" scope)
curl -s -X POST https://api.example.com/api/v1/shipments \
  -H "X-Api-Key: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" \
  -H "Content-Type: application/json" \
  -d '{"contractId": "..."}'
```

Do **not** combine `X-Api-Key` with an `Authorization: Bearer` header in the same request — JWT authentication takes precedence where both guards are applied.

---

## Scopes

Scopes control which HTTP methods a key may use:

| Scope | Permitted methods |
|-------|------------------|
| `read` | `GET`, `HEAD` |
| `write` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` |

A key created with `"scopes": ["read", "write"]` (the default) has full access. A key created with `"scopes": ["read"]` is rejected with `403 API_KEY_SCOPE_INSUFFICIENT` if it attempts any mutating operation.

Prefer read-only keys for observability tooling, dashboards, and any integration that does not need to modify data. Issue separate write-capable keys only for services that explicitly require it.

---

## Storage and Key Format

The 40-character hex key is generated with:

```ts
randomBytes(20).toString('hex')  // e.g. "a1b2c3d4e5f6..."
```

Only the SHA-256 digest is written to the database:

```ts
createHash('sha256').update(plaintext).digest('hex')
```

On each incoming request the strategy hashes the presented `X-Api-Key` value and performs a single `findUnique` lookup against the stored digest. **The raw key never touches persistent storage.**

Because of this:
- There is no "view key" endpoint — it cannot exist.
- If a key is lost, rotate or revoke it and create a new one.
- Key UUIDs (the `id` field) are safe to log; they cannot be used to authenticate.

---

## Expiry and lastUsedAt Tracking

### Expiry

When `expiresAt` is set, the strategy rejects the key with `401 API_KEY_EXPIRED` once that timestamp is reached. Expiry is checked on every request. The field is visible in the list response so you can build alerting around upcoming expirations.

### lastUsedAt

Every successful authentication updates `lastUsedAt` on the key record in a **fire-and-forget** Prisma call that never blocks the request. Use this field to:

- Detect keys that have not been used recently and may be safe to revoke.
- Audit unexpected usage patterns (e.g. a key used outside business hours).

`lastUsedAt` is `null` for a key that has never authenticated a request.

---

## Which Endpoints Accept API Key Auth

Endpoints protected with `ApiKeyGuard` accept an `X-Api-Key` credential. Endpoints protected with `JwtAuthGuard` only accept a `Bearer` token.

**Accept `X-Api-Key`:**

| Module | Endpoints |
|--------|-----------|
| Shipments | `GET /shipments`, `GET /shipments/:id`, `POST /shipments`, `GET /shipments/:id/milestones` |
| Milestones | `GET /shipments/:id/milestones/:index` |
| Events | `GET /events` |

**JWT only (do not accept API key auth):**

| Module | Endpoints | Reason |
|--------|-----------|--------|
| Auth / key management | `POST /auth/api-keys`, `GET /auth/api-keys`, `POST /auth/api-keys/:id/rotate`, `DELETE /auth/api-keys/:id` | Keys cannot manage other keys |
| Notifications | All `/notifications` routes | Personal/user-specific data |
| Auth login/nonce | `GET /auth/nonce`, `POST /auth/login` | Part of the JWT issuance flow |

> If you are integrating a new endpoint and need to accept both auth methods, apply both guards: `@UseGuards(JwtAuthGuard)` and `@UseGuards(ApiKeyGuard)`. Check with the team before exposing sensitive or account-level operations to API key auth.

---

## Security Best Practices

### Treat keys like passwords

- Store keys in a secrets manager (AWS Secrets Manager, HashiCorp Vault, GitHub Actions Secrets, etc.), not in source code or configuration files.
- Never commit a key — not even to a private repository.
- Never log the `X-Api-Key` header value. Log the key's `id` (UUID) instead.

### One key per integration

Issue a separate key for each distinct service or pipeline. This way you can revoke a single compromised credential without affecting every integration.

### Use the narrowest scope needed

Create read-only keys (`"scopes": ["read"]`) for anything that only reads data. Reserve write-capable keys for services that genuinely need them.

### Set an expiry

Prefer keys with an `expiresAt` over keys that never expire. A maximum of 1 year is enforced by the API. Calendar a reminder to rotate before the expiry date.

### Rotate regularly and after any suspected exposure

Use `POST /api/v1/auth/api-keys/:id/rotate` to get a new key without a gap in service. Use `gracePeriodSeconds` (up to 86 400 = 24 h) to give yourself a safe swap window. Revoke the old key immediately once the new one is confirmed working.

### Verify `lastUsedAt`

Review keys periodically via `GET /api/v1/auth/api-keys`. Revoke any key with a `lastUsedAt` that is unexpectedly old (possibly orphaned) or unexpectedly recent/frequent (possibly leaked).

---

## Error Reference

| HTTP status | Body / code | Meaning |
|-------------|-------------|---------|
| `401` | `Missing X-Api-Key header` | Request reached an API-key-protected endpoint with no header |
| `401` | `Invalid or revoked API key` | Key not found, already revoked (and past any grace period) |
| `401` | `API_KEY_EXPIRED` | Key has passed its `expiresAt` timestamp |
| `401` | `Account has been deactivated` | The user account that owns the key has been deactivated |
| `403` | `API_KEY_SCOPE_INSUFFICIENT` | Key has only `read` scope but the request is a write method |
| `403` | `You do not own this API key` | Attempting to revoke a key belonging to a different user |
| `404` | `API key not found` | Key ID does not exist or is not owned by the caller (also returned on ownership mismatch to prevent enumeration) |
| `409` | `API_KEY_ALREADY_REVOKED` | Attempting to rotate a key that is already revoked |
