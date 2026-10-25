// Menú accesible: el estado visual y el anunciado al lector de pantalla coinciden.
const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#main-nav");

function setMenu(open) {
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute(
    "aria-label",
    open ? "Cerrar menú de navegación" : "Abrir menú de navegación",
  );
  navigation.dataset.open = String(open);
}

menuButton.addEventListener("click", () =>
  setMenu(menuButton.getAttribute("aria-expanded") !== "true"),
);
navigation
  .querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", () => setMenu(false)));
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    menuButton.getAttribute("aria-expanded") === "true"
  ) {
    setMenu(false);
    menuButton.focus();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".site-header")) setMenu(false);
});
window.matchMedia("(min-width: 901px)").addEventListener("change", (event) => {
  if (event.matches) setMenu(false);
});

// Un solo servicio abierto a la vez. Sin JavaScript, los tres siguen funcionando.
const services = [...document.querySelectorAll(".service")];
services.forEach((service) =>
  service.addEventListener("toggle", () => {
    if (service.open)
      services.forEach((other) => {
        if (other !== service) other.open = false;
      });
  }),
);

document.querySelector("#year").textContent = new Date().getFullYear();
