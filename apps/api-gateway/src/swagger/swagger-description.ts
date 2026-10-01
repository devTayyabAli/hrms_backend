/**
 * Landing copy for /api/docs. Markdown is rendered by Swagger UI, so this is
 * the one place to explain how the two portals and their guards differ before
 * a reader starts clicking through the screen-by-screen sections.
 */
export const SWAGGER_DESCRIPTION = `
Centralized API Gateway proxying requests to the HRMS microservices
(**auth-service**, **tenant-service**, **user-service**).

Every endpoint is grouped by the **portal** it belongs to and then by the
**screen** it powers, so these sections line up with the UI:

| Prefix | Portal | Audience |
| --- | --- | --- |
| \`SuperAdmin:\` | Platform console | Platform operators (\`superadmin\` role) |
| \`Organization:\` | Tenant application | Organization Admins, HR and employees |
| \`Platform:\` | Shared infrastructure | Both portals |

### Authentication

All routes are prefixed with \`/api/v1\`.

- **SuperAdmin routes** — sign in via \`POST /superadmin/login\`, then send the
  access token as \`Authorization: Bearer <token>\`. These routes are platform
  scoped: they need no \`x-tenant-id\` and are additionally gated by the
  SuperAdmin role and the IP allowlist.
- **Organization routes** — sign in via \`POST /auth/login\`, then send both the
  bearer token **and** an \`x-tenant-id\` header identifying the organization.
  Access is further narrowed by the tenant's module entitlements and by the
  caller's role permissions.
- **Public routes** — liveness, login and invitation activation need no token.

Use **Authorize** above to set the bearer token and \`x-tenant-id\` once for the
whole page.
`.trim();
