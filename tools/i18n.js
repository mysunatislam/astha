/* =====================================================================
   0a. Interface strings beyond the original dictionary
       tools/i18n.json keeps each English and Bangla string side by side.
       The build inlines it as I18N_EXTRA and tags the matching elements,
       failing when a tagged element or its English text has changed.
   ===================================================================== */
for (const [key, pair] of Object.entries(I18N_EXTRA)) { I18N.en[key] = pair[0]; I18N.bn[key] = pair[1]; }

// data-i18n replaces an element's whole content. A label that wraps its input, and text
// carried by an attribute, are translated in place by these hooks instead.
const I18N_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n-lead]').forEach(el => {
    const node = el.firstChild;
    if (node && node.nodeType === 3) node.nodeValue = t(el.getAttribute('data-i18n-lead'));
  });
  for (const attr of I18N_ATTRIBUTES) {
    document.querySelectorAll('[data-i18n-' + attr + ']').forEach(el => el.setAttribute(attr, t(el.getAttribute('data-i18n-' + attr))));
  }
  refreshStateLabels();
}

// Labels that show a current state are written by the code that changes that state, so a
// language switch has to redraw them from the state rather than from a fixed key.
function refreshStateLabels() {
  const put = (id, key) => { const el = $(id); if (el) el.textContent = t(key); };
  put('hf-label', typeof SiriVoice !== 'undefined' && SiriVoice.active ? 'hf_on' : 'hf_off');
  if (typeof privacyMode !== 'undefined') {
    put('private-btn', privacyMode ? 'privacy_on' : 'privacy_off');
    put('privacy-status', privacyMode ? 'privacy_status_on' : 'privacy_status_off');
  }
  if (typeof eye !== 'undefined') {
    put('eye-start', eye.active ? 'eye_stop' : 'eye_start');
    if (!eye.active) put('eye-pill', 'eye_idle');
  }
  if (typeof reader !== 'undefined') {
    if (reader.paused) put('reader-progress', 'reader_paused');
    else if (!reader.active) put('reader-progress', 'reader_ready');
  }
  if (typeof renderOwner === 'function') renderOwner();
  if (typeof updateSourceStatus === 'function') updateSourceStatus();
  if (typeof AsthaExperience !== 'undefined') AsthaExperience.refreshLabels();
  if (typeof AsthaPiCamera !== 'undefined') AsthaPiCamera.refreshLabels();
  if (typeof AsthaCameraKit !== 'undefined') AsthaCameraKit.render();
  if (typeof AsthaBraille !== 'undefined') AsthaBraille.refreshLabels();
  if (typeof AsthaScreenAccess !== 'undefined') AsthaScreenAccess.refreshLabels();
  if (typeof AsthaMessages !== 'undefined') AsthaMessages.refreshLabels();
  if (typeof AsthaDiagnosticsUI !== 'undefined') AsthaDiagnosticsUI.render();
  if (typeof AsthaVisionDetails !== 'undefined') AsthaVisionDetails.render(true);
  if (typeof window.ASTHA_RENDER_ACCOUNT === 'function') window.ASTHA_RENDER_ACCOUNT();
}
