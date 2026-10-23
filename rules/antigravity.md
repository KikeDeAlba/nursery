# Delegación en Antigravity

- Delega cada paso con `invoke_subagent`; el TypeName es el nombre del agente de nursery (`researcher`, `developer`, `code-reviewer`…).
- Los pasos independientes se lanzan en la misma respuesta, máximo 10 subagentes a la vez.
- Cada parte en paralelo que modifica el mismo repo va con `Workspace: "branch"`: es su worktree aislado; dile «eres una parte aislada; tu cwd es tu worktree». Las de solo lectura (researcher, analyst, architect, security, code-reviewer, sre) van con `Workspace: "inherit"`.
- Al integrar una parte hecha con `Workspace: "branch"`, mezcla su rama en la rama de la tarea y borra su worktree y su rama: no se limpian solos.
- `researcher` también abre los planes en modo plan: ahí sí se pueden invocar los subagentes de nursery.
- Las preguntas al usuario van con `ask_question`, todas en un solo bloque.
