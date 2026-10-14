# Levante Digital — hero con partículas

Prototipo Astro + TypeScript + OGL. Los originales se conservan en `public/assets/images`.

```sh
npm install
npm run dev
npm run verify
```

Para comprobar la simulación real, iniciar un servidor local y ejecutar `npm run test:browser`.
`PREVIEW_URL` permite elegir la URL; `BROWSER_EXECUTABLE` permite usar un Chromium ya instalado.
La verificación guarda capturas y lecturas GPU en `artifacts/`, que no se publica.

El hero combina `fondo-def.webp`, noise, las partículas de la cortina y del marco,
y `logo-hero-vector.svg`. El logo permanece estático por encima de toda la animación.
En escritorio su tamaño y el comienzo de «levante» se anclan al lienzo del fondo:
las letras quedan dentro de la cascada también a pantalla completa y el símbolo
se mantiene a su izquierda. En móvil se centra y reduce para
mantener la marca completa dentro de la pantalla.
Fondo y cortina comparten el lienzo original de 1672 × 941: ambos reciben el mismo
escalado `cover`, centrado horizontal y verticalmente, para preservar su composición
en escritorio y móvil. La imagen plana de la cortina se muestra antes de play
y como fallback si la animación no está disponible.

El marco se anima al cargar. La cascada se inicia exclusivamente al pulsar
«Reproducir cascada» en el hero, con ratón, teclado o táctil. Hasta entonces no
se decodifica su máscara para la simulación, se preparan sus semillas ni se
crean sus buffers o shaders GPU. Play añade la cascada al motor existente sin
reiniciar el marco. Pausa y reinicio no activan una cascada que aún está estática.
El botón circular de la esquina inferior izquierda muestra solo un icono y
permanece visible: play inicia o
reanuda la cascada y pausa la congela sin detener el marco. Reanudar conserva
sus posiciones y velocidades, sin volver a crear semillas ni buffers.

La cortina se reconstruye con 65.536 partículas en escritorio y 16.384 en móvil.
Solo se preparan columnas y tramos visibles después del recorte `cover`, para
evitar simular la mayor parte del lienzo que queda fuera de pantalla en móvil.
Los emisores se obtienen de píxeles con alfa de al menos 128; conservan el RGBA
original, sin sustituirlo por una paleta aleatoria. Cada columna se divide en sus
tramos opacos: los huecos transparentes interrumpen el flujo. Las partículas
caen continuamente dentro de esos tramos y vuelven a su comienzo al alcanzar el
final. En cada posición toman el color correspondiente de `cortina-def.webp`,
para mantener la estructura y los pliegues del original durante la cascada.
La gravedad es de 981 px/s² y la resistencia del aire de 2,6 s⁻¹ en el flujo.
El cursor desprende los granos que toca; estos siguen cayendo, rebotan y se
renderizan también fuera de la silueta, con resistencia de 0,45 s⁻¹. Conservan
el RGB y alfa del píxel donde se produjo el contacto para evitar cambios de
color al desprenderse. Vuelven a su origen al salir del hero o tras 3,2 segundos.

El marco usa únicamente el alfa de `marco.webp`, convertido sin pérdida desde
`marco.svg`: 1774 × 942, con un borde de 10 píxeles. Nunca se dibuja como imagen.
Sus 16.384 granos de escritorio, o 4.096 en móvil, circulan por carriles dentro
del grosor original a 48–80 px/s. Solo caen tras tocar el cursor. Los contactos
también emiten hasta 8.192 destellos en escritorio o 2.048 en móvil, con
vida de 0,45–1,65 segundos. Se conserva la referencia de
[Chris Wellons, A GPU Approach to Particle Physics](https://nullprogram.com/blog/2014/06/29/)
y [skeeto/webgl-particles](https://github.com/skeeto/webgl-particles), publicada
bajo dominio público / Unlicense. Las partículas interactúan con el cursor;
no se simulan choques entre granos ni acumulación volumétrica.

Marco y cortina comparten un cursor de 10 px CSS, detección continua para
movimientos rápidos y restitución de 0,76. La simulación usa pasos de 1/120 s
y un reloj a velocidad 0,8. Pausa, reinicio, cambios de tamaño y visibilidad de
la pestaña afectan a ambos sistemas. El scroll nativo se conserva en táctil.
La animación se detiene cuando el hero sale de pantalla. Si falta WebGL2 o
`EXT_color_buffer_float`, se pierde el contexto o se activa movimiento reducido,
se muestra la composición estática con `cortina-def.webp` y el mismo logo.

La GPU mantiene posiciones y velocidades en texturas RGBA32F alternadas.
Los shaders de vértices leen esas texturas directamente para dibujar los granos.
Un Web Worker prepara máscaras, tramos y buffers al cargar o cambiar de tamaño;
los envía a la GPU con buffers transferibles y conserva los píxeles decodificados
para los siguientes tamaños. Si faltan Worker u OffscreenCanvas, se usa el mismo
muestreo en el hilo principal. El motor WebGL se carga después de la primera
pintura; la imagen estática y el logo permiten ver el hero mientras se prepara.
El módulo de la cascada se carga después de play. La CPU no recorre partículas
ni lee datos GPU en cada fotograma. `gpu-sand.ts` coordina
el marco, la cortina y el glow; `gpu-curtain.ts` implementa la cascada;
`curtain-seeds.ts` construye sus emisores y tramos a partir del alfa original.
El bloom procesa la capa de partículas en HDR RGBA16F, con umbral 0,01,
escala 0,5 en escritorio o 0,35 en móvil, peso 2 y contraste 2. Su resolución
se limita a 1600 × 1000 y a un píxel de render por píxel CSS; el SVG del logo
conserva su resolución vectorial. Los destellos se calculan y dibujan solo
durante la interacción y hasta que termina su vida. Los dispositivos con
2 GB de RAM o 2 núcleos, o ahorro de datos, reciben la mitad del presupuesto.
Estas cantidades no garantizan FPS: el rendimiento depende del dispositivo.

Los tests de navegador verifican fuentes y colores, alineación del fondo,
flujo descendente, vueltas dentro de la máscara, gravedad, contacto y rebote,
colisiones continuas, partículas visibles fuera de la silueta, reciclado,
pausa y reinicio exacto. También comprueban el marco, el logo estático superior,
la contención de sus letras dentro de la cortina y la activación manual de play,
los tamaños de pantalla, táctil y los fallbacks. Los datos de diagnóstico se
exponen únicamente con `?sand-debug=1`; resultados en `artifacts/gpu-verification.json`.

La conversión se reproduce con `npm run assets` (Python + Pillow).
`fondo def.png` pasa a `fondo-def.webp` con calidad 88 y `cortina_def.png` a
`cortina-def.webp` sin pérdida. Se conservan dimensiones, colores visibles de
la cortina y alfa. El proceso comprueba estos datos y registra tamaños y pesos
en `public/assets/images/conversion.json`. Los SVG originales que contienen
PNG embebidos se convierten respetando su recorte, posición y opacidad.
El trazado del logo se reproduce con `scripts/trace-logo.mjs`; Potrace es
una herramienta de desarrollo aislada, sin dependencia en el cliente.

Esta fase cubre el hero. Email, chatbot, CRM y el resto de la landing siguen
pendientes de las siguientes fases.
