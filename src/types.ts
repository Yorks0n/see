export type CanvasColor = '1' | '2' | '3' | '4' | '5' | '6' | `#${string}`

export type NodeSide = 'top' | 'right' | 'bottom' | 'left'
export type EdgeEnd = 'none' | 'arrow'
export type BackgroundStyle = 'cover' | 'ratio' | 'repeat' | 'center'

interface BaseNode {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  color?: CanvasColor
}

export interface TextNode extends BaseNode {
  type: 'text'
  text: string
}

export interface FileNode extends BaseNode {
  type: 'file'
  file: string
  subpath?: string
}

export interface LinkNode extends BaseNode {
  type: 'link'
  url: string
}

export interface ImageNode extends BaseNode {
  type: 'image'
  url: string
  text?: string
  naturalWidth?: number
  naturalHeight?: number
  crop?: { x: number; y: number; width: number; height: number }
}

export interface GroupNode extends BaseNode {
  type: 'group'
  layout?: 'list'
  minHeight?: number
  label?: string
  background?: string
  backgroundStyle?: BackgroundStyle
  memberIds?: string[]
}

export interface DrawPoint {
  x: number
  y: number
}

export interface DrawNode extends BaseNode {
  type: 'draw'
  points: DrawPoint[]
  strokeWidth?: number
}

export interface RectangleNode extends BaseNode {
  type: 'rectangle'
}

export type CanvasNode = TextNode | FileNode | LinkNode | ImageNode | GroupNode | DrawNode | RectangleNode

export interface CanvasEdge {
  id: string
  fromNode: string
  fromSide?: NodeSide
  fromEnd?: EdgeEnd
  toNode: string
  toSide?: NodeSide
  toEnd?: EdgeEnd
  color?: CanvasColor
  label?: string
  labelIsVisible?: boolean
  labelOffset?: { x: number; y: number }
  lineStyle?: 'curve' | 'straight'
}

export interface CanvasMeta {
  name?: string
  camera?: { x: number; y: number; zoom: number }
  app?: string
  appVersion?: string
}

export interface CanvasFile {
  nodes?: CanvasNode[]
  edges?: CanvasEdge[]
  meta?: CanvasMeta
}
