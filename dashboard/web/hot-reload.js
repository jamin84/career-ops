(() => {
  let hasConnected = false;
  let disconnected = false;
  const events = new EventSource("/api/reload");

  events.addEventListener("reload", () => window.location.reload());
  events.onopen = () => {
    if (hasConnected && disconnected) {
      window.location.reload();
      return;
    }
    hasConnected = true;
    disconnected = false;
  };
  events.onerror = () => {
    if (hasConnected) disconnected = true;
  };
})();
