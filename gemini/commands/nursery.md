---
description: Lleva un pedido de punta a punta con nursery: propuesta, aceptación, ejecución con agentes y validación
---
[nursery-flow] Lleva este pedido de punta a punta con el flujo de nursery. Un hook vigila cada fase: si niega una herramienta, haz lo que dice su motivo y no lo rodees.

<pedido>
$ARGUMENTS
</pedido>

1. Si el pedido está vacío, pregunta qué necesita con `ask_user` y no hagas nada más.
2. Explora poco: si no es trivial, invoca a `researcher` con hasta 3 preguntas concretas (las independientes, en varias invocaciones en la misma respuesta). Su entrega es tu base: no releas lo que ya reportó.
3. Pregunta con `ask_user` solo las dudas que cambian el plan.
4. Propón con `ask_user`: una pregunta `type: "choice"`, `header: "Propuesta"`, la propuesta completa en `question` (qué cambia y dónde, riesgos y una tabla de pasos: agente, qué hace, de qué depende) y las opciones `Aceptar` y `Corregir`.
5. Si el usuario corrige, ajusta y vuelve a proponer igual, hasta que acepte con «Aceptar» o escribiendo «acepto». Antes de aceptar solo lees, preguntas y delegas a agentes de lectura: no escribes archivos, no usas el shell, no usas herramientas MCP que escriben y no invocas a developer, devops, qa-automation ni documenter.
6. Ya aceptado, ejecuta cada paso con su agente (`invoke_agent`), en paralelo los independientes y con el contrato fijado antes de repartir. Tú orquestas: pasas solo sus entregas y no escribes código; solo puedes escribir `.md`.
7. Valida con `qa-automation` y `code-reviewer` (y `security` si toca IAM, red, secretos o pagos), corrige lo que reporten con el agente que corresponda y cierra con un resumen: qué se hizo, evidencia, pendientes y la ruta del plan que te da el hook.
