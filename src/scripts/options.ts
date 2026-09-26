(function initOptions() {
  "use strict";

  const themeApi = window.JsonFormatterTheme;
  const connection = themeApi.connect(document.documentElement);
  const themeInputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="theme"]')
  );
  const status = document.getElementById("settings-status") as HTMLSpanElement;
  let statusTimer: number | undefined;

  function selectPreference(preference: ThemePreference): void {
    themeInputs.forEach((input) => {
      input.checked = input.value === preference;
    });
  }

  function showStatus(message: string): void {
    window.clearTimeout(statusTimer);
    status.textContent = message;
    statusTimer = window.setTimeout(() => {
      status.textContent = "";
    }, 1800);
  }

  connection.ready.then(selectPreference);

  themeInputs.forEach((input) => {
    input.addEventListener("change", async () => {
      if (!input.checked) {
        return;
      }
      const preference = input.value as ThemePreference;
      connection.apply(preference);
      try {
        await themeApi.setPreference(preference);
        showStatus("Theme saved");
      } catch (_error) {
        showStatus("Could not save theme");
      }
    });
  });
})();
