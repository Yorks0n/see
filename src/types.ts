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

export interface GroupNode extends BaseNode {
  type: 'group'
  label?: string
  background?: string
  backgroundStyle?: BackgroundStyle
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

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode | DrawNode

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
