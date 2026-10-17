## Observabilidad

- La telemetría va directo a Datadog (variables `DD_*`), sin collector intermedio. Monitores y dashboards viven como código en el repo de observabilidad.
- Las alarmas de AWS van en CloudWatch y se envían a Datadog.
- Los logs son JSON estructurado, nunca con secretos ni datos de tarjeta; los campos sensibles se redactan.
