// Enable/disable state for box-wide settings that only apply while another
// switch is on. Split out of settings.js; shared by the display, system and
// controls panels.
import { syncSettingDependencies } from '../ui/field.js';
import { crtEnabledEl, crtCurvatureSlider, crtFlickerSlider, crtGrainSlider, crtScanlinesSlider, crtVignetteSlider, guideOpenCloseAnimEnabledEl, guideAnimSpeedSlider, setupScreen, staticDurationSlider, staticEnabledEl, staticIntensitySlider } from '../core/dom.js';

function setDependentControlState(control, enabled) {
  if (!control) return;
  control.disabled = !enabled;
  const row = control.closest('.setting-row');
  if (row) row.classList.toggle('is-disabled', !enabled);
  else control.closest('label, .panel-interval')?.classList.toggle('control-disabled', !enabled);
}

export function refreshDependentControls() {
  setDependentControlState(guideAnimSpeedSlider, guideOpenCloseAnimEnabledEl.checked);
  setDependentControlState(staticIntensitySlider, staticEnabledEl.checked);
  setDependentControlState(staticDurationSlider, staticEnabledEl.checked);
  // With CRT switched off the sliders keep their values but do nothing, so
  // show them as unavailable rather than letting them look live.
  [crtScanlinesSlider, crtVignetteSlider, crtGrainSlider, crtFlickerSlider, crtCurvatureSlider]
    .forEach((slider) => setDependentControlState(slider, crtEnabledEl.checked));
  // Every other data-depends-on row (ui/field.js).
  syncSettingDependencies(setupScreen);
}
