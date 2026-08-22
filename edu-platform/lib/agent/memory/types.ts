export type FactCategory =
  | "concept_mastery"
  | "concept_confusion"
  | "preference"
  | "difficulty"
  | "question"
  | "achievement";

export type FactSource = {
  session_id: string;
  message_id?: string;
  tool_call_id?: string;
  tool_name?: string;
};

export type Fact = {
  id: string;
  userId: string;
  sessionId: string;
  timestamp: Date;
  category: FactCategory;
  content: string;
  confidence: number;
  sourceJson: FactSource;
  metadata: Record<string, unknown>;
};

export type Concept = {
  id: string;
  userId: string;
  name: string;
  description: string;
  masteryLevel: number;
  lastUpdated: Date;
  supportingFactIds: string[];
  relatedConcepts: string[];
  metadata: Record<string, unknown>;
};

export type LearnerProfile = {
  id?: string;
  userId: string;
  profile: Record<string, unknown>;
  updatedAt?: Date;
};
