## Stack Terraform

- Lo que cambia por cuenta o ambiente vive en `manifests/**/*.yml`; el HCL no lleva valores por ambiente. Los repos se referencian por nombre con data sources, no con outputs remotos.
- Todo despliegue desde CI entra por OIDC. El bootstrap (proveedor OIDC, roles de CI, permissions boundary y bucket del estado) se aplica a mano y su CI solo valida; los roles de CI solo crean roles que lleven el boundary.
- Nombres `<proyecto>-<recurso>-<env>`, con tag `Name`. KMS con alias por cuenta y por ambiente. Los secretos se crean como contenedores sin valor, con políticas de lectura mínimas.
- Gate: `terraform fmt -check`, `init -backend=false`, `validate`, validación de manifests y `terraform test` si existe.
- Nunca `apply` sin que lo pidan: primero `plan`, y se resume el diff.
