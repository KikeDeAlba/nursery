# nursery

Una camada de subagentes especialistas que trabajan con las mismas reglas, en
Claude Code, opencode, Codex y Gemini CLI.

- **Reglas generales:** git, ramas, worktrees, código, idioma y verificación.
  Viven en `rules/RULES.md` y se instalan una sola vez en la memoria global de
  cada agente. Las leen la conversación principal y todos los subagentes, así
  que una instalación limpia sigue tus reglas desde el primer mensaje.
- **Nueve subagentes**, cada uno con una descripción corta para que el agente
  principal sepa solo cuándo delegarle, y un cuerpo con lo propio del rol.
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
reglas sin marcadores. `nursery uninstall` quita el plugin, los subagentes y los
bloques.

### El plugin de Claude Code

Sin `nursery setup`, el plugin se instala desde Claude Code (2.1.275 o
posterior) con:

```
/plugin install nursery --marketplace KikeDeAlba/nursery
```

El plugin trae los subagentes y `/nursery`. Las reglas no viajan en el plugin,
porque un plugin no puede escribir en `CLAUDE.md`: para ellas hace falta
`nursery setup`.

| Pieza | Qué es | Cuándo cuesta contexto |
|---|---|---|
| Descripción de cada subagente | Cuándo delegarle (≤ 300 caracteres) | Siempre, unos 600 tokens entre los nueve |
| Cuerpo de cada subagente | Rol, pasos, límites y formato de entrega | Solo dentro del subagente, al llamarlo |
| `skills/nursery` | `/nursery`: elige la cadena y pasa entregas entre agentes | Nada hasta que el usuario lo escribe |
| Bloque de reglas | `rules/RULES.md` en la memoria global | Siempre, unos 1,200 tokens, en la conversación y en cada subagente |

## Subagentes

| Agente | Para qué | Herramientas | Modelo / esfuerzo |
|---|---|---|---|
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
- el bloque de reglas pasa de 4,500 caracteres.

## Licencia

MIT
