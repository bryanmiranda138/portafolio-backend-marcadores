# ⚽ LiveScoresBC — Panel de Marcadores en Tiempo Real

Aplicación Full-Stack de seguimiento deportivo en tiempo real con sincronización bidireccional mediante **WebSockets (Socket.io)** y una arquitectura backend resiliente de múltiples capas para garantizar **alta disponibilidad (99.9% uptime)** sin incurrir en bloqueos por límites de cuota (*Rate Limiting*).

## 🧠 Arquitectura de Datos Híbrida (3-Tier Fallback System)

Uno de los mayores retos en el desarrollo de aplicaciones deportivas es la restricción de las APIs gratuitas (límites diarios estrictos, bloqueos regionales para ligas de Latinoamérica/CONCACAF o falta de eventos granulares como goleadores y tarjetas). 

Para resolverlo, el backend implementa un motor de consulta inteligente con **Disparador por Horario (*Smart Trigger*)** y **Degradación Elegante (*Graceful Degradation*)**:

1. **Sincronización de Calendario y *Smart Trigger* (TheSportsDB API):**
   - El servidor indexa periódicamente la agenda de los equipos seguidos (LaLiga, Premier League, Serie A, Copa Libertadores, MLS, Liga Mayor de El Salvador y Selecciones Nacionales).
   - **Optimización de Recursos:** El motor de partidos en vivo permanece en reposo (`0` consumo de red/créditos) y solo se activa automáticamente dentro de la ventana real de juego (`-5 min` antes del pitazo inicial hasta `+115 min`).

2. **Capa 1 — Feed Directo de Baja Latencia (ESPN Open Scoreboard):**
   - Durante la ventana activa del partido, el servidor consulta en primera instancia el feed público de marcadores globales, extrayendo el resultado en vivo, minuto exacto, goleadores y tarjetas sin consumir cuotas de APIs privadas.

3. **Capa 2 — Extracción Quirúrgica DOM & Regex con Evasión de CAPTCHA (ScrapingBee + Google Sports OneBox):**
   - Si un encuentro de una liga regional específica no se encuentra en el feed primario, el sistema activa **ScrapingBee** utilizando proxies residenciales (`premium_proxy`) y selectores CSS directos del DOM de Google Sports (`.imso_mh__l-tm-sc`, `.imso_gs__gs-r`), respaldados por un analizador de expresiones regulares (*Regex*) sobre los titulares indexados.

4. **Capa 3 — Estimador Matemático de Tiempo de Juego:**
   - En caso de latencia extrema en proveedores externos, un algoritmo interno calcula el minuto en curso basándose en el *timestamp* UTC oficial de inicio, compensando automáticamente los 15 minutos reglamentarios de descanso (`HT`) y acotando los tiempos de reposición (`45+'` y `90+'`).

## 🛠️ Stack Tecnológico

* **Frontend:** React / Next.js desplegado en **Vercel**, interfaz adaptable (Modo Oscuro/Claro) y actualización reactiva sin recarga de página.
* **Backend:** Node.js + Express desplegado en **Render**.
* **Tiempo Real:** Socket.io para emisión de eventos (`marcadores_actualizados`) a múltiples clientes concurrentes con deduplicación automática entre listas de *Partidos en Vivo* y *Próximos Partidos*.
