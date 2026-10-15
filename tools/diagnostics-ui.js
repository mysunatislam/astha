// Optional helper view. Timings stay in memory; opening it never starts a camera/model.
const AsthaDiagnosticsUI = (() => {
  const rows = { perception: 'debug-perception', reasoning: 'debug-reasoning', speech: 'debug-speech' };
  function render() {
    const snapshot = AsthaDiagnostics.snapshot();
    for (const [stage, id] of Object.entries(rows)) {
      const node = $(id); if (!node) continue;
      const value = snapshot.stages[stage];
      node.textContent = !value ? t('debug_unmeasured') : value.status === 'running' ? t('debug_running')
        : value.status === 'cancel' ? t('debug_cancelled') : value.status === 'error' ? t('debug_failed')
        : t('debug_ms', { ms: Math.round(value.durationMs) });
    }
  }
  function toggle() {
    AsthaDiagnostics.setSourceEpoch(state.sourceEpoch || 0);
    AsthaDiagnostics.setEnabled(Boolean($('vision-debug')?.open) && !document.hidden);
    render();
  }
  function clear() {
    if ($('vision-debug')) $('vision-debug').open = false;
    AsthaDiagnostics.setEnabled(false); AsthaDiagnostics.reset();
  }
  function boot() {
    $('vision-debug')?.addEventListener('toggle', toggle);
    document.addEventListener('visibilitychange', toggle);
    AsthaDiagnostics.subscribe(render);
    toggle();
  }
  return { boot, render, clear };
})();
