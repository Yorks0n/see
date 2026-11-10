import type { CanvasColor } from '../types'

export const DEFAULT_CONNECTION_COLOR: CanvasColor = '5'
export const THEME_STORAGE_KEY = 'see-default-theme-color'
export const COLORS_STORAGE_KEY = 'see-default-colors'
interface DefaultColors { textColor?: CanvasColor; connectionColor: CanvasColor }
const colorValue = (value: unknown): CanvasColor | undefined => typeof value === 'string' && /^(?:[1-6]|#[\da-f]{6})$/i.test(value)
  ? (['#39cbd4', '#609fbb'].includes(value.toLowerCase()) ? DEFAULT_CONNECTION_COLOR : value as CanvasColor) : undefined

export class PreferencesStore {
  private colors: DefaultColors = { connectionColor: DEFAULT_CONNECTION_COLOR }
  private listeners = new Set<() => void>()

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(COLORS_STORAGE_KEY) ?? 'null')
      const legacy = colorValue(localStorage.getItem(THEME_STORAGE_KEY))
      this.colors = {
        textColor: colorValue(saved?.textColor),
        connectionColor: colorValue(saved?.connectionColor) ?? legacy ?? DEFAULT_CONNECTION_COLOR,
      }
    } catch {}
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = () => this.colors
  private set(patch: Partial<DefaultColors>) {
    this.colors = { ...this.colors, ...patch }
    try { localStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify(this.colors)) } catch {}
    this.listeners.forEach((listener) => listener())
  }
  setTextColor = (textColor?: CanvasColor) => this.set({ textColor })
  setConnectionColor = (connectionColor: CanvasColor) => this.set({ connectionColor })
}

export const preferencesStore = new PreferencesStore()
