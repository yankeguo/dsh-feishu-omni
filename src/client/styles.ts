/** Plugin-owned settings styles. Every theme color comes from a --dsw-alias-* token. */

const STYLE_ATTRIBUTE = 'data-plugin-css'
const STYLE_KEY = 'feishu-omni'

export const styles = `
.dfo-page {
  box-sizing: border-box;
  display: grid;
  gap: 14px;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  padding: 4px 0 28px;
  color: var(--dsw-alias-label-primary, CanvasText);
  font: inherit;
}
.dfo-header { display: grid; gap: 5px; }
.dfo-title { margin: 0; color: var(--dsw-alias-label-primary, CanvasText); font-size: 20px; line-height: 28px; }
.dfo-description { margin: 0; color: var(--dsw-alias-label-secondary, GrayText); font-size: 13px; line-height: 20px; }
.dfo-card {
  display: grid;
  gap: 15px;
  padding: 18px;
  border: 1px solid var(--dsw-alias-border-l2, #dfe1e5);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, Canvas);
}
.dfo-card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dfo-card-heading h3 { margin: 0; color: var(--dsw-alias-label-primary, CanvasText); font-size: 15px; line-height: 22px; }
.dfo-card-heading p { margin: 4px 0 0; color: var(--dsw-alias-label-secondary, GrayText); font-size: 12px; line-height: 18px; }
.dfo-form { display: grid; gap: 15px; }
.dfo-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.dfo-field { display: grid; align-content: start; gap: 6px; min-width: 0; color: var(--dsw-alias-label-secondary, GrayText); font-size: 12px; line-height: 18px; }
.dfo-field-wide { grid-column: 1 / -1; }
.dfo-label { color: var(--dsw-alias-label-primary, CanvasText); font-weight: 600; }
.dfo-input, .dfo-select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 38px;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l2, #dfe1e5);
  border-radius: 8px;
  outline: none;
  color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-bg-layer-1, Canvas);
  font: inherit;
  font-size: 13px;
}
.dfo-input::placeholder { color: var(--dsw-alias-label-tertiary, GrayText); }
.dfo-input:focus-visible, .dfo-select:focus-visible, .dfo-button:focus-visible {
  border-color: var(--dsw-alias-state-business-primary, #3370ff);
  outline: 2px solid var(--dsw-alias-state-business-tertiary, rgba(51, 112, 255, 0.16));
  outline-offset: 1px;
}
.dfo-input:disabled, .dfo-select:disabled { color: var(--dsw-alias-label-tertiary, GrayText); background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); }
.dfo-hint { margin: 0; color: var(--dsw-alias-label-tertiary, GrayText); font-size: 11px; line-height: 17px; overflow-wrap: anywhere; }
.dfo-session-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.dfo-actions { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
.dfo-button {
  box-sizing: border-box;
  min-height: 34px;
  padding: 6px 13px;
  border: 1px solid var(--dsw-alias-border-l2, #dfe1e5);
  border-radius: 8px;
  color: var(--dsw-alias-label-primary, CanvasText);
  background: var(--dsw-alias-bg-layer-1, Canvas);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.dfo-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); border-color: var(--dsw-alias-border-l1, #c9cdd4); }
.dfo-button:disabled { color: var(--dsw-alias-label-tertiary, GrayText); cursor: not-allowed; opacity: 0.68; }
.dfo-button-primary { color: var(--dsw-alias-state-business-primary, #3370ff); border-color: var(--dsw-alias-state-business-primary, #3370ff); background: var(--dsw-alias-state-business-tertiary, rgba(51, 112, 255, 0.1)); }
.dfo-button-danger { color: var(--dsw-alias-state-error-primary, #d54941); }
.dfo-refresh { white-space: nowrap; }
.dfo-phase {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary, GrayText);
  background: var(--dsw-alias-bg-module-platform, #f2f3f5);
  font-size: 12px;
  white-space: nowrap;
}
.dfo-phase::before { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, GrayText); content: ''; }
.dfo-phase[data-phase='connected'] { color: var(--dsw-alias-state-success-primary, #20a162); }
.dfo-phase[data-phase='connected']::before { background: var(--dsw-alias-state-success-primary, #20a162); }
.dfo-phase[data-phase='connecting'] { color: var(--dsw-alias-state-business-primary, #3370ff); }
.dfo-phase[data-phase='connecting']::before { background: var(--dsw-alias-state-business-primary, #3370ff); }
.dfo-phase[data-phase='error'] { color: var(--dsw-alias-state-error-primary, #d54941); }
.dfo-phase[data-phase='error']::before { background: var(--dsw-alias-state-error-primary, #d54941); }
.dfo-status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; }
.dfo-status-item { min-width: 0; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform, #f2f3f5); }
.dfo-status-item dt { color: var(--dsw-alias-label-tertiary, GrayText); font-size: 11px; line-height: 17px; }
.dfo-status-item dd { margin: 3px 0 0; color: var(--dsw-alias-label-primary, CanvasText); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.dfo-loading, .dfo-empty { margin: 0; color: var(--dsw-alias-label-secondary, GrayText); font-size: 13px; line-height: 20px; }
.dfo-notice { margin: 0; padding: 10px 12px; border-radius: 8px; color: var(--dsw-alias-state-success-primary, #20a162); background: var(--dsw-alias-state-success-tertiary, rgba(32, 161, 98, 0.1)); font-size: 12px; line-height: 18px; }
.dfo-error { display: grid; gap: 5px; margin: 0; padding: 10px 12px; border-radius: 8px; color: var(--dsw-alias-state-error-primary, #d54941); background: var(--dsw-alias-state-error-secondary, #fff0ef); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dfo-error strong { font-weight: 600; }
.dfo-error code { color: var(--dsw-alias-label-secondary, GrayText); font-size: 11px; }
.dfo-error-time { color: var(--dsw-alias-label-tertiary, GrayText); font-size: 11px; }
@media (max-width: 620px) {
  .dfo-card { padding: 14px; }
  .dfo-fields, .dfo-status-grid { grid-template-columns: minmax(0, 1fr); }
  .dfo-field-wide { grid-column: auto; }
  .dfo-session-row { grid-template-columns: minmax(0, 1fr); }
  .dfo-refresh { width: 100%; }
}
`

interface StyleTagState {
  refs: number
  element: HTMLStyleElement | undefined
}

type StyleTagStore = Record<symbol, StyleTagState | undefined>
const STYLE_TAG_STATE = Symbol.for('@yankeguo/dsh-feishu-omni.style-tag')

function sharedState(): StyleTagState {
  const store = globalThis as unknown as StyleTagStore
  const existing = store[STYLE_TAG_STATE]
  if (existing !== undefined) return existing
  const created: StyleTagState = { refs: 0, element: undefined }
  store[STYLE_TAG_STATE] = created
  return created
}

/** Install one HMR-safe, reference-counted stylesheet and return its idempotent disposer. */
export function ensureStyleTag(): () => void {
  if (typeof document === 'undefined') return () => {}
  const state = sharedState()
  const known = state.element
  const element = known !== undefined && known.isConnected
    ? known
    : document.head.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}="${STYLE_KEY}"]`)
      ?? document.head.appendChild(document.createElement('style'))
  element.setAttribute(STYLE_ATTRIBUTE, STYLE_KEY)
  if (element.textContent !== styles) element.textContent = styles
  state.element = element
  state.refs += 1
  let released = false
  return () => {
    if (released) return
    released = true
    state.refs = Math.max(0, state.refs - 1)
    if (state.refs > 0) return
    element.remove()
    if (state.element === element) state.element = undefined
  }
}
