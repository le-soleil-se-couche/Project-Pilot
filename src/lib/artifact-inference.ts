import { createHash } from 'crypto';
import type { Artifact, ArtifactKind } from '@/types';

export const ARTIFACT_INFERENCE_VERSION = 'stage-a-rule-v1';

const SIGNALS: Record<ArtifactKind, string[]> = {
  idea: ['想法', '灵感', '建议', '点子', '可以做', '要不要', 'if we', 'idea'],
  decision: ['决定', '拍板', '定了', '选择', '采用', '结论', 'decision'],
  hypothesis: ['假设', '也许', '可能', '猜测', '待验证', '实验', 'hypothesis'],
  gene: ['模板', '复用', '模式', '策略', '规则', '经验', 'gene'],
};

export interface InferenceResult {
  kind: ArtifactKind;
  confidence: 'high' | 'medium' | 'low';
  signals: string[];
}

export interface GeneRecommendationItem {
  artifactId: string;
  title: string;
  score: number;
  reason: string;
}

export function hashString(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function inferArtifactKind(content: string): InferenceResult {
  const lower = content.toLowerCase();
  let bestKind: ArtifactKind = 'idea';
  let bestSignals: string[] = [];

  for (const [kind, words] of Object.entries(SIGNALS) as Array<[ArtifactKind, string[]]>) {
    const matched = words.filter(word => lower.includes(word.toLowerCase()));
    if (matched.length > bestSignals.length) {
      bestKind = kind;
      bestSignals = matched;
    }
  }

  const confidence = bestSignals.length >= 3 ? 'high' : bestSignals.length >= 1 ? 'medium' : 'low';
  return { kind: bestKind, confidence, signals: bestSignals };
}

export function recommendGenes(content: string, artifacts: Artifact[], limit = 3): GeneRecommendationItem[] {
  const lower = content.toLowerCase();

  const ranked = artifacts
    .filter(item => item.kind === 'gene' && item.gene)
    .map(item => {
      const keywords = item.gene?.matchRules.contextKeywords ?? [];
      const patterns = item.gene?.matchRules.taskPatterns ?? [];
      const matchedKeywords = keywords.filter(word => lower.includes(word.toLowerCase()));
      const matchedPatterns = patterns.filter(word => lower.includes(word.toLowerCase()));
      const hits = matchedKeywords.length + matchedPatterns.length;
      const total = Math.max(1, keywords.length + patterns.length);
      const score = hits / total;

      const reasonParts: string[] = [];
      if (matchedKeywords.length > 0) reasonParts.push(`命中关键词 ${matchedKeywords.slice(0, 3).join('、')}`);
      if (matchedPatterns.length > 0) reasonParts.push(`命中任务模式 ${matchedPatterns.slice(0, 3).join('、')}`);

      return {
        artifactId: item.id,
        title: item.title,
        score,
        reason: reasonParts.join('；') || '与当前内容语义相近',
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, limit);
}
