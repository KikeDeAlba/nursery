# nursery

Una camada de subagentes especialistas que trabajan con las mismas reglas, en
Claude Code, opencode, Codex y Gemini CLI.

- **Reglas generales:** git, ramas, worktrees, código, idioma y verificación.
  Viven en `rules/RULES.md` y se instalan una sola vez en la memoria global de
  cada agente. Las leen la conversación principal y todos los subagentes, así
  que una instalación limpia sigue tus reglas desde el primer mensaje.
- **Diez subagentes**, cada uno con una descripción corta para que el agente
  principal sepa solo cuándo delegarle, y un cuerpo con lo propio del rol.
- **Delegación automática:** las reglas hacen que todo plan termine con una
  tabla de pasos y agentes, y que al aprobarlo cada paso se delegue, en paralelo
  cuando se puede.
- **`/nursery`** encadena los subagentes para una feature, un bug, un cambio de
  infraestructura o un incidente.

Se instala con [kit](https://github.com/KikeDeAlba/kit), como el resto de las
herramientas.

## Instalación

```sh
npm install -g @kikedealba/nursery
nursery setup
```

`nursery setup` conecta nursery con los agentes que encuentre
(`--agents claude,codex` elige cuáles, `--agents all` los fuerza todos):

- **Claude Code** recibe el plugin `nursery` de este repositorio, que es su
  propio marketplace, y el bloque de reglas en `~/.claude/CLAUDE.md`.
- **opencode, Codex y Gemini CLI** reciben los subagentes en su formato, el
  bloque de reglas en su memoria global y `/nursery` como comando.

| Agente | Subagentes | Reglas |
|---|---|---|
| Claude Code | plugin `nursery` | `~/.claude/CLAUDE.md` |
| opencode | `~/.config/opencode/agents/*.md` | `~/.config/opencode/AGENTS.md` |
| Codex | `~/.codex/agents/*.toml` | `~/.codex/AGENTS.md` |
| Gemini CLI | extensión `nursery`, `agents/*.md` | `~/.gemini/GEMINI.md` |

El bloque de reglas va entre `<!-- kit:nursery:begin -->` y
`<!-- kit:nursery:end -->`; el resto del archivo no se toca. Si el archivo ya
tiene las reglas sin esos marcadores (copiadas a mano antes de nursery), el
bloque no se escribe para no duplicarlas. `nursery setup --replace-legacy` quita
esa sección, deja una copia en `<archivo>.legacy-backup` y escribe el bloque.

`nursery check` dice si el bloque de cada agente está al día, falta o choca con
reglas sin marcadores. `nursery uninstall` quita el plugin, los subagentes, los
bloques y el registro en kit.

### Registro en kit

Antes de instalar en los agentes, `nursery setup` registra nursery en el
registro de kit (`nursery.json` en el directorio del registro, o en
`KIT_REGISTRY_DIR` si está definido), igual que el resto de las herramientas.
El manifiesto declara las capacidades `agents.subagents` y `agents.rules`; nursery
no emite eventos ni se suscribe a los de otras herramientas. `nursery uninstall`
borra el registro.

`nursery capabilities --json` imprime en una línea el sobre de kit con
`{ name, version, envelope, capabilities, emits }`; sin `--json` lo muestra en
texto. Con `--json`, un comando desconocido imprime un sobre de error
(`ok: false`, código `UNKNOWN_COMMAND`) y sale con código 2.

### El plugin de Claude Code

Sin `nursery setup`, el plugin se instala desde Claude Code (2.1.275 o
posterior) con:

```
/plugin install nursery --marketplace KikeDeAlba/nursery
```

El plugin trae los subagentes, `/nursery` y un panel en vivo de subagentes. Las reglas no viajan en el plugin,
porque un plugin no puede escribir en `CLAUDE.md`: para ellas hace falta
`nursery setup`.

| Pieza | Qué es | Cuándo cuesta contexto |
|---|---|---|
| Descripción de cada subagente | Cuándo delegarle (≤ 300 caracteres) | Siempre, unos 650 tokens entre los diez |
| Cuerpo de cada subagente | Rol, pasos, límites y formato de entrega | Solo dentro del subagente, al llamarlo |
| `skills/nursery` | `/nursery`: elige la cadena y pasa entregas entre agentes | Nada hasta que el usuario lo escribe |
| `hooks/` | Panel de subagentes (ver «Panel de subagentes») | Nunca: no agrega nada al prompt |
| Bloque de reglas | `rules/RULES.md` en la memoria global | Siempre, unos 1,400 tokens, en la conversación y en cada subagente |

## Subagentes

| Agente | Para qué | Herramientas | Modelo / esfuerzo |
|---|---|---|---|
| `researcher` | Confirma o refuta supuestos con fuentes antes de planear; no diseña ni edita | lectura, Bash, web, skills | sonnet / medium |
| `analyst` | Historias, criterios de aceptación, lectura de tickets y minutas | lectura, Bash, skills | sonnet / medium |
| `architect` | Diseño de soluciones, alternativas y ADRs | lectura, Bash, web, skills | opus / high |
| `developer` | Feature o bugfix acotado en su worktree, hasta el MR | todas | claude-opus-5-5 / medium |
| `qa-automation` | Plan de pruebas, unitarias, integración y e2e (Playwright) | todas | sonnet / medium |
| `devops` | Terraform por manifests, OIDC, GitLab CI y GitHub Actions | todas | sonnet / medium |
| `sre` | Incidentes, logs, métricas, alarmas y runbooks | lectura, Bash, web, skills | sonnet / medium |
| `security` | IAM, red, secretos, dependencias y PCI | lectura, Bash, web | sonnet / high |
| `code-reviewer` | Revisión de diff o MR antes de mezclar | lectura, Bash | sonnet / high |
| `documenter` | README, inkwell, Confluence, runbooks | lectura, escritura, Bash, skills | sonnet / medium |

Ningún subagente precarga skills: las usa (atl, inkwell, gaze, recap) solo
cuando las necesita. Todos terminan con la misma entrega de máximo 15 líneas
(resultado, cambios, evidencia, pendiente y siguiente agente), para que lo que
vuelve a la conversación principal sea corto. `maxTurns` corta los bucles.

En opencode, Codex y Gemini, `model` no se traduce y se hereda el de la sesión;
`effort` pasa a `model_reasoning_effort` en Codex, y `tools` a permisos o
nombres de herramienta en cada uno.

## Delegación automática

La sección «Delegación» de las reglas está en la memoria global, así que también
aplica en modo plan:

1. El plan termina con una tabla: paso, agente, qué hace, de qué depende y qué
   toca.
2. Las partes que no dependen entre sí ni tocan los mismos archivos se marcan
   para correr en paralelo, hasta 10 a la vez, aunque sean del mismo rol.
3. Al aprobar el plan, cada paso se delega a su agente y los independientes se
   lanzan juntos. Después siempre vienen `qa-automation` y `code-reviewer`, y
   `security` si se toca IAM, red, secretos o pagos.

Ejemplo: «las conexiones a la base se quedan abiertas y el proxy no las corta».

| Paso | Agente | Qué hace | Depende de |
|---|---|---|---|
| 1 | `sre` | Confirma con métricas del proxy y de la base qué conexiones quedan abiertas | — |
| 2a | `developer` | Pool con máximo, timeout de inactividad, vida por conexión y cierre en el shutdown | 1 |
| 2b | `devops` | Timeout de clientes inactivos y tope de conexiones del RDS Proxy en el manifest | 1 |
| 3 | `security` | Revisa el cambio de infraestructura | 2b |
| 4 | `qa-automation` | Prueba de fuga de conexiones | 2a |
| 5 | `code-reviewer` | Revisa todo antes de los MR | 3, 4 |

2a y 2b corren en paralelo.

Cuando dos partes en paralelo van en el mismo repo:

- Cada una trabaja en su worktree, en una sub-rama `feature/<n>-<parte>` que nace
  de la rama de la tarea.
- Las sub-ramas son **solo locales**: el orquestador las mezcla en
  `feature/<n>`, corre el gate y las borra.
- Al remoto solo sube la rama de la tarea ya integrada, con un MR.
- Si las partes van en repos distintos, cada una lleva su rama y su MR.

Sigue siendo una instrucción para el modelo, no un mecanismo. Si alguna vez no
delega, `/nursery` fuerza la cadena.

## Panel de subagentes

Al lanzarse un subagente se abre el panel «Subagentes». Es un mod de Claude
Code: un módulo de hooks en `hooks/register.tsx`, declarado en
`hooks/hooks.json`. Se instala con el plugin, sin nada extra.

```
Subagentes
● developer       implementa endpoint   1m12s  14 herramientas
  ✓ Read src/api/users.ts
  … Bash npm test
  » Las pruebas pasan, falta el lint
✓ code-reviewer   revisa diff           0m48s   6 herramientas
```

Por cada agente muestra:

- el rol (`nursery:developer` se ve como `developer`) y la descripción de la
  tarea;
- el estado: `●` corriendo, `✓` terminado, `✗` falló, `■` abortado;
- el tiempo y el número de herramientas usadas (`herr.` si el panel es
  angosto);
- mientras corre, sus últimas 5 actividades, herramientas y texto mezclados en
  orden: una herramienta con su argumento (`…` en curso, `✓` hecha, `✗`
  falló; el comando de Bash, el archivo de Read, Edit o Write, el patrón de
  Grep o Glob) o la primera línea de lo que dijo (`»`).

Los agentes terminados quedan atenuados en una sola línea, sin actividad. Un
agente que lleva más de 30 s corriendo (contados desde que se lanzó o desde su
última reanudación) y falta dos veces seguidas en la lista de agentes de Claude
Code se da por terminado (`✓`). Si la consulta de la lista falla entre dos
ausencias, no cuenta y no borra la anterior: las dos ausencias siguen siendo
seguidas. Volver a lanzar un agente terminado solo lo reabre si es una
reanudación del mismo agente.

El panel tiene un fondo oscuro fijo (`#1e1e1e`) que ocupa todo su alto, con un
borde redondeado y colores propios, iguales con cualquier tema de Claude Code.

Los subagentes que lanza otro subagente salen sangrados bajo su padre. El panel
muestra todos los subagentes, no solo los de nursery.

Cómo se usa:

- Elegir un agente en el panel abre su transcript.
- El panel se abre solo con el primer subagente de la sesión; si lo cierras,
  no vuelve a abrirse solo.
- `/nursery-panel` lo abre siempre.
- En terminales de menos de unas 144 columnas el panel no se coloca solo. En su
  lugar aparece una línea por agente corriendo encima del prompt:
  `● developer · 1m12s · Bash npm test`.

El panel no cuesta contexto: no agrega nada al prompt del modelo. Requiere una
versión de Claude Code con soporte de mods (hooks modules); se probó con
Claude Code 2.1.302 (`claude --version`).

## `/nursery`

```
/nursery PP-123
/nursery el job de deploy de codi-webhook falla en qa
```

Elige la cadena (feature, bug, infraestructura, incidente o revisión), llama a
cada subagente con la entrega del anterior, hace las preguntas pendientes en un
solo bloque y no hace nada destructivo ni de producción sin confirmación.

## Desarrollo

Los agentes se escriben en `src/agents/*.md`. Los fragmentos compartidos de
`src/conventions/` entran con `@include <nombre>`:

| Fragmento | Contenido | Lo usan |
|---|---|---|
| `stack-node` | Node 24, NestJS hexagonal, TypeORM, gate local | developer, qa-automation |
| `stack-terraform` | Manifests, OIDC, bootstrap, nombres, gate | devops, security |
| `ci` | Plantillas de GitLab, ramas y tags por ambiente, GitHub Actions | devops |
| `observability` | Datadog, CloudWatch, logs estructurados | sre |
| `branch` | Rama asignada y entrega como parte de una tarea en paralelo | developer, devops, qa-automation |
| `handoff` | Formato de la entrega | todos |

`pnpm build:agents` genera `agents/*.md`, que va versionado porque el
marketplace instala desde git.

```sh
pnpm install
pnpm build:agents
pnpm typecheck
pnpm test
```

Las pruebas fallan si:

- `agents/` no coincide con sus fuentes;
- una descripción pasa de 300 caracteres, o todas juntas pasan de 2,500;
- dos agentes comparten una frase disparadora;
- un cuerpo pasa de 80 líneas o repite texto de `rules/RULES.md`;
- el bloque de reglas pasa de 5,200 caracteres, o su sección «Delegación» no nombra
  a los diez agentes;
- developer, devops o qa-automation no saben entregar como parte (sin push ni MR).

Para probar el panel de subagentes (`hooks/`):

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

- `claude plugin validate .` valida el plugin, incluido el módulo de hooks.
- `claude plugin test .` corre las pruebas de `hooks/*.test.ts`. Son aparte de
  `pnpm test`, que corre `test/*.spec.ts`; el sufijo distinto evita que
  `claude plugin test` intente cargar las pruebas de node.
- `claude --plugin-dir .` carga el plugin desde el checkout, sin instalarlo.

## Licencia

MIT
