# Levante Digital — web de redes sociales

Recreación de la estructura visual de [The Luft Agency](https://theluftagency.com/), adaptada a Levante Digital: logo, fotografía de portada, naranja y azul marino, textos existentes y espacios reservados para el material pendiente.

La sección «Sobre nosotros» usa una composición editorial de texto, sin fotografías personales ni de equipo, y no necesita ningún asset fotográfico.

## Abrir la web

Abre `index.html` en tu navegador. No necesita instalación ni compilación. También puedes ejecutar `python -m http.server 8765 --bind 127.0.0.1` desde esta carpeta y visitar `http://127.0.0.1:8765`.

## Archivos

- `index.html`: textos, secciones, enlaces y marcadores de imágenes pendientes.
- `styles.css`: colores, tipografías, posiciones y adaptación a móvil.
- `script.js`: menú móvil, acordeones de servicios y año del pie.
- `assets/`: logos y fotografía originales de Levante.
- `assets/fonts/`: Manrope y Noto Serif Display locales, con sus licencias OFL. La web no solicita fuentes a terceros.
- `ASSETS-PENDIENTES.md`: lista de fotos, proyectos y datos que faltan.

La versión anterior a esta recreación se conserva en `../_backups/antes-recreacion-luft/` respecto a esta carpeta.

## Ajustes habituales

Los colores están en `:root`, al principio de `styles.css`. La composición del hero se controla desde `.hero`, `.hero-picture img` y `.hero-content`. Los ajustes de móvil están al final, dentro de `@media (max-width: 640px)`.

Cada marcador de imagen tiene un atributo `data-placeholder` en HTML. Al recibir la imagen, sustituye el contenido de ese bloque por un `<img>` con un texto alternativo descriptivo, conserva la clase de la sección y retira los textos de «pendiente». Usa `object-fit: cover` para llenar el espacio y ajusta `object-position` para elegir el encuadre. Los logos y fotos de partida no se han modificado.

Los servicios usan `<details>` y `<summary>`: funcionan con ratón y teclado, incluso sin JavaScript. El menú admite Escape y se cierra al seguir un enlace.

## Contenido pendiente de publicación

Los clientes, proyectos y testimonios están identificados como marcadores; no son referencias reales. El bloque de contacto espera el formulario o canal oficial. No hay envío simulado ni datos de contacto inventados. Antes de publicar, completar esos contenidos y añadir los datos legales, el dominio canónico y la configuración Open Graph del sitio definitivo.

## Verificación

Revisión en navegador de escritorio, tableta y móvil: carga local de imágenes y fuentes, enlaces internos, menú accesible, acordeones y ausencia de desplazamiento horizontal. JavaScript comprobado con `node --check script.js`.
