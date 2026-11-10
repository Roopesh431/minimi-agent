
import db from "../database/database";
import { randomUUID } from "node:crypto";

interface ExtractedFact {
  factType: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

interface ExtractionResult {
  processedMessages: number;
  extractedFacts: number;
  skippedMessages: number;
}

function normalizeEntity(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function extractShortlistFacts(content: string): ExtractedFact[] {
  const match = content.match(
    /\bshortlisted\s+(.+?)(?:\s+for\s+(.+?))?[.!?]?$/i
  );

  if (!match) {
    return [];
  }

  const entityText = match[1].trim();
  const context = normalizeEntity(match[2] || "");

  // Split names separated by commas or "and".
  const entities = entityText
    .replace(/\s+and\s+/gi, ",")
    .split(",")
    .map(normalizeEntity)
    .filter(Boolean);

  // Avoid treating an entire sentence as one entity.
  if (entities.length < 2 || entities.length > 10) {
    return [];
  }

  return entities.map(entity => ({
    factType: "shortlist",
    subject: entity,
    predicate: "shortlisted",
    object: context,
    confidence: 0.95
  }));
}

function extractDecisionFacts(content: string): ExtractedFact[] {
  const patterns = [
    /\b(?:we|i)\s+(?:decided to use|selected|chose)\s+([^.!?]+)[.!?]?$/i,
    /\b(?:our|my)\s+(?:final choice|decision)\s+(?:is|was)\s+([^.!?]+)[.!?]?$/i
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);

    if (match) {
      const subject = normalizeEntity(match[1]);

      if (subject.length > 0 && subject.length <= 150) {
        return [{
          factType: "decision",
          subject,
          predicate: "selected",
          object: "",
          confidence: 0.9
        }];
      }
    }
  }

  return [];
}

function extractFacts(content: string): ExtractedFact[] {
  return [
    ...extractShortlistFacts(content),
    ...extractDecisionFacts(content)
  ];
}

export function extractConversationFacts(
  conversationId: string
): ExtractionResult {
  const messages = db.prepare(`
    SELECT id, content
    FROM messages
    WHERE conversation_id = ?
      AND role = 'user'
    ORDER BY created_at ASC
  `).all(conversationId) as {
    id: string;
    content: string;
  }[];

  const insertFact = db.prepare(`
    INSERT OR IGNORE INTO memory_facts (
      id,
      conversation_id,
      source_message_id,
      fact_type,
      subject,
      predicate,
      object,
      confidence,
      extraction_method
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let extractedFacts = 0;
  let skippedMessages = 0;

  const process = db.transaction(() => {
    for (const message of messages) {
      const facts = extractFacts(message.content);

      if (facts.length === 0) {
        skippedMessages++;
        continue;
      }

      for (const fact of facts) {
        const result = insertFact.run(
          randomUUID(),
          conversationId,
          message.id,
          fact.factType,
          fact.subject,
          fact.predicate,
          fact.object,
          fact.confidence,
          "rule-based"
        );

        extractedFacts += result.changes;
      }
    }
  });

  process();

  return {
    processedMessages: messages.length,
    extractedFacts,
    skippedMessages
  };
}
