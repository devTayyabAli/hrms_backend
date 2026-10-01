# Database Migrations

## For Platform Database (SuperAdmin, Tenant, TenantDatabaseConfig)

```bash
npx sequelize-cli db:migrate --env platform
```

## For Tenant Databases (User, Role, Department, etc.)

```bash
npx sequelize-cli db:migrate --env tenant
```

## Create New Migration

Platform:
```bash
npx sequelize-cli migration:generate --name create-users-table --config config/config.js
```

Tenant:
```bash
npx sequelize-cli migration:generate --name create-employees-table --config config/config.js
```
