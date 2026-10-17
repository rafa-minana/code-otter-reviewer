# code-otter — Arquitectura

Revisor de PRs con IA, autoalojado e inspirado en CodeRabbit. Escucha los PRs de los repos donde está instalado, revisa el código en un contenedor aislado y publica en el PR los errores que encuentra, como comentarios inline.

Todo va en Docker, para poder desplegarlo en cualquier servidor.

---

## 1. Visión general

```
GitHub ──webhook──► [api] ──addJob(review, jobKey=PR, replace, +2min)──► Postgres (cola + estado)
                                                                            │
                                                                            ▼
                                                                        [worker]
                                     1. lock por repo (advisory lock) → fetch en el mirror
                                     2. git worktree del SHA del PR
                                     3. docker run --rm reviewer
                                          monta: worktree (ro) + volumen del PR + caché de deps
                                          ──► findings.json
                                     4. ¿el SHA sigue siendo el último del PR? si no → descartar
                                     5. validar líneas contra el diff → publicar UNA review (token solo aquí)
                                     6. guardar estado (último SHA revisado, hallazgos publicados)

pull_request.closed / caducidad 5 días / endpoint admin ──► job cleanup ──► cleanupPr()
```

## 2. Servicios (`docker-compose.yml`)

| Servicio | Función | Notas |
|---|---|---|
| `api` | Recibe el webhook de GitHub y expone los endpoints `/admin` | Responde 200 rápido y solo encola. No tiene acceso al socket de Docker |
| `worker` | Ejecuta los trabajos: git, contenedores revisores, publicación y limpieza | Se puede escalar a N réplicas. Monta `/var/run/docker.sock` y `/var/otter` |
| `postgres` | Estado del sistema y cola de trabajos (Graphile Worker) | Única pieza con datos persistentes |
| `reviewer` | **Imagen**, no servicio: el worker la lanza en cada revisión | Sin token de GitHub. Red limitada a la API del LLM |

## 3. Escucha y cola (Graphile Worker sobre Postgres)

Graphile Worker es una librería de Node que usa tablas de Postgres como cola de trabajos. No es un servicio aparte.

- **Eventos que se escuchan:**
  - `pull_request.opened` / `reopened` → revisión inmediata.
  - `pull_request.synchronize` (push nuevo) → revisión con espera de 2 min.
  - `pull_request.closed` → limpieza.
- **Espera entre pushes (debounce):** cada trabajo de revisión se encola con `jobKey = review:<owner>/<repo>#<n>` en modo `replace`. Un push nuevo sustituye al trabajo pendiente y reinicia la espera.
- **Push durante una revisión:** se deja terminar, y antes de publicar se compara el SHA revisado con el último del PR. Si ya no es el último, la revisión se descarta, porque habrá otra encolada.
- **Idempotencia:** GitHub puede reenviar eventos. Cada `(PR, SHA)` se revisa una sola vez.
- **Reintentos:** automáticos, con espera exponencial (lo hace Graphile Worker).
- **Encolado transaccional:** el estado del PR y el trabajo se guardan en la misma transacción, mediante `graphile_worker.add_job(..., job_key, job_key_mode => 'replace')` en SQL. La api ejecuta las migraciones de graphile al arrancar, así que puede encolar aunque el worker no haya arrancado.

**Respuestas de `POST /webhook`** (Hono, `apps/api`):

| Entrada | Respuesta |
|---|---|
| Firma `X-Hub-Signature-256` ausente o inválida | 401, no se toca la BD |
| Cuerpo de más de 25 MB | 413 |
| `ping` | 200 |
| `pull_request` `opened` / `reopened` / `synchronize` | 202. Se encola la revisión (espera de 0 / 0 / 120 s) |
| Otro evento o acción | 204, se ignora |
| JSON inválido o payload sin los campos esperados | 400 |
| Fallo de la BD | 500, GitHub reintenta la entrega |

## 4. Git: un mirror por repo y un worktree por PR

```
/var/otter/                         # misma ruta en el host y en el worker
├── mirrors/<owner>__<repo>.git     # clon bare (--filter=blob:none), una vez por repo
├── worktrees/<owner>__<repo>__pr<n>__<sha>/   # checkout del SHA del PR
└── (volúmenes Docker) otter-pr-<owner>-<repo>-<n>, otter-deps-<owner>-<repo>-<lockhash>
```

1. ¿Existe el mirror? Si no existe → `git clone --bare --filter=blob:none`.
2. `git fetch origin pull/<n>/head:refs/otter/pr<n>`, con advisory lock de Postgres por repo para que no choquen dos fetch del mismo repo.
3. `git worktree add worktrees/…__<sha> <sha>`.
4. Se monta en el revisor en solo lectura. El mirror también se monta en solo lectura y en la misma ruta, para que funcionen `git log` y `git blame` dentro.

**Misma ruta en todos lados:** los revisores son contenedores "hermanos" del worker, así que Docker resuelve sus volúmenes con rutas del host. Por eso `/var/otter` se monta en el worker en la misma ruta.

El token de instalación de la GitHub App (caduca a la hora) se pide en cada fetch y nunca entra al revisor.

## 5. Contenedor revisor

- **Ciclo de vida:** `docker run --rm` en cada revisión, para usar siempre la última imagen sin arrastrar estado viejo.
- **Volumen del PR:** lo que se quiere reutilizar entre revisiones (estado, índices) vive en este volumen, no en el contenedor.
- **Caché de dependencias por repo:** con la clave en el hash del lockfile.

**Entrada:**
- el worktree;
- el diff, desde el último SHA revisado (revisión incremental);
- la config `.otter.yaml` (rutas a ignorar, instrucciones por ruta);
- los hallazgos ya publicados, para no repetirlos.

**Salida:** `findings.json` con `{path, line, side, severity, body, suggestion?, confidence}`.

**Pipeline interno:**
1. Trocear y comprimir el diff para no pasarse del límite de tokens (técnica de PR-Agent).
2. Linters y SAST: eslint, ruff, semgrep, gitleaks, ast-grep… Sus resultados se pasan como pistas al modelo.
3. Agente revisor (LLM) con herramientas de solo lectura dentro del sandbox (grep, read_file, ast-grep) para buscar contexto fuera del diff. El bucle es propio (ver más abajo).
4. Agente verificador: confirma o descarta cada hallazgo y le pone una puntuación de confianza. Se filtra lo que no llega al umbral (patrón del plugin code-review de Anthropic).

**Cómo usa el LLM (bucle de agente propio):**

Dentro del contenedor no hay ningún servidor de LLM. Se ejecuta nuestro programa (`apps/reviewer`), que es el cliente: llama por HTTP a la API del proveedor y ejecuta en local las herramientas que pida el modelo.

```
/repo (worktree, ro)   /in/input.json (ReviewerInput)   /out/findings.json (Finding[])

por cada trozo del diff:
  ┌─► LLM {system, trozo, pistas de linters, tools: grep | read_file | ast_grep}
  │     ◄── tool_call
  │   el revisor la ejecuta en el sandbox (solo lectura sobre /repo)
  └── devuelve el resultado al modelo
  … hasta la salida estructurada Finding[] o el máximo de pasos
```

- El bucle de herramientas lo da el AI SDK. Nosotros definimos las herramientas y el prompt.
- El modelo solo **pide** herramientas, y únicamente existen las que definimos: todas de solo lectura, sin escritura ni ejecución arbitraria.
- Descartado por ahora: usar un agente ya hecho dentro del contenedor (Codex app-server, opencode o Claude Agent SDK). Son más pesados, traen herramientas de escritura que habría que desactivar, la salida no es nuestro formato y algunos tiran hacia su propio proveedor.

**Seguridad:**
- El código del PR no es de fiar: la config de un linter puede ser JS ejecutable y puede haber prompt injection.
- Por eso el revisor no lleva token de GitHub, monta el código en solo lectura y solo tiene salida de red hacia el host del proveedor de LLM configurado (`LLM_PROVIDER` / `LLM_BASE_URL`).
- El código del PR sí se envía al proveedor del modelo.

## 6. Publicación (en el worker, nunca en el revisor)

- Validar cada hallazgo contra los trozos del diff, porque GitHub solo deja comentar líneas que aparecen en él (si no, error 422).
- Publicar **una única** review (`pulls.createReview`) con todos los comentarios inline más un resumen.
- Guardar en BD el id de la review y los hallazgos publicados.

## 7. Estado (Postgres)

| Tabla | Contenido |
|---|---|
| `repos` | owner/repo, ruta del mirror, último uso |
| `pull_requests` | repo, número, estado, último SHA revisado, fecha de caducidad |
| `reviews` | PR, SHA, inicio y fin, resultado, id de la review en GitHub |
| `findings` | review, fichero, línea, severidad, texto, publicado |
| `graphile_worker.*` | Cola de trabajos (la crea la librería) |

## 8. Limpieza

Una sola función `cleanupPr()` (y `cleanupRepo()`), usada por el evento de cierre, el barrendero y los endpoints:

| Ámbito | Se elimina | Se mantiene |
|---|---|---|
| PR | revisión pendiente (por jobKey), worktrees, `refs/otter/pr<n>`, volumen del PR, filas de la BD | mirror |
| Repo | todo lo anterior para todos sus PRs, el mirror y la caché de deps | — |

- **Barrendero (janitor):** trabajo periódico que borra los PRs sin actividad en 5 días y los repos sin actividad en N días. Si llega un push a un PR ya limpiado, se recrea todo, porque solo era caché.
- **Recursos:** los contenedores son `--rm`, así que al terminar no queda RAM ocupada. Lo que se libera es disco.
- **Límite de concurrencia:** un máximo global de revisores simultáneos (CPU y RAM).

## 9. Endpoints de administración

Protegidos con `Authorization: Bearer $ADMIN_TOKEN`. Exponerlos solo en red interna o VPN.

```
GET    /admin/status                               # colas, revisiones en curso, uso de disco
GET    /admin/repos/:owner/:repo/pulls/:n          # estado del PR
POST   /admin/repos/:owner/:repo/pulls/:n/review   # forzar re-revisión
DELETE /admin/repos/:owner/:repo/pulls/:n          # limpiar PR (encola cleanup → 202)
DELETE /admin/repos/:owner/:repo                   # limpiar repo entero, mirror incluido
POST   /admin/gc                                   # ejecutar el barrendero ya
```

Los DELETE son idempotentes y pasan por la cola, para no competir con una revisión en curso.

## 10. Estructura del repo (esqueleto creado; los módulos lanzan "not implemented")

```
code-otter/
├── docker-compose.yml
├── .env.example              # GitHub App, LLM_PROVIDER/MODEL/API_KEY, ADMIN_TOKEN, DATABASE_URL
├── Dockerfile                # una sola imagen por app: --build-arg APP=api|worker|reviewer
├── apps/
│   ├── api/                  # webhook + /admin
│   ├── worker/
│   │   ├── git/              # mirror.ts, worktree.ts
│   │   ├── ports.ts          # GitHubClient, ContainerRunner
│   │   ├── core.ts           # reglas puras: diffLines, selectPublishable, isStale
│   │   ├── review.ts         # handler del job: único sitio que orquesta
│   │   ├── github.ts         # GitHubClient con Octokit (GitHub App)
│   │   ├── runner.ts         # ContainerRunner: docker run --rm del revisor
│   │   ├── publish.ts        # selectPublishable + createReview
│   │   ├── cleanup.ts        # cleanupPr / cleanupRepo / gc
│   │   └── janitor.ts
│   └── reviewer/
│       ├── diff.ts           # trocear y comprimir el diff
│       ├── linters.ts
│       ├── llm.ts            # LlmProvider: anthropic | openai | gemini
│       ├── agent.ts
│       ├── verify.ts
│       └── prompts/
├── packages/contracts/       # solo mensajes entre procesos: payloads de la cola, ReviewerInput, Finding. Nada de helpers
├── db/migrations/
├── research/
└── test/fixtures/
```

Stack: TypeScript con npm workspaces (`ignore-scripts=true`), Octokit con autenticación de GitHub App, Graphile Worker, Postgres y un proveedor de LLM configurable (`LLM_PROVIDER`), implementado con el Vercel AI SDK detrás de la interfaz `LlmProvider`.

### Organización interna

Entre procesos, el desacople ya lo dan la cola, los ficheros montados y `@otter/contracts`. Dentro de cada proceso no se usa Clean Architecture completa, porque el proyecto es sobre todo orquestación de I/O. Se aplican dos ideas suyas:

- **Núcleo puro:** las reglas de negocio son funciones sin I/O, se prueban sin mocks y viven en `worker/core.ts` y en las funciones puras del reviewer (`chunkDiff`, `filterByConfidence`).
- **Ports solo donde hay motivo:**

| Port | Implementación | Motivo |
|---|---|---|
| `LlmProvider` (`reviewer/llm.ts`) | AI SDK | 3 proveedores |
| `GitHubClient` (`worker/ports.ts`) | Octokit | Fake en tests del worker |
| `ContainerRunner` (`worker/ports.ts`) | `docker run` | Frontera de seguridad; posible Podman o proxy del socket. Devuelve `unknown` y el núcleo lo valida |

- **Dependencias por argumentos** (`handleReview(deps, job)`), sin contenedor de inyección de dependencias.
- **Postgres y git no llevan port:** solo tienen una implementación posible (Graphile ya obliga a usar Postgres).

## 11. Fuentes de referencia y qué tomamos de cada una

| Fuente | Qué aporta |
|---|---|
| `coderabbitai/ai-pr-reviewer` (MIT, archivado) | Flujo resumen → revisión por trozo de diff, diff con números de línea, revisión incremental |
| `qodo-ai/pr-agent` | Compresión de diffs grandes, prompts y salida estructurada, sugerencias aplicables |
| Plugin `code-review` de Anthropic (`anthropics/claude-code`) | Revisión en paralelo + filtro por confianza |
| Octopus | Búsqueda vectorial sobre el repo (más adelante) |
| CodeRabbit (observado en un repo de pruebas) | Formato objetivo y comparativa de hallazgos |

## 12. Fases

1. **v0:** webhook → diff por la API → LLM → review con comentarios inline. Sin sandbox.
2. **v1:** mirror + worktree + contenedor revisor + linters + agente con shell.
3. **v2:** verificador y filtro por confianza.
4. **v3:** revisión incremental completa, endpoints admin, barrendero, comandos `@otter`.

## 13. Pendiente de verificar

- ~~Las opciones de Graphile Worker `jobKey` y `replace`~~: verificado en la 0.18.0. `add_job` tiene `job_key_mode` y su valor por defecto es `replace`. Falta verificar cómo se eliminan trabajos por clave (v3).
- La ubicación actual del plugin code-review de Anthropic.
- Gateway de LLM (LiteLLM o similar) como servicio aparte: sacaría la API key del revisor y permitiría dejarlo en una red interna sin internet. Pendiente de decidir.
- El socket de Docker en el worker equivale a ser root en el host. Valorar un proxy del socket que solo permita crear y borrar contenedores.
