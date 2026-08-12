// Executa antes da primeira pintura (script síncrono no <head>).
// Respeita prefers-color-scheme na primeira visita e persiste a escolha.
(function () {
  try {
    var salvo = localStorage.getItem("tema");
    var escuro = salvo ? salvo === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", escuro ? "dark" : "light");
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
