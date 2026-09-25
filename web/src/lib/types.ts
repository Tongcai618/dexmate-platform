// Shapes returned by the API (../server).

export type User = { id: string; name: string; email: string }

// ReBAC tuple: subject has `relation` on `object` (e.g. user:alice owner project:voice)
export type Relationship = { subject: string; relation: string; object: string }

export type Action = 'view' | 'label' | 'edit' | 'admin'
export type CheckResult = { allowed: boolean; path: string[] }

export type Token = {
  id: string
  name: string
  kind: 'personal' | 'service'
  scopes: string[]
  createdAt: string
  lastUsed: string | null
  revoked: boolean
}

// Returned once on create/rotate; the server only keeps a hash of `secret`.
export type NewToken = { token: Token; secret: string }

export type IngestEvent = {
  id: string
  ts: string
  source: 'app' | 'robot' | 'agent' | 'forum'
  type: string
  project: string
  consent: boolean
  piiScrubbed: boolean
  layer: 'bronze' | 'silver' | 'gold'
  payload: string
}

export type LabelItem = {
  id: string
  modality: 'vision' | 'nlp' | 'motion' | 'voice'
  project: string
  content: string
  options: string[]
  votes: Record<string, string> // labeler -> choice
  prelabel: string | null // model-in-the-loop suggestion
  canLabel: boolean
}

export type ModelVersion = {
  id: string
  family: 'llm' | 'voice' | 'motion'
  project: string
  version: number
  stage: 'training' | 'staging' | 'canary' | 'prod' | 'archived'
  dataset: string
  metric: number // eval accuracy on golden set
  safetyPass: boolean
  target: 'cloud' | 'edge'
  blocked: string | null // why the promotion gate is closed, if it is
  canEdit: boolean
}

export type Reply = { id: string; author: string; body: string; accepted: boolean; votes: number; voted: boolean }

export type Topic = {
  id: string
  category: string
  title: string
  author: string
  replies: Reply[]
}

export type OverviewStats = {
  events: number
  eventsToday: number
  pendingLabels: number
  inProd: number
  canary: number
  topics: number
}
