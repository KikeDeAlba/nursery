---
name: nursery
description: Encadena los subagentes de nursery para una feature, un cambio de infraestructura o un incidente
argument-hint: "<tarea, ticket o incidente>"
disable-model-invocation: true
---

Lleva `$ARGUMENTS` de punta a punta con los subagentes de nursery. Tú orquestas: no haces el trabajo de ningún rol, y entre un agente y otro pasas solo su entrega (resultado, cambios, evidencia, pendiente), nunca su salida completa.

## 1. Elige la cadena

| Tipo | Cadena |
|---|---|
| Feature o historia | analyst → architect (solo si hay decisiones de diseño) → developer → qa-automation → code-reviewer → documenter (solo si cambia el uso) |
| Bug | developer → qa-automation → code-reviewer |
| Infraestructura o pipeline | devops → security (si toca IAM, red o secretos) → code-reviewer |
| Incidente | sre → developer o devops (corrección) → qa-automation |
| Revisión antes de mezclar | code-reviewer y security, en paralelo |

Si el tipo no es obvio, pregunta con la interfaz de preguntas antes de llamar a nadie. Enseña la cadena elegida en una línea.

## 2. Divide y reparte

- Parte la implementación en piezas que no dependen entre sí ni tocan los mismos archivos: módulos distintos, app e infraestructura, repos distintos. Si comparten un contrato (API, esquema, evento), fíjalo antes de repartir.
- Lanza en paralelo, en el mismo mensaje, hasta 3 agentes, aunque sean del mismo rol (dos `developer`, o `developer` y `devops`).
- **Mismo repo:**
  - crea la rama de la tarea (`feature/<n>` desde `develop`) en tu worktree;
  - asigna a cada parte la sub-rama `feature/<n>-<parte>` con base `feature/<n>` y dile que es una parte;
  - las sub-ramas son solo locales: nunca se suben;
  - al terminar todas, mézclalas en `feature/<n>` y corre el gate completo;
  - luego borra las sub-ramas y sus worktrees, salvo que una no se haya podido integrar (eso se reporta).
- **Repos distintos:** cada parte lleva su propia rama y su MR.
- Al remoto solo sube la rama de la tarea ya integrada y revisada.

## 3. Corre la cadena

- Llama a cada subagente con un mensaje autocontenido: el objetivo, lo que entregó el anterior, el repo y la rama base, y qué se espera de vuelta.
- Si una entrega trae «Pendiente» con una decisión, haz la pregunta al usuario antes de seguir, todas en un solo bloque.
- Si `qa-automation` o `code-reviewer` encuentran fallos que bloquean, vuelve a `developer` (o `devops`) con esos hallazgos. Máximo dos vueltas; después, para y reporta.
- Nada destructivo ni de producción (apply, despliegue a QA, UAT o PROD, publicar, borrar) sin confirmación explícita del usuario en esta conversación.

## 4. Cierra

Termina con una tabla: agente, resultado, MR o artefacto, evidencia. Debajo, lo que quedó pendiente y quién debería tomarlo.
