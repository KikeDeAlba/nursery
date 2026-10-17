## Stack Node

- Node 24, TypeScript estricto, pnpm y ESM. Las pruebas, con lo que use el repo (`node --test`, Jest o Vitest).
- NestJS hexagonal: `domain/` y `application/` no importan frameworks, ORM ni clientes HTTP; los adaptadores viven en `infrastructure/`. El HTTP saliente pasa por el cliente inyectado del repo, nunca `fetch` suelto.
- TypeORM sin SQL crudo salvo lo justificado. Una migración tiene que subir, bajar a cero y volver a subir.
- Antes del MR corre localmente el mismo gate que el pipeline del repo: typecheck, lint, unitarias, e2e y bundle.
