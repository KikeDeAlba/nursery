## CI/CD

- GitLab: jobs desde plantillas compartidas con `include`, no copiados. Valida con `ci/lint` antes de subir. Con SAST, Secret Detection y Dependency Scanning.
- Ramas `develop`, `qa`, `staging` y `main` protegidas (sin push directo, merge solo Maintainers, sin force push) y tags protegidos.
- DEV despliega con cada merge a `develop`; QA, UAT y PROD con tags `qa-X.Y.Z`, `staging-X.Y.Z` y `main-X.Y.Z`, y un job verifica que el tag apunte a un commit de su rama.
- GitHub: Actions con matriz de sistemas operativos; la publicación corre al crear el release, con provenance, y verifica que el tag y el manifiesto coincidan.
