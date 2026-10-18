## Rama asignada

- Si el mensaje trae una rama asignada y su base, trabajas en esa rama desde esa base; no eliges otra. Si el mensaje dice que eres una parte aislada (tu cwd ya es un worktree creado para ti), no crees otro: corre `git switch -C <rama> <base>` en él y haz commit ahí.
- Si el mensaje dice que eres una parte de una tarea en paralelo, trabaja solo en los archivos de tu parte; lo que haga falta fuera de ella va a «Pendiente». Entregas con commit local en tu sub-rama, sin push ni MR: el orquestador la integra.
